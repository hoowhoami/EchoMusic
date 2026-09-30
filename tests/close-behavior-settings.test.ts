import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCloseBehavior, normalizeClosePreferences } from '../src/shared/app.ts';

test('close behavior supports tray and exit', () => {
  assert.equal(normalizeCloseBehavior('tray'), 'tray');
  assert.equal(normalizeCloseBehavior('exit'), 'exit');
});

test('missing or invalid preferences retain the tray default', () => {
  for (const value of [undefined, null, '', 'unknown', true, 1, {}, ['tray']]) {
    assert.equal(normalizeCloseBehavior(value), 'tray');
  }
});

test('new installations keep both background icons visible', () => {
  assert.deepEqual(normalizeClosePreferences({}), {
    closeBehavior: 'tray',
    hideDockInBackground: false,
    hideMenuBarInBackground: false,
  });
});

test('background icon preferences are independent and survive switching to exit', () => {
  for (const closeBehavior of ['tray', 'exit']) {
    for (const hideDockInBackground of [false, true]) {
      for (const hideMenuBarInBackground of [false, true]) {
        const preferences = { closeBehavior, hideDockInBackground, hideMenuBarInBackground };
        assert.deepEqual(normalizeClosePreferences(preferences), preferences);
      }
    }
  }
});

test('malformed flags do not accidentally hide an application entry', () => {
  for (const value of [undefined, null, '', 'true', 'false', 0, 1, {}, []]) {
    assert.deepEqual(
      normalizeClosePreferences({
        closeBehavior: 'tray',
        hideDockInBackground: value,
        hideMenuBarInBackground: value,
      }),
      { closeBehavior: 'tray', hideDockInBackground: false, hideMenuBarInBackground: false },
    );
  }
});
