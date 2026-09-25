'use strict';
// End to end over a real TCP socket on localhost, as an ESP32 display talks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { once } = require('events');
const { makeCast, frame } = require('./fakes');

// The App Store runs tests sandboxed from the network; skip there to be safe.
const skip = process.env.SIGNALK_REGISTRY_TEST ? 'no network in the registry sandbox' : false;

// Reads 'KCF' + uint32 BE length + JPEG messages off a socket.
function frameReader(sock) {
  let buf = Buffer.alloc(0);
  const waiting = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 7 && waiting.length) {
      assert.equal(buf.toString('ascii', 0, 3), 'KCF');
      const len = buf.readUInt32BE(3);
      if (buf.length < 7 + len) break;
      waiting.shift()(buf.subarray(7, 7 + len));
      buf = buf.subarray(7 + len);
    }
  });
  return () => new Promise((resolve) => waiting.push(resolve));
}

async function until(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), 'timed out');
}

test('an ESP32-style display over TCP', { skip }, async (t) => {
  const { cast, statuses } = makeCast(t);
  await cast.start();
  if (!cast.tcpServer.listening) await once(cast.tcpServer, 'listening');

  const sock = net.connect(cast.tcpServer.address().port, '127.0.0.1');
  t.after(() => sock.destroy());
  await once(sock, 'connect');
  const nextFrame = frameReader(sock);

  sock.write('H helm 480 480 0.3.0\n');
  await until(() => cast.browsers.length === 1 && cast.sessions.get('helm'));
  const { cdp, page } = cast.browsers[0];
  assert.equal(page.viewport.width, 480);
  assert.equal(cast.listDisplays()[0].firmware, '0.3.0');

  const got = nextFrame();
  frame(cdp, Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]));
  assert.deepEqual([...await got], [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

  // Several lines in one packet, and one split across two.
  sock.write('A\nP\nT D 1');
  sock.write('0 20\nT U 10 20\n');
  await until(() => cdp.calls('Input.dispatchTouchEvent').length === 2);
  assert.deepEqual(cdp.calls('Input.dispatchTouchEvent').map((e) => e.type), ['touchStart', 'touchEnd']);

  sock.destroy();
  await until(() => cast.listDisplays()[0].screens === 0);
  assert.match(statuses.at(-1), /No displays connected/);
});
