import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeZoomLevel,
  zoomLevelToFactor,
  zoomShortcut,
  titleBarHeight,
} from '../src/shared/window-zoom.ts';

test('VS Code zoom range, exponential steps and invalid settings', () => {
  for (const value of [null, '2', NaN, Infinity, {}, undefined])
    assert.equal(normalizeZoomLevel(value), 0);
  assert.equal(normalizeZoomLevel(99), 8);
  assert.equal(normalizeZoomLevel(-99), -8);
  assert.equal(normalizeZoomLevel(0.5), 0.5);
  assert.equal(zoomLevelToFactor(0), 1);
  assert.equal(zoomLevelToFactor(1), 1.2);
  assert.ok(Math.abs(zoomLevelToFactor(-1) - 1 / 1.2) < 1e-10);
  assert.equal(titleBarHeight(-8), 35);
  assert.equal(titleBarHeight(0), 46);
  assert.equal(titleBarHeight(2), 66);
});
test('zoom key bindings use the platform modifier and exclude AltGr', () => {
  const input = { key: '=', control: true, meta: false, alt: false };
  for (const platform of ['win32', 'linux']) {
    assert.equal(zoomShortcut(input, platform), 'in');
    assert.equal(zoomShortcut({ ...input, key: '+' }, platform), 'in');
    assert.equal(zoomShortcut({ ...input, key: '-' }, platform), 'out');
    assert.equal(zoomShortcut({ ...input, key: '0' }, platform), 'reset');
    assert.equal(zoomShortcut({ ...input, alt: true }, platform), null);
    assert.equal(zoomShortcut({ ...input, control: false }, platform), null);
  }
  assert.equal(zoomShortcut(input, 'darwin'), null);
  assert.equal(zoomShortcut({ ...input, control: false, meta: true }, 'darwin'), 'in');
  assert.equal(zoomShortcut({ ...input, key: 'x' }, 'win32'), null);
});
