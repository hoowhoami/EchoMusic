import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCloseBehavior } from '../src/shared/app.ts';

test('existing close preferences stay unchanged on every supported platform', () => {
  for (const platform of ['darwin', 'win32', 'linux', undefined]) {
    assert.equal(normalizeCloseBehavior('tray', platform), 'tray');
    assert.equal(normalizeCloseBehavior('exit', platform), 'exit');
  }
});

test('background close preference is supported only on macOS', () => {
  assert.equal(normalizeCloseBehavior('background', 'darwin'), 'background');
  for (const platform of ['win32', 'linux', undefined]) {
    assert.equal(normalizeCloseBehavior('background', platform), 'tray');
  }
});

test('missing or invalid preferences retain the tray default', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const value of [undefined, null, '', 'unknown', true, 1, {}, ['background']]) {
      assert.equal(normalizeCloseBehavior(value, platform), 'tray');
    }
  }
});
