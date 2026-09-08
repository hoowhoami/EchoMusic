import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_BACKGROUND,
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
