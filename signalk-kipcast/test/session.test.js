'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCast, frame } = require('./fakes');

// Connect a display and return it with its (fake) Chromium.
async function connect(cast, c, hello) {
  await cast.handleLine(c, hello, 'test');
  return cast.browsers[cast.browsers.length - 1];
}

test('hello opens the dashboard at the display size and starts the screencast', async (t) => {
  const { cast, client } = makeCast(t, { url: 'http://kip.test/', jpegQuality: 55 });
  const { page, cdp } = await connect(cast, client(), 'H helm 480 480');
  assert.equal(page.url, 'http://kip.test/');
  assert.equal(page.viewport.width, 480);
  assert.equal(page.viewport.height, 480);
  assert.equal(page.viewport.hasTouch, true);
  const [sc] = cdp.calls('Page.startScreencast');
  assert.equal(sc.format, 'jpeg');
  assert.equal(sc.quality, 55);
  assert.equal(sc.maxWidth, 480);
  assert.equal(cast.listDisplays()[0].screens, 1);
});

test('a display gets one frame at a time, and only the newest', async (t) => {
  const { cast, client } = makeCast(t);
  const c = client();
  const { cdp } = await connect(cast, c, 'H helm 480 480');

  frame(cdp, 'one');
  frame(cdp, 'two');   // arrives before the display acks "one"
  frame(cdp, 'three');
  assert.deepEqual(c.frames.map(String), ['one']);

  await cast.handleLine(c, 'A');
  assert.deepEqual(c.frames.map(String), ['one', 'three']);

  await cast.handleLine(c, 'A'); // nothing new to send
  assert.equal(c.frames.length, 2);
  frame(cdp, 'four');
  assert.deepEqual(c.frames.map(String), ['one', 'three', 'four']);
});

test('a new display sees the current frame straight away', async (t) => {
  const { cast, client } = makeCast(t);
  const { cdp } = await connect(cast, client(), 'H helm 480 480');
  frame(cdp, 'dashboard');
  const viewer = client('viewer');
  await cast.handleLine(viewer, 'H helm 0 0');
  assert.deepEqual(viewer.frames.map(String), ['dashboard']);
  assert.equal(cast.browsers.length, 1, 'the viewer shares the display\'s Chromium');
});

