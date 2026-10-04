'use strict';
// Setting a display's KIP login from the webapp, without touching the screen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCast } = require('./fakes');

const KIP_CONFIG = {
  configVersion: 12, kipUUID: 'abc', signalKUrl: 'http://localhost:3000', proxyEnabled: false,
  signalKSubscribeAll: false, useDeviceToken: false, loginName: '', loginPassword: '',
  useSharedConfig: false, sharedConfigName: 'default',
};

// A cast with display "helm" known, whose KIP has started with `config`.
async function withKip(t, config = KIP_CONFIG) {
  const env = makeCast(t, { idleCloseSec: 3600 });
  env.cast.addDisplay('helm', 480, 480);
  env.cast.launchBrowser = ((launch) => async (id) => {
    const browser = await launch(id);
    const { page } = env.cast.browsers.at(-1);
    if (config) page.localStorage.setItem('connectionConfig', JSON.stringify(config));
    return browser;
  })(env.cast.launchBrowser);
  return env;
}
const pageOf = (cast) => cast.browsers.at(-1).page;
const saved = (cast) => JSON.parse(pageOf(cast).localStorage.getItem('connectionConfig'));

test('reads who a display\'s KIP logs in as, opening it at its size', async (t) => {
  const { cast } = await withKip(t, { ...KIP_CONFIG, useSharedConfig: true, loginName: 'kip480', loginPassword: 'secret' });
  const login = await cast.getKipLogin('helm');
  assert.deepEqual(login, { user: 'kip480', configName: 'default' });
  assert.equal(pageOf(cast).viewport.width, 480);
  assert.ok(cast.sessions.get('helm').idleTimer, 'closes again if no display arrives');
});

test('a KIP that isn\'t logged in reports no user', async (t) => {
  const { cast } = await withKip(t);
  assert.deepEqual(await cast.getKipLogin('helm'), { user: '', configName: 'default' });
});

test('saves a login Signal K accepts, and reloads KIP', async (t) => {
  const { cast, logs } = await withKip(t);
  const result = await cast.setKipLogin('helm', { user: ' kip480 ', password: 'secret', configName: 'helm' });
  assert.deepEqual(result, { user: 'kip480', configName: 'helm' });

  const page = pageOf(cast);
  assert.equal(page.fetches.length, 1);
  assert.equal(page.fetches[0].url, 'http://localhost:3000/signalk/v1/auth/login');
  assert.deepEqual(JSON.parse(page.fetches[0].init.body), { username: 'kip480', password: 'secret' });
  assert.deepEqual(saved(cast), {
    ...KIP_CONFIG, loginName: 'kip480', loginPassword: 'secret', useSharedConfig: true, sharedConfigName: 'helm',
  });
  assert.equal(page.reloads, 1);
  assert.ok(!logs.some((l) => l.includes('secret')), 'the password is never logged');
});

test('keeps the configuration name when none is given', async (t) => {
  const { cast } = await withKip(t, { ...KIP_CONFIG, sharedConfigName: 'saloon' });
  await cast.setKipLogin('helm', { user: 'kip480', password: 'secret' });
  assert.equal(saved(cast).sharedConfigName, 'saloon');
});

test('a login Signal K rejects is not saved', async (t) => {
  const { cast } = await withKip(t);
  await cast.getKipLogin('helm'); // opens the page
  pageOf(cast).server = () => ({ status: 401 });
  await assert.rejects(cast.setKipLogin('helm', { user: 'kip480', password: 'wrong' }),
    { status: 400, message: /didn’t accept/ });
  assert.deepEqual(saved(cast), KIP_CONFIG);
  assert.equal(pageOf(cast).reloads, undefined);
});

test('Signal K without security is reported', async (t) => {
  const { cast } = await withKip(t);
  await cast.getKipLogin('helm');
  pageOf(cast).server = () => ({ status: 404 });
  await assert.rejects(cast.setKipLogin('helm', { user: 'kip480', password: 'x' }), { status: 502, message: /security/ });
});

test('missing user or password is refused before opening anything', async (t) => {
  const { cast } = await withKip(t);
  await assert.rejects(cast.setKipLogin('helm', { user: '', password: 'x' }), { status: 400 });
  await assert.rejects(cast.setKipLogin('helm', { user: 'kip480' }), { status: 400 });
  assert.equal(cast.browsers.length, 0);
});

test('an unknown display is a 404, and opens no Chromium', async (t) => {
  const { cast } = await withKip(t);
  await assert.rejects(cast.getKipLogin('nosuch'), { status: 404 });
  assert.equal(cast.browsers.length, 0);
});

test('a page that isn\'t KIP is reported', async (t) => {
  const { cast } = await withKip(t, null);
  await assert.rejects(cast.getKipLogin('helm'), { status: 502, message: /look like KIP/ });
});
