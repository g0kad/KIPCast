'use strict';
// The browser viewer's login: a one-time pass from the plugin buys a cookie,
// and the page, /displays and the WebSocket all need it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { once } = require('events');
const WebSocket = require('ws');
const createPlugin = require('..');
const { makeCast, fakeApp } = require('./fakes');

// The App Store runs tests sandboxed from the network; skip there to be safe.
const skip = process.env.SIGNALK_REGISTRY_TEST ? 'no network in the registry sandbox' : false;

async function started(t, opts) {
  const { cast } = makeCast(t, opts);
  await cast.start();
  if (!cast.httpServer.listening) await once(cast.httpServer, 'listening');
  return { cast, port: cast.httpServer.address().port };
}

function get(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, host: '127.0.0.1', headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

// Resolves 'open', or the HTTP status the handshake was refused with.
function wsResult(port, cookie, origin = `http://127.0.0.1:${port}`) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=helm`, { headers: cookie ? { Cookie: cookie } : {}, origin });
    ws.on('open', () => { ws.terminate(); resolve('open'); });
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
    ws.on('error', () => {});
  });
}

test('with viewerAuth, the viewer needs a pass, then its cookie', { skip }, async (t) => {
  const { cast, port } = await started(t, { viewerAuth: true });

  assert.equal((await get(port, '/?id=helm')).status, 403);
  assert.equal((await get(port, '/displays')).status, 403);
  assert.equal(await wsResult(port), 401);

  const pass = cast.issueViewerPass();
  const swap = await get(port, `/?id=helm&pass=${pass}`);
  assert.equal(swap.status, 303);
  assert.equal(swap.headers.location, '/?id=helm');  // pass dropped from the address
  const setCookie = swap.headers['set-cookie'][0];
  assert.match(setCookie, /^kipcast_viewer=[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  assert.equal((await get(port, `/?id=helm&pass=${pass}`)).status, 403, 'a pass works once');
  assert.equal((await get(port, '/?id=helm', cookie)).status, 200);
  assert.equal((await get(port, '/displays', cookie)).status, 200);
  assert.equal((await get(port, '/displays', 'kipcast_viewer=made-up')).status, 403);

  assert.equal(await wsResult(port, cookie), 'open');
  assert.equal(await wsResult(port, cookie, 'http://evil.example'), 401, 'other sites are refused');
});

test('passes and cookies expire', { skip }, async (t) => {
  const { cast, port } = await started(t, { viewerAuth: true, viewerPassSec: -1 });
  assert.equal((await get(port, `/?pass=${cast.issueViewerPass()}`)).status, 403);

  cast.opts.viewerPassSec = 60;
  cast.opts.viewerCookieSec = -1;
  const swap = await get(port, `/?pass=${cast.issueViewerPass()}`);
  const cookie = swap.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get(port, '/', cookie)).status, 403);
});

test('without viewerAuth, the viewer is open', { skip }, async (t) => {
  const { port } = await started(t, { viewerAuth: false });
  assert.equal((await get(port, '/?id=helm')).status, 200);
  assert.equal((await get(port, '/displays')).status, 200);
  assert.equal(await wsResult(port), 'open');
});

test('the plugin turns viewerAuth on, and hands out passes', async (t) => {
  const plugin = createPlugin(fakeApp(require('os').tmpdir()));
  const routes = {};
  plugin.registerWithRouter({
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  });
  plugin.start({ tcpPort: 0, httpPort: 0 });
  t.after(() => plugin.stop());

  let sent;
  routes['POST /viewer-pass']({}, { json: (b) => { sent = b; }, status: () => ({ json: () => {} }) });
  assert.match(sent.pass, /^[\w-]{20,}$/);
});
