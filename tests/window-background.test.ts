import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_BACKGROUND,
  normalizeWindowBackground,
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
  const saved = { transparency: 65, frosted: true, color: '#aAbBcC' };
  assert.deepEqual(normalizeWindowBackground(saved), saved);
  assert.deepEqual(normalizeWindowBackground({ ...saved, frosted: false }), {
    ...saved,
    frosted: false,
  });
});
