import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAIN_WINDOW_LAYOUT_MIN_HEIGHT,
  resolveMainWindowMinHeight,
} from '../src/main/windowSizing.ts';

test('large displays do not raise the main-window layout minimum above 650px', () => {
  assert.equal(resolveMainWindowMinHeight(1440), MAIN_WINDOW_LAYOUT_MIN_HEIGHT);
  assert.equal(resolveMainWindowMinHeight(2160), MAIN_WINDOW_LAYOUT_MIN_HEIGHT);
});

test('the minimum fits a 693px Wayland fractional-scaling tile', () => {
  const tileHeight = 693;
  assert.ok(resolveMainWindowMinHeight(1440) <= tileHeight);
});

test('very small work areas never receive a minimum taller than 95 percent', () => {
  assert.equal(resolveMainWindowMinHeight(600), 570);
});
