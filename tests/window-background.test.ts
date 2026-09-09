import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_BACKGROUND,
  getWindowComposition,
  normalizeWindowBackground,
  resolveWindowBackground,
} from '../src/shared/window-background.ts';

test('old settings default to an opaque themed background', () => {
  assert.deepEqual(normalizeWindowBackground(null), DEFAULT_WINDOW_BACKGROUND);
  assert.deepEqual(normalizeWindowBackground({}), DEFAULT_WINDOW_BACKGROUND);
});
test('invalid persisted values cannot generate invalid CSS or out-of-range alpha', () => {
  assert.equal(normalizeWindowBackground({ transparency: Infinity }).transparency, 0);
  assert.equal(normalizeWindowBackground({ transparency: -20 }).transparency, 0);
  assert.equal(normalizeWindowBackground({ transparency: 180 }).transparency, 100);
  assert.equal(normalizeWindowBackground({ color: 'url(https://example.com)' }).color, '');
});
test('frost preserves the color and transparency to restore on exit', () => {
  const saved = { enabled: true, transparency: 65, frosted: true, color: '#aAbBcC' };
  assert.deepEqual(normalizeWindowBackground(saved), saved);
  assert.deepEqual(normalizeWindowBackground({ ...saved, frosted: false }), {
    ...saved,
    frosted: false,
  });
});

test('legacy transparency settings remain saved but default to disabled', () => {
  const saved = normalizeWindowBackground({ transparency: 65, frosted: true, color: '#aAbBcC' });
  assert.equal(saved.enabled, false);
  assert.equal(saved.transparency, 65);
  assert.deepEqual(resolveWindowBackground(saved, false), DEFAULT_WINDOW_BACKGROUND);
});

test('switching native mode takes effect only after recreation', () => {
  const saved = { enabled: true, transparency: 65, frosted: true, color: '#aAbBcC' };
  assert.deepEqual(resolveWindowBackground(saved, false), DEFAULT_WINDOW_BACKGROUND);
  assert.deepEqual(resolveWindowBackground(saved, true), saved);
  const disabled = { ...saved, enabled: false };
  assert.deepEqual(resolveWindowBackground(disabled, true), saved);
  assert.deepEqual(resolveWindowBackground(disabled, false), DEFAULT_WINDOW_BACKGROUND);
});

test('Windows Acrylic uses a system window, clear transparency uses client corners', () => {
  const clear = { enabled: true, frosted: false, transparency: 50, color: '' };
  assert.deepEqual(getWindowComposition(clear, 'win32', 22631), {
    transparent: true,
    systemMaterial: false,
    clientCornerRadius: 8,
  });
  assert.deepEqual(getWindowComposition({ ...clear, frosted: true }, 'win32', 22631), {
    transparent: false,
    systemMaterial: true,
    clientCornerRadius: 0,
  });
  assert.deepEqual(getWindowComposition({ ...clear, enabled: false }, 'win32', 22631), {
    transparent: false,
    systemMaterial: false,
    clientCornerRadius: 0,
  });
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(getWindowComposition({ ...clear, frosted: true }, platform, 22631), {
      transparent: true,
      systemMaterial: false,
      clientCornerRadius: 0,
    });
  }
  assert.equal(getWindowComposition(clear, 'win32', 19045).clientCornerRadius, 0);
});

test('pending Windows frost changes cannot change the running composition before restart', () => {
  const saved = { enabled: true, frosted: true, transparency: 62, color: '#123456' };
  assert.equal(resolveWindowBackground(saved, true, false).frosted, false);
  const pendingClear = { ...saved, frosted: false };
  assert.equal(resolveWindowBackground(pendingClear, true, true).frosted, true);
  assert.equal(resolveWindowBackground(saved, true, null).frosted, true);
  assert.deepEqual(resolveWindowBackground(saved, false, false), DEFAULT_WINDOW_BACKGROUND);
  assert.equal(resolveWindowBackground(pendingClear, true, false).transparency, 62);
});
