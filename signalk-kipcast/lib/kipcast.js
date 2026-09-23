'use strict';
/*
 * KIPCast core
 *
 * One headless Chromium ("session") per display id, each with its own profile,
 * so every display keeps its own KIP login and settings. Each runs KIP at the
 * resolution its display reports and streams JPEG frames via the Chrome
 * DevTools Protocol screencast. Touches from the display are injected back as
 * real touch events, so KIP's own swipe/tap handling just works.
 *
 * Transports:
 *   TCP  (default :3051)  - for ESP32 displays. Line-based text upstream,
 *                           length-prefixed JPEG downstream.
 *   HTTP/WS (default :3050) - browser test viewer at /, WebSocket at /ws?id=...,
 *                           known displays (read-only JSON) at /displays
 *
 * Each display's size is remembered in displaysFile, so the viewer opens a
 * display at the right size even while the screen itself is off.
 *
 * Upstream line protocol (same for TCP and WS):
 *   H <id> <width> <height>   hello (TCP only; WS uses ?id=)
 *   A                         ready for next frame (flow control)
 *   T <D|M|U> <x> <y>         touch down / move / up, in display pixels
 *   I <text>                  type text; <text> is encodeURIComponent()-encoded
 *   K <key> [modifiers]       press one key, e.g. Enter, Backspace, Tab, ArrowLeft,
 *                             or a single character with modifiers (Ctrl+A).
 *                             modifiers: CDP bitmask, Alt=1 Ctrl=2 Meta=4 Shift=8
 *   P                         keepalive, ignored
 *
 * Downstream (TCP): 'K' 'C' 'F' + uint32 big-endian length + JPEG bytes.
 * Downstream (WS):  one binary message per JPEG.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer-core');

const DEFAULTS = {
  url: 'http://localhost:3000/@mxtommy/kip/',
  width: 800,                // used when a display doesn't report its size
  height: 480,
  jpegQuality: 70,
  maxFps: 8,                 // cap on frames Chromium encodes per tab
  httpPort: 3050,
  tcpPort: 3051,
  inputMode: 'touch',        // 'touch' or 'mouse'
  chromiumPath: null,        // auto-detect if null
  profilesDir: path.join(__dirname, '..', 'chrome-profiles'),  // one subfolder per display id
  seedProfileDir: path.join(__dirname, '..', 'chrome-profile'), // copied into new display profiles
  displaysFile: path.join(__dirname, '..', 'displays.json'),     // remembered display sizes
  idleCloseSec: 300,         // close a display's Chromium this long after it leaves
};

// Caches aren't worth copying when seeding a new display's profile, and the
// Singleton* files would make Chromium think the profile is already in use.
const SEED_SKIP = /^(Singleton.*|.*Cache|Crashpad|component_crx_cache)$/;

const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/lib/chromium/chromium',
  '/usr/bin/google-chrome',
];

function findChromium() {
  const found = CHROMIUM_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chromium not found. Install it (sudo apt install chromium) or set chromiumPath.');
  return found;
}

/* ------------------------------------------------------------------ */
/* A connected display (ESP32 over TCP, or browser over WS)            */
/* ------------------------------------------------------------------ */
class Client {
  // kind: 'screen' for an ESP32 display, 'viewer' for the browser test viewer.
  constructor(label, kind, sendFrame, closeFn) {
    this.label = label;
    this.kind = kind;
    this.sendFrame = sendFrame;
    this.closeFn = closeFn;
    this.session = null;
    this.ready = true;       // may we send a frame?
    this.sentSeq = -1;       // seq of last frame sent
    this.watchdog = null;
    this.closed = false;     // connection gone; don't attach to a session
  }

  close() {
    if (this.closeFn) this.closeFn();
  }

  // Send the session's latest frame if the client is ready and hasn't seen it.
  offer() {
    const s = this.session;
    if (!s || !this.ready || !s.lastFrame || s.frameSeq === this.sentSeq) return;
    this.ready = false;
    this.sentSeq = s.frameSeq;
    this.sendFrame(s.lastFrame);
    // If the display never acks (dropped message, crash), don't stall forever.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { this.ready = true; this.offer(); }, 5000);
  }

  ack() {
    clearTimeout(this.watchdog);
    this.ready = true;
    this.offer();
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.watchdog);
    if (this.session) this.session.removeClient(this);
    this.session = null;
  }
}