test('a display that never acks is sent frames again after 5 s', async (t) => {
  const { cast, client } = makeCast(t);
  const c = client();
  const { cdp } = await connect(cast, c, 'H helm 480 480');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frame(cdp, 'one');
  frame(cdp, 'two');
  t.mock.timers.tick(4999);
  assert.equal(c.frames.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(c.frames.map(String), ['one', 'two']);
});

test('Chromium is paced to maxFps by spacing the frame acks', async (t) => {
  const { cast, client } = makeCast(t, { maxFps: 10 });
  const { cdp } = await connect(cast, client(), 'H helm 480 480');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  frame(cdp, 'a', 1);
  frame(cdp, 'b', 2);
  frame(cdp, 'c', 3);
  const acks = () => cdp.calls('Page.screencastFrameAck').map((p) => p.sessionId);
  t.mock.timers.tick(1);
  assert.deepEqual(acks(), [1]);
  t.mock.timers.tick(98);
  assert.deepEqual(acks(), [1]);
  t.mock.timers.tick(1);
  assert.deepEqual(acks(), [1, 2]);
  t.mock.timers.tick(100);
  assert.deepEqual(acks(), [1, 2, 3]);
});

test('touches become touch events, clamped to the screen', async (t) => {
  const { cast, client } = makeCast(t);
  const c = client();
  const { cdp } = await connect(cast, c, 'H helm 480 480');
  for (const line of ['T M 5 5', 'T D 10 20', 'T M 600 -3', 'T U 600 -3', 'T X 1 1']) await cast.handleLine(c, line);
  await c.session.inputChain;
  assert.deepEqual(cdp.calls('Input.dispatchTouchEvent'), [
    // the stray move before any touch-down is dropped, as is the unknown 'X'
    { type: 'touchStart', touchPoints: [{ x: 10, y: 20, id: 0, radiusX: 4, radiusY: 4, force: 1 }] },
    { type: 'touchMove', touchPoints: [{ x: 479, y: 0, id: 0, radiusX: 4, radiusY: 4, force: 1 }] },
    { type: 'touchEnd', touchPoints: [] },
  ]);
});

test('mouse input mode sends mouse events instead', async (t) => {
  const { cast, client } = makeCast(t, { inputMode: 'mouse' });
  const c = client();
  const { cdp, page } = await connect(cast, c, 'H helm 800 480');
  assert.equal(page.viewport.hasTouch, false);
  await cast.handleLine(c, 'T D 10 20');
  await cast.handleLine(c, 'T U 10 20');
  await c.session.inputChain;
  assert.deepEqual(cdp.calls('Input.dispatchMouseEvent').map((e) => [e.type, e.x, e.y, e.buttons]),
    [['mousePressed', 10, 20, 1], ['mouseReleased', 10, 20, 0]]);
});

test('typed text and keys reach Chromium', async (t) => {
  const { cast, client } = makeCast(t);
  const c = client();
  const { cdp } = await connect(cast, c, 'H helm 480 480');
  await cast.handleLine(c, `I ${encodeURIComponent('pass word£')}`);
  await cast.handleLine(c, 'I %E0%A4%A'); // malformed: ignored
  await cast.handleLine(c, 'K Enter');
  await cast.handleLine(c, 'K a 2');      // Ctrl+A
  await cast.handleLine(c, 'K toString'); // not a key
  await c.session.inputChain;
  assert.deepEqual(cdp.calls('Input.insertText'), [{ text: 'pass word£' }]);
  assert.deepEqual(cdp.calls('Input.dispatchKeyEvent').map((e) => [e.type, e.key, e.modifiers, e.text]), [
    ['keyDown', 'Enter', 0, '\r'],
    ['keyUp', 'Enter', 0, undefined],
    ['rawKeyDown', 'a', 2, undefined],
    ['keyUp', 'a', 2, undefined],
  ]);
});

test('each display id gets its own Chromium', async (t) => {
  const { cast, client, statuses } = makeCast(t);
  await connect(cast, client(), 'H helm 480 480');
  await connect(cast, client(), 'H nav 800 480');
  assert.deepEqual(cast.browsers.map((b) => [b.id, b.page.viewport.width]), [['helm', 480], ['nav', 800]]);
  assert.match(statuses.at(-1), /Connected: helm 480×480, nav 800×480/);
});

test('a screen reopens a page the viewer opened at another size', async (t) => {
  const { cast, client } = makeCast(t);
  const viewer = client('viewer');
  const first = await connect(cast, viewer, 'H helm 800 480');
  const second = await connect(cast, client(), 'H helm 480 480');
  assert.equal(first.browser.closed, true);
  assert.equal(viewer.wasClosed, true, 'the viewer is dropped so it reconnects');
  assert.equal(second.page.viewport.width, 480);
});

test('a second screen with the same id shares the first one\'s page', async (t) => {
  const { cast, client, logs } = makeCast(t);
  await connect(cast, client(), 'H helm 480 480');
  await cast.handleLine(client(), 'H helm 800 480');
  assert.equal(cast.browsers.length, 1);
  assert.ok(logs.some((l) => /already open at 480x480/.test(l)));
});

test('if the dashboard can\'t open, the display is dropped so it retries', async (t) => {
  const { cast, client } = makeCast(t);
  cast.launchBrowser = async () => { throw new Error('no browser'); };
  const c = client();
  await cast.handleLine(c, 'H helm 480 480');
  assert.equal(c.wasClosed, true);
  assert.equal(c.session, null);
});

test('a Chromium that exits drops its displays and is forgotten', async (t) => {
  const { cast, client } = makeCast(t);
  const c = client();
  const { browser } = await connect(cast, c, 'H helm 480 480');
  browser.emit('disconnected');
  assert.equal(c.wasClosed, true);
  assert.equal(cast.sessions.size, 0);
});

test('a page left with no displays closes after idleCloseSec', async (t) => {
  const { cast, client } = makeCast(t, { idleCloseSec: 60 });
  const c = client();
  const { browser } = await connect(cast, c, 'H helm 480 480');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  c.dispose();
  t.mock.timers.tick(59_999);
  assert.equal(browser.closed, undefined);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(browser.closed, true);
  assert.equal(cast.sessions.size, 0);
});
