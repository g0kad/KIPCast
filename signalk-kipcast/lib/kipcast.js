'use strict';
/*
 * KIPCast core
 *
 * One headless Chromium, one tab ("session") per display id. Each tab runs KIP
 * at the display's resolution and streams JPEG frames via the Chrome DevTools
 * Protocol screencast. Touches from the display are injected back into the tab
 * as real touch events, so KIP's own swipe/tap handling just works.
 *
 * Transports:
 *   TCP  (default :3051)  - for ESP32 displays. Line-based text upstream,
 *                           length-prefixed JPEG downstream.
 *   HTTP/WS (default :3050) - browser test viewer at /, WebSocket at /ws?id=...
 *
 * Upstream line protocol (same for TCP and WS):
 *   H <id> <width> <height>   hello (TCP only; WS uses ?id=)
 *   A                         ready for next frame (flow control)
 *   T <D|M|U> <x> <y>         touch down / move / up, in display pixels
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
  width: 800,
  height: 480,
  jpegQuality: 70,
  maxFps: 8,                 // cap on frames Chromium encodes per tab
  httpPort: 3050,
  tcpPort: 3051,
  inputMode: 'touch',        // 'touch' or 'mouse'
  chromiumPath: null,        // auto-detect if null
  userDataDir: path.join(__dirname, '..', 'chrome-profile'),
  idleCloseSec: 300,         // close a tab this long after its last display leaves
};

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
  constructor(label, sendFrame, closeFn) {
    this.label = label;
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
/* One Chromium tab per display id                                     */
/* ------------------------------------------------------------------ */
class Session {
  constructor(cast, id) {
    this.cast = cast;
    this.id = id;
    this.clients = new Set();
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
    const browser = await this.cast.getBrowser();
    // Own window, not a tab: headless Chromium only paints (and so only
    // screencasts) the front tab of each window.
    const page = await browser.newPage({ type: 'window' });
    await page.setViewport({
      width: opts.width,
      height: opts.height,
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

    log(`[${this.id}] opening ${opts.url}`);
    try {
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: opts.jpegQuality,
        maxWidth: opts.width,
        maxHeight: opts.height,
        everyNthFrame: 1,
      });
    } catch (e) {
      await page.close().catch(() => {}); // don't leak a tab per failed attempt
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
    try { if (this.page) await this.page.close(); } catch { /* ignore */ }
    this.cast.log(`[${this.id}] closed`);
  }

  // Queue input so events always reach Chromium in order.
  input(kind, x, y) {
    this.inputChain = this.inputChain
      .then(() => this.dispatch(kind, x, y))
      .catch((e) => this.cast.log(`[${this.id}] input error: ${e.message}`));
  }

  async dispatch(kind, x, y) {
    if (!this.cdp) return;
    const { width, height, inputMode } = this.cast.opts;
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));

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
    this.browser = null;
    this.browserStarting = null;
    this.sessions = new Map();         // id -> Session
    this.sessionStarting = new Map();  // id -> Promise<Session>
    this.httpServer = null;
    this.wss = null;
    this.tcpServer = null;
    this.sockets = new Set();
  }

  async getBrowser() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this.browserStarting) return this.browserStarting;
    this.browserStarting = (async () => {
      const executablePath = this.opts.chromiumPath || findChromium();
      const args = [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ];
      if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
      this.log(`launching ${executablePath}`);
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: this.opts.userDataDir, // keeps KIP's settings/login between restarts
        args,
        defaultViewport: null,
      });
      browser.on('disconnected', () => {
        this.log('Chromium exited; displays will reconnect');
        this.browser = null;
        this.sessions.clear();
        for (const s of this.sockets) s.destroy();
        if (this.wss) for (const ws of this.wss.clients) ws.terminate();
      });
      this.browser = browser;
      return browser;
    })();
    try { return await this.browserStarting; } finally { this.browserStarting = null; }
  }

  async getSession(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    if (this.sessionStarting.has(id)) return this.sessionStarting.get(id);
    const p = (async () => {
      const s = new Session(this, id);
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
        const w = +parts[2], h = +parts[3];
        if (w && h && (w !== this.opts.width || h !== this.opts.height)) {
          this.log(`[${id}] warning: display is ${w}x${h}, KIPCast renders ${this.opts.width}x${this.opts.height}`);
        }
        if (client.session) client.dispose();
        let s;
        try {
          s = await this.getSession(id);
        } catch (e) {
          // Drop the connection so the display retries (and re-sends H) later,
          // rather than sitting connected with no tab behind it.
          this.log(`[${id}] could not open dashboard: ${e.message}`);
          client.close();
          return;
        }
        if (client.closed) return; // left while the tab was opening
        s.addClient(client);
        this.log(`[${id}] display connected (${conn})`);
        this.updateStatus();
        break;
      }
      case 'A': client.ack(); break;
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

  updateStatus() {
    let n = 0;
    for (const s of this.sessions.values()) n += s.clients.size;
    this.status(`${n} display(s) connected, ${this.sessions.size} dashboard tab(s) open`);
  }

  startTcp() {
    this.tcpServer = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 10000);
      const peer = `${sock.remoteAddress}:${sock.remotePort}`;
      const client = new Client(peer, (jpeg) => {
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
      const done = () => { this.sockets.delete(sock); client.dispose(); this.updateStatus(); };
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
      } else {
        res.writeHead(404).end();
      }
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const id = sanitiseId(new URL(req.url, 'http://x').searchParams.get('id') || 'viewer');
      const client = new Client(`ws ${id}`, (jpeg) => ws.send(jpeg, { binary: true }), () => ws.terminate());
      let chain = this.handleLine(client, `H ${id} ${this.opts.width} ${this.opts.height}`, 'browser')
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
    this.startTcp();
    this.startHttp();
    await this.getBrowser(); // fail early if Chromium is missing
    this.updateStatus();
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    if (this.wss) {
      // wss.close() leaves open connections alone, which would keep
      // httpServer.close() waiting forever.
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
    }
    for (const s of [...this.sessions.values()]) clearTimeout(s.idleTimer);
    await new Promise((r) => (this.tcpServer ? this.tcpServer.close(() => r()) : r()));
    await new Promise((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.sessions.clear();
  }
}

function sanitiseId(id) {
  return String(id || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default';
}

module.exports = { KIPCast, DEFAULTS };
