'use strict';
// Stand-ins for Chromium and the Signal K app, so the tests need neither a
// browser nor a network (the App Store runs them sandboxed without both).

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { KIPCast, Client } = require('../lib/kipcast');

// A browser with one page and a CDP session that records what it's sent.
function fakeBrowser() {
  const cdp = new EventEmitter();
  cdp.sent = [];
  cdp.send = async (method, params) => { cdp.sent.push({ method, params }); return {}; };
  cdp.calls = (method) => cdp.sent.filter((c) => c.method === method).map((c) => c.params);

  const page = new EventEmitter();
  page.setViewport = async (v) => { page.viewport = v; };
  page.createCDPSession = async () => cdp;
  page.goto = async (url) => { page.url = url; };
  page.onNewDocument = [];
  page.evaluateOnNewDocument = async (fn) => { page.onNewDocument.push(fn); };
  page.reload = async () => { page.reloads = (page.reloads || 0) + 1; };

  // Code run "in the page" gets this localStorage, and fetch answers from
  // page.server (a function (url, init) => { status }), as KIP's would.
  const store = new Map();
  page.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  page.fetches = [];
  page.server = () => ({ status: 200 });
  const context = vm.createContext({
    localStorage: page.localStorage,
    location: { origin: 'http://localhost:3000' },
    fetch: async (url, init) => {
      page.fetches.push({ url, init });
      const { status } = page.server(url, init);
      return { status, ok: status >= 200 && status < 300 };
    },
    JSON,
  });
  page.evaluate = async (fn, ...args) => {
    // Plain data in and out, as with a real page.
    const run = vm.runInContext(`(${fn})`, context);
    return JSON.parse(JSON.stringify(await run(...args)) ?? 'null');
  };
  page.waitForFunction = async (fn) => {
    if (!await page.evaluate(fn)) throw new Error('waitForFunction timed out');
  };

  const browser = new EventEmitter();
  browser.pages = async () => [page];
  browser.newPage = async () => page;
  browser.close = async () => { browser.closed = true; };

  return { browser, page, cdp };
}

// A KIPCast whose Chromiums are fakes, with its displays file in a temp dir.
// Everything is stopped and removed when the test ends.
function makeCast(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kipcast-test-'));
  const logs = [];
  const statuses = [];
  const clients = [];
  const cast = new KIPCast({
    displaysFile: path.join(dir, 'displays.json'),
    tcpPort: 0,
    httpPort: 0,
    chromiumPath: process.execPath, // any file that exists
    log: (m) => logs.push(m),
    status: (s) => statuses.push(s),
    ...opts,
  });
  cast.browsers = [];
  cast.launchBrowser = async (id) => {
    const b = { id, ...fakeBrowser() };
    cast.browsers.push(b);
    return b.browser;
  };

  // A connected display that records the frames it's sent.
  const client = (kind = 'screen') => {
    const c = new Client(`test ${kind}`, kind, (jpeg) => c.frames.push(jpeg), () => { c.wasClosed = true; });
    c.frames = [];
    clients.push(c);
    return c;
  };

  t.after(async () => {
    for (const c of clients) c.dispose();
    await cast.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { cast, dir, logs, statuses, client };
}

// Chromium sending one screencast frame.
function frame(cdp, bytes, sessionId = 1) {
  cdp.emit('Page.screencastFrame', { data: Buffer.from(bytes).toString('base64'), sessionId });
}

// Just enough of Signal K's app object for index.js.
function fakeApp(dataDir) {
  const app = { debugs: [], statuses: [], errors: [] };
  app.getDataDirPath = () => dataDir;
  app.debug = (m) => app.debugs.push(m);
  app.setPluginStatus = (s) => app.statuses.push(s);
  app.setPluginError = (e) => app.errors.push(e);
  return app;
}

module.exports = { fakeBrowser, makeCast, frame, fakeApp };
