'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitiseId, validSize, keyInfo } = require('../lib/kipcast');

test('sanitiseId keeps letters, digits, - and _ and caps the length', () => {
  assert.equal(sanitiseId('helm_4-in'), 'helm_4-in');
  assert.equal(sanitiseId('../etc/passwd'), 'etcpasswd');
  assert.equal(sanitiseId('a'.repeat(40)), 'a'.repeat(32));
});

test('sanitiseId falls back to "default"', () => {
  assert.equal(sanitiseId(undefined), 'default');
  assert.equal(sanitiseId(''), 'default');
  assert.equal(sanitiseId('!!!'), 'default');
});

test('validSize accepts 64-4096 and rounds', () => {
  assert.equal(validSize('480'), 480);
  assert.equal(validSize(799.6), 800);
  assert.equal(validSize(64), 64);
  assert.equal(validSize(4096), 4096);
});

test('validSize rejects missing or implausible sizes', () => {
  for (const v of [undefined, '', 'abc', 0, 63, 4097, -480]) assert.equal(validSize(v), 0, `${v}`);
});

test('keyInfo maps named keys, with text only where a key types something', () => {
  assert.deepEqual(keyInfo('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keyInfo('Backspace'), { key: 'Backspace', code: 'Backspace', vk: 8, text: undefined });
  assert.deepEqual(keyInfo('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, text: undefined });
});

test('keyInfo maps single letters and digits', () => {
  assert.deepEqual(keyInfo('a'), { key: 'a', code: 'KeyA', vk: 65 });
  assert.deepEqual(keyInfo('7'), { key: '7', code: 'Digit7', vk: 55 });
});

test('keyInfo ignores anything else', () => {
  for (const k of ['', 'ab', 'F13', '%', 'toString']) assert.equal(keyInfo(k), null, k);
});

test('firmware versions', () => {
  const { cleanVersion, isRelease, compareVersions } = require('../lib/kipcast');
  assert.equal(cleanVersion('0.3.0'), '0.3.0');
  assert.equal(cleanVersion('dev-abc1234'), 'dev-abc1234');
  assert.equal(cleanVersion(undefined), '');
  assert.equal(cleanVersion('<script>'), '');
  assert.ok(isRelease('1.2.3'));
  assert.ok(!isRelease('dev'));
  assert.ok(!isRelease('1.2'));
  assert.ok(compareVersions('0.2.9', '0.3.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('the latest firmware comes from package.json', () => {
  const { DEFAULTS } = require('../lib/kipcast');
  assert.equal(DEFAULTS.latestFirmware, require('../package.json').kipcast.firmware);
});