/* ------------------------------------------------------------------ */
/* One Chromium per display id                                         */
/* ------------------------------------------------------------------ */
class Session {
  constructor(cast, id, width, height) {
    this.cast = cast;
    this.id = id;
    this.width = width;
    this.height = height;
    this.clients = new Set();
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.lastFrame = null;
    this.frameSeq = 0;
    this.lastAckAt = 0;
    this.inputChain = Promise.resolve();
    this.idleTimer = null;
    this.pointerDown = false;
    this.closing = false;
  }

  async start() {
    const { opts, log } = this.cast;
    const browser = await this.cast.launchBrowser(this.id);
    this.browser = browser;
    browser.on('disconnected', () => {
      if (this.closing) return;
      log(`[${this.id}] Chromium exited; display will reconnect`);
      for (const c of this.clients) c.close();
      this.close();
    });
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setViewport({
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      hasTouch: opts.inputMode === 'touch',
      isMobile: false,
    });
    const cdp = await page.createCDPSession();

    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      this.lastFrame = Buffer.from(data, 'base64');
      this.frameSeq++;
      for (const c of this.clients) c.offer();
      // Pace Chromium by delaying acks. It keeps up to two frames in flight,
      // so space the acks themselves, or both go out together and double the rate.
      const ackAt = Math.max(Date.now(), this.lastAckAt + 1000 / opts.maxFps);
      this.lastAckAt = ackAt;
      setTimeout(() => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      }, ackAt - Date.now());
    });

    // A crashed tab stops sending frames; close it and drop its displays so
    // they reconnect and get a fresh tab.
    page.on('error', (e) => {
      log(`[${this.id}] page crashed: ${e.message}`);
      for (const c of this.clients) c.close();
      this.close();
    });
    page.on('close', () => { if (this.cast.sessions.get(this.id) === this) this.cast.sessions.delete(this.id); });

    log(`[${this.id}] opening ${opts.url} at ${this.width}x${this.height}`);
    try {
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: opts.jpegQuality,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1,
      });
    } catch (e) {
      this.closing = true;
      await browser.close().catch(() => {}); // don't leak a Chromium per failed attempt
      throw e;
    }
    this.page = page;
    this.cdp = cdp;
  }

  addClient(c) {
    clearTimeout(this.idleTimer);
    c.session = this;
    this.clients.add(c);
    c.offer(); // show the current frame straight away, even if the page is idle
  }

  removeClient(c) {
    this.clients.delete(c);
    if (this.clients.size === 0 && !this.closing) {
      this.idleTimer = setTimeout(() => this.close(), this.cast.opts.idleCloseSec * 1000);
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.idleTimer);
    if (this.cast.sessions.get(this.id) === this) this.cast.sessions.delete(this.id);
    try { if (this.cdp) await this.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { if (this.browser) await this.browser.close(); } catch { /* ignore */ }
    this.cast.log(`[${this.id}] closed`);
    this.cast.updateStatus();
  }

  // Queue input so events always reach Chromium in order.
  queue(fn) {
    this.inputChain = this.inputChain
      .then(() => (this.cdp ? fn(this.cdp) : undefined))
      .catch((e) => this.cast.log(`[${this.id}] input error: ${e.message}`));
  }

  input(kind, x, y) { this.queue(() => this.dispatch(kind, x, y)); }

  // Typed text goes in as an IME-style insert: fires the input events that
  // Angular forms (KIP's login) listen for, and copes with any character.
  text(str) { this.queue((cdp) => cdp.send('Input.insertText', { text: str })); }

  key(name, modifiers) {
    const k = keyInfo(name);
    if (!k) return;
    this.queue(async (cdp) => {
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers };
      // Enter needs text on keyDown to submit forms; other keys are rawKeyDown.
      if (k.text && !(modifiers & 7)) await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: k.text });
      else await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    });
  }

  async dispatch(kind, x, y) {
    if (!this.cdp) return;
    const { inputMode } = this.cast.opts;
    x = Math.max(0, Math.min(this.width - 1, x));
    y = Math.max(0, Math.min(this.height - 1, y));

    if (inputMode === 'mouse') {
      const type = { D: 'mousePressed', M: 'mouseMoved', U: 'mouseReleased' }[kind];
      await this.cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons: kind === 'U' ? 0 : 1, clickCount: 1,
      });
      return;
    }

    if (kind === 'D') this.pointerDown = true;
    if (kind === 'M' && !this.pointerDown) return; // stray move with no finger down
    const type = { D: 'touchStart', M: 'touchMove', U: 'touchEnd' }[kind];
    const touchPoints = kind === 'U' ? [] : [{ x, y, id: 0, radiusX: 4, radiusY: 4, force: 1 }];
    if (kind === 'U') this.pointerDown = false;
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  }
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */
class KIPCast {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== '')) };
    this.log = options.log || ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.status = options.status || (() => {});
    this.error = options.error || this.log;
    this.sessions = new Map();         // id -> Session
    this.sessionStarting = new Map();  // id -> Promise<Session>
    this.httpServer = null;
    this.wss = null;
    this.tcpServer = null;
    this.sockets = new Set();
    this.displays = new Map();         // id -> { width, height, source, lastSeen }
    this.saveTimer = null;
    this.stopping = false;             // no new Chromiums once stop() has begun
    this.loadDisplays();
  }

  /* ---- Known displays, remembered across restarts ---- */

  loadDisplays() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.opts.displaysFile, 'utf8'));
      for (const [id, d] of Object.entries(saved)) {
        if (validSize(d.width) && validSize(d.height)) this.displays.set(sanitiseId(id), d);
      }
    } catch { /* first run, or unreadable: start empty */ }
  }

  saveDisplays() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const file = this.opts.displaysFile;
      const tmp = `${file}.tmp`;
      fs.promises.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(this.displays), null, 2)))
        .then(() => fs.promises.rename(tmp, file))
        .catch((e) => this.log(`could not save ${file}: ${e.message}`));
    }, 500);
  }

  // source: 'screen' (reported by the ESP32 itself), 'manual' (added on the
  // Displays page) or 'viewer' (first opened in the viewer with ?w=&h=).
  rememberDisplay(id, width, height, source) {
    this.displays.set(id, { width, height, source, lastSeen: new Date().toISOString() });
    this.saveDisplays();
  }

  touchDisplay(id) {
    const d = this.displays.get(id);
    if (!d) return;
    d.lastSeen = new Date().toISOString();
    this.saveDisplays();
  }

  // Every known or open display, for the Displays page and the viewer.
  listDisplays() {
    const ids = new Set([...this.displays.keys(), ...this.sessions.keys()]);
    return [...ids].sort().map((id) => {
      const d = this.displays.get(id) || {};
      const s = this.sessions.get(id);
      const clients = s ? [...s.clients] : [];
      return {
        id,
        width: s ? s.width : d.width,
        height: s ? s.height : d.height,
        source: d.source || 'viewer',
        lastSeen: d.lastSeen || null,
        open: !!s,
        screens: clients.filter((c) => c.kind === 'screen').length,
        viewers: clients.filter((c) => c.kind === 'viewer').length,
      };
    });
  }

  addDisplay(rawId, width, height) {
    const id = sanitiseId(rawId);
    if (!rawId || id !== String(rawId)) throw new Error('Display id may only use letters, digits, - and _ (up to 32)');
    if (!validSize(width) || !validSize(height)) throw new Error('Width and height must be between 64 and 4096');
    this.rememberDisplay(id, Math.round(width), Math.round(height), 'manual');
    return id;
  }

  forgetDisplay(id) {
    this.displays.delete(id);
    this.saveDisplays();
    const s = this.sessions.get(id);
    if (s && s.clients.size === 0) s.close();
  }

  // Size for a display that has just said hello: what it reports, else what
  // we remember for its id, else the configured default.
  sizeFor(id, client, reportedW, reportedH) {
    const known = this.displays.get(id);
    if (reportedW && reportedH) {
      // An ESP32 is the authority on its own size. The viewer only records a
      // size for an id we've never seen.
      if (client.kind === 'screen') this.rememberDisplay(id, reportedW, reportedH, 'screen');
      else if (!known) this.rememberDisplay(id, reportedW, reportedH, 'viewer');
      return [reportedW, reportedH];
    }
    if (known) return [known.width, known.height];
    return [this.opts.width, this.opts.height];
  }

  // Each display gets its own Chromium and profile, so its KIP login and
  // settings are its own. A new display's profile starts as a copy of the
  // seed profile (the single shared one older versions used), so it opens
  // already logged in with the existing dashboards.
  async launchBrowser(id) {
    const userDataDir = path.join(this.opts.profilesDir, id);
    const seed = this.opts.seedProfileDir;
    if (!fs.existsSync(userDataDir) && seed && fs.existsSync(seed)) {
      this.log(`[${id}] new profile, copying settings from ${seed}`);
      await fs.promises.cp(seed, userDataDir, {
        recursive: true,
        filter: (src) => !SEED_SKIP.test(path.basename(src)),
      });
    }
    const executablePath = this.opts.chromiumPath || findChromium();
    const args = [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Trim background services; each display runs its own Chromium.
      '--disable-extensions',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--renderer-process-limit=1',
    ];
    if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    this.log(`[${id}] launching ${executablePath}`);
    return puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir, // keeps this display's KIP settings/login between restarts
      args,
      defaultViewport: null,
      // Puppeteer's own SIGTERM/SIGHUP handler closes Chromium but doesn't
      // exit, and its mere presence stops Node exiting on the signal, so
      // Signal K would hang until systemd kills it. The host owns signals.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  }

  async getSession(id, width, height) {
    if (this.stopping) throw new Error('KIPCast is stopping');
    if (this.sessions.has(id)) return this.sessions.get(id);
    if (this.sessionStarting.has(id)) return this.sessionStarting.get(id);
    const p = (async () => {
      const s = new Session(this, id, width, height);
      await s.start();
      this.sessions.set(id, s);
      return s;
    })();
    this.sessionStarting.set(id, p);
    try { return await p; } finally { this.sessionStarting.delete(id); }
  }

  // Shared handler for one upstream protocol line.
  async handleLine(client, line, conn) {
    const parts = line.trim().split(/\s+/);
    switch (parts[0]) {
      case 'H': {
        const id = sanitiseId(parts[1]);
        const [w, h] = this.sizeFor(id, client, validSize(parts[2]), validSize(parts[3]));
        if (client.session) client.dispose();
        let s;
        try {
          s = await this.getSession(id, w, h);
          // A screen arriving at a page opened at another size (say, by the
          // viewer before this id's size was known) gets the page reopened at
          // its own size, unless another screen is already using it.
          if ((s.width !== w || s.height !== h) && client.kind === 'screen'
              && ![...s.clients].some((c) => c.kind === 'screen')) {
            this.log(`[${id}] reopening at ${w}x${h} (was ${s.width}x${s.height})`);
            for (const c of s.clients) c.close();
            await s.close();
            s = await this.getSession(id, w, h);
          }
        } catch (e) {
          // Drop the connection so the display retries (and re-sends H) later,
          // rather than sitting connected with no tab behind it.
          this.log(`[${id}] could not open dashboard: ${e.message}`);
          client.close();
          return;
        }
        if (client.closed) return; // left while the tab was opening
        // Screens sharing an id share one page, drawn at the first one's size.
        if (s.width !== w || s.height !== h) {
          this.log(`[${id}] warning: display is ${w}x${h}, but "${id}" is already open at ${s.width}x${s.height}`);
        }
        s.addClient(client);
        this.log(`[${id}] display connected (${conn})`);
        this.updateStatus();
        break;
      }
      case 'A': client.ack(); break;
      case 'I': {
        if (!client.session || !parts[1]) break;
        let str;
        try { str = decodeURIComponent(parts[1]); } catch { break; }
        client.session.text(str.slice(0, 1000));
        break;
      }
      case 'K': {
        if (client.session) client.session.key(parts[1], (+parts[2] || 0) & 15);
        break;
      }
      case 'T': {
        if (!client.session) break;
        const kind = parts[1];
        if (!['D', 'M', 'U'].includes(kind)) break;
        client.session.input(kind, +parts[2] || 0, +parts[3] || 0);
        break;
      }
      default: break; // 'P' keepalive and anything unknown
    }
  }

  // e.g. "Connected: helm 480×480, shedtest 800×480 (1 viewer)"
  updateStatus() {
    const screens = [];
    let viewers = 0;
    for (const s of this.sessions.values()) {
      const kinds = [...s.clients].map((c) => c.kind);
      if (kinds.includes('screen')) screens.push(`${s.id} ${s.width}×${s.height}`);
      viewers += kinds.filter((k) => k === 'viewer').length;
    }
    const v = viewers ? ` (${viewers} viewer${viewers > 1 ? 's' : ''})` : '';
    this.status(screens.length ? `Connected: ${screens.sort().join(', ')}${v}` : `No displays connected${v}`);
  }

  startTcp() {
    this.tcpServer = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 10000);
      const peer = `${sock.remoteAddress}:${sock.remotePort}`;
      const client = new Client(peer, 'screen', (jpeg) => {
        const hdr = Buffer.alloc(7);
        hdr.write('KCF', 0, 'ascii');
        hdr.writeUInt32BE(jpeg.length, 3);
        sock.write(hdr);
        sock.write(jpeg);
      }, () => sock.destroy());
      let buf = '';
      let chain = Promise.resolve();
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.length > 4096) buf = ''; // garbage guard
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          chain = chain.then(() => this.handleLine(client, line, `tcp ${peer}`))
            .catch((e) => this.log(`tcp ${peer}: ${e.message}`));
        }
      });
      const done = () => {
        this.sockets.delete(sock);
        if (client.session) this.touchDisplay(client.session.id);
        client.dispose();
        this.updateStatus();
      };
      sock.on('close', done);
      sock.on('error', () => {});
    });
    this.tcpServer.on('error', (e) => this.error(`tcp port ${this.opts.tcpPort}: ${e.message}`));
    this.tcpServer.listen(this.opts.tcpPort, () => this.log(`ESP32 displays: tcp port ${this.opts.tcpPort}`));
  }

  startHttp() {
    const viewer = path.join(__dirname, '..', 'public', 'viewer.html');
    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(viewer).pipe(res);
      } else if (req.url === '/displays' && req.method === 'GET') {
        // Read-only here: this port has no login. Changes go through Signal K.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.listDisplays()));
      } else {
        res.writeHead(404).end();
      }
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const id = sanitiseId(q.get('id') || 'viewer');
      const client = new Client(`ws ${id}`, 'viewer', (jpeg) => ws.send(jpeg, { binary: true }), () => ws.terminate());
      // Without ?w=&h= the viewer gets the display's remembered size.
      let chain = this.handleLine(client, `H ${id} ${q.get('w') || 0} ${q.get('h') || 0}`, 'browser')
        .catch((e) => { this.log(`ws: ${e.message}`); ws.close(); });
      ws.on('error', () => {});
      ws.on('message', (m, isBinary) => {
        if (isBinary) return;
        chain = chain.then(() => this.handleLine(client, m.toString(), 'browser')).catch(() => {});
      });
      ws.on('close', () => { client.dispose(); this.updateStatus(); });
    });
    // Without these, EADDRINUSE would be an uncaught exception in Signal K.
    this.httpServer.on('error', (e) => this.error(`http port ${this.opts.httpPort}: ${e.message}`));
    this.wss.on('error', () => {}); // re-emitted from httpServer, handled above
    this.httpServer.listen(this.opts.httpPort, () => this.log(`browser viewer: http://<pi>:${this.opts.httpPort}/`));
  }

  async start() {
    if (!this.opts.chromiumPath) findChromium(); // fail early if Chromium is missing
    this.startTcp();
    this.startHttp();
    this.updateStatus();
  }

  async stop() {
    this.stopping = true;
    for (const s of this.sockets) s.destroy();
    if (this.wss) {
      // wss.close() leaves open connections alone, which would keep
      // httpServer.close() waiting forever.
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
    }
    await new Promise((r) => (this.tcpServer ? this.tcpServer.close(() => r()) : r()));
    await new Promise((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      try { fs.writeFileSync(this.opts.displaysFile, JSON.stringify(Object.fromEntries(this.displays), null, 2)); } catch { /* ignore */ }
    }
  }
}

const NAMED_KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Escape: [27, 'Escape'],
  Delete: [46, 'Delete'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'],
};

// CDP key event fields for a named key or a single ASCII letter/digit.
function keyInfo(name) {
  if (NAMED_KEYS[name]) {
    const [vk, code, text] = NAMED_KEYS[name];
    return { key: name, code, vk, text };
  }
  if (/^[A-Za-z]$/.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0) };
  return null;
}

// A reported screen dimension, or 0 if missing or implausible.
function validSize(v) {
  const n = Math.round(+v);
  return n >= 64 && n <= 4096 ? n : 0;
}

function sanitiseId(id) {
  return String(id || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default';
}

module.exports = { KIPCast, DEFAULTS };
