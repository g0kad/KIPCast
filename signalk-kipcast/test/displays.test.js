'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIPCast } = require('../lib/kipcast');
const { makeCast } = require('./fakes');

test('addDisplay remembers a valid display', (t) => {
  const { cast } = makeCast(t);
  assert.equal(cast.addDisplay('helm', 480, 480), 'helm');
  const [d] = cast.listDisplays();
  assert.equal(d.id, 'helm');
  assert.equal(d.width, 480);
  assert.equal(d.height, 480);
  assert.equal(d.source, 'manual');
  assert.equal(d.open, false);
});

test('addDisplay rejects bad ids and sizes', (t) => {
  const { cast } = makeCast(t);
  assert.throws(() => cast.addDisplay('bad id', 480, 480), /Display id/);
  assert.throws(() => cast.addDisplay('', 480, 480), /Display id/);
  assert.throws(() => cast.addDisplay('helm', 10, 480), /Width and height/);
  assert.throws(() => cast.addDisplay('helm', 480, NaN), /Width and height/);
  assert.equal(cast.listDisplays().length, 0);
});

test('displays survive a restart', async (t) => {
  const { cast, dir } = makeCast(t);
  cast.addDisplay('helm', 480, 480);
  cast.addDisplay('nav', 800, 480);
  await cast.stop(); // writes out the pending save

  const again = new KIPCast({ displaysFile: path.join(dir, 'displays.json') });
  assert.deepEqual(again.listDisplays().map((d) => [d.id, d.width, d.height]), [['helm', 480, 480], ['nav', 800, 480]]);
});

test('bad entries in the displays file are skipped', (t) => {
  const { dir } = makeCast(t);
  const file = path.join(dir, 'displays.json');
  fs.writeFileSync(file, JSON.stringify({
    good: { width: 480, height: 480 },
    tiny: { width: 5, height: 5 },
    'bad id!': { width: 800, height: 480 },
  }));
  const cast = new KIPCast({ displaysFile: file });
  assert.deepEqual(cast.listDisplays().map((d) => d.id), ['badid', 'good']);
});

test('an unreadable displays file starts empty', (t) => {
  const { dir } = makeCast(t);
  const file = path.join(dir, 'displays.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new KIPCast({ displaysFile: file }).listDisplays(), []);
});

test('forgetDisplay removes it', (t) => {
  const { cast } = makeCast(t);
  cast.addDisplay('helm', 480, 480);
  cast.forgetDisplay('helm');
  assert.deepEqual(cast.listDisplays(), []);
});

test('a screen is the authority on its own size', (t) => {
  const { cast, client } = makeCast(t);
  cast.addDisplay('helm', 800, 480);
  assert.deepEqual(cast.sizeFor('helm', client('screen'), 480, 480), [480, 480]);
  const [d] = cast.listDisplays();
  assert.equal(d.width, 480);
  assert.equal(d.source, 'screen');
});

test('a viewer only records a size for a new id', (t) => {
  const { cast, client } = makeCast(t);
  cast.addDisplay('helm', 480, 480);
  // It gets the size it asked for, but doesn't overwrite the known one...
  assert.deepEqual(cast.sizeFor('helm', client('viewer'), 1024, 600), [1024, 600]);
  assert.equal(cast.listDisplays()[0].width, 480);
  // ...though a new id is remembered at the viewer's size.
  cast.sizeFor('new', client('viewer'), 1024, 600);
  assert.equal(cast.listDisplays().find((d) => d.id === 'new').source, 'viewer');
});

test('without a reported size, use the remembered one, else the default', (t) => {
  const { cast, client } = makeCast(t, { width: 1024, height: 600 });
  cast.addDisplay('helm', 480, 480);
  assert.deepEqual(cast.sizeFor('helm', client('viewer'), 0, 0), [480, 480]);
  assert.deepEqual(cast.sizeFor('other', client('screen'), 0, 0), [1024, 600]);
});

test('a screen\'s firmware version is remembered and compared with the latest', async (t) => {
  const { cast, client, dir } = makeCast(t, { latestFirmware: '0.3.0' });
  const hello = (id, fw) => {
    cast.sizeFor(id, client('screen'), 480, 480);
    cast.rememberFirmware(id, fw);
  };
  hello('current', '0.3.0');
  hello('old', '0.2.9');
  hello('ancient', undefined);   // firmware from before versions were reported
  hello('newer', '0.10.0');
  hello('dev', 'dev');
  hello('junk', 'not a version!');
  cast.addDisplay('manual', 800, 480);
  const byId = Object.fromEntries(cast.listDisplays().map((d) => [d.id, d]));
  assert.deepEqual(
    Object.entries(byId).map(([id, d]) => [id, d.firmware, d.firmwareOutdated]),
    [['ancient', '', true], ['current', '0.3.0', false], ['dev', 'dev', false], ['junk', '', true],
      ['manual', null, false], ['newer', '0.10.0', false], ['old', '0.2.9', true]],
  );

  // Kept across a restart, and when the screen reports its size again.
  cast.sizeFor('old', client('screen'), 480, 480);
  await cast.stop();
  const again = new KIPCast({ displaysFile: path.join(dir, 'displays.json'), latestFirmware: '0.3.0' });
  assert.equal(again.listDisplays().find((d) => d.id === 'old').firmware, '0.2.9');
});

test('the plugin status names screens with old firmware', (t) => {
  const { cast, client, statuses } = makeCast(t, { latestFirmware: '0.3.0' });
  cast.sizeFor('helm', client('screen'), 480, 480);
  cast.rememberFirmware('helm', '0.2.0');
  cast.updateStatus();
  assert.match(statuses.at(-1), /Firmware 0\.3\.0 is available for helm: https:\/\/g0kad\.github\.io\/KIPCast\//);
  cast.rememberFirmware('helm', '0.3.0');
  cast.updateStatus();
  assert.doesNotMatch(statuses.at(-1), /Firmware/);
});
