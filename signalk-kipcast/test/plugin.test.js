'use strict';
// The Signal K plugin wrapper, checked the way the App Store scores it: it
// loads, has a schema, and starts with the schema's defaults.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createPlugin = require('..');
const { fakeApp } = require('./fakes');

function schemaDefaults(schema) {
  return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.default]));
}

test('loads as a Signal K plugin', () => {
  const plugin = createPlugin(fakeApp(os.tmpdir()));
  assert.equal(plugin.id, 'signalk-kipcast');
  assert.equal(typeof plugin.name, 'string');
  for (const fn of ['start', 'stop', 'registerWithRouter']) assert.equal(typeof plugin[fn], 'function', fn);
  assert.equal(plugin.schema.type, 'object');
});

test('starts with the schema defaults, even without Chromium, and stops', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kipcast-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = fakeApp(dir);
  const plugin = createPlugin(app);
  // Free ports, so the tests don't clash with a KIPCast already running.
  plugin.start({ ...schemaDefaults(plugin.schema), tcpPort: 0, httpPort: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(app.errors, []);
  assert.match(app.statuses.at(-1), /No displays connected/);
  await plugin.stop();
});

test('a missing Chromium is reported in the status, not as an error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kipcast-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = fakeApp(dir);
  const plugin = createPlugin(app);
  plugin.start({ tcpPort: 0, httpPort: 0, chromiumPath: path.join(dir, 'no-such-chromium') });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(app.errors, []);
  assert.match(app.statuses.at(-1), /^Chromium not found at .*no-such-chromium\. No displays connected$/);
  await plugin.stop();
});

test('the KIP login routes answer with the right status', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kipcast-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = createPlugin(fakeApp(dir));
  const routes = {};
  const route = (method) => (p, h) => { routes[`${method} ${p}`] = h; };
  plugin.registerWithRouter({ get: route('GET'), post: route('POST'), put: route('PUT'), delete: route('DELETE') });
  plugin.start({ tcpPort: 0, httpPort: 0 });
  t.after(() => plugin.stop());

  const call = async (key, req) => {
    const res = { code: 200 };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; };
    await routes[key](req, res);
    return res;
  };
  const unknown = await call('GET /displays/:id/kip-login', { params: { id: 'nosuch' } });
  assert.equal(unknown.code, 404);
  assert.match(unknown.body.error, /nosuch/);
  const noUser = await call('PUT /displays/:id/kip-login', { params: { id: 'nosuch' }, body: { password: 'x' } });
  assert.equal(noUser.code, 400);
});
