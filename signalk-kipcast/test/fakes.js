'use strict';
// Stand-ins for Chromium and the Signal K app, so the tests need neither a
// browser nor a network (the App Store runs them sandboxed without both).

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
