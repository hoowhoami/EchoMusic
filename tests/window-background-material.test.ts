import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncWindowsBackgroundMaterial } from '../src/main/window/backgroundMaterial.ts';

function createWindow() {
  const calls: string[] = [];
  return {
    calls,
    setBackgroundMaterial: (material: string) => {
      calls.push(material);
    },
  };
}

test('clear transparency never resets DWM material on a fresh window', () => {
  const window = createWindow();
  // Startup, native theme updates, and alpha/color adjustments all sync here.
  for (let i = 0; i < 5; i++) syncWindowsBackgroundMaterial(window, false);
  assert.deepEqual(window.calls, []);
});

test('material changes only when entering or leaving frost', () => {
  const window = createWindow();
  for (const frosted of [true, true, false, false, true]) {
    syncWindowsBackgroundMaterial(window, frosted);
  }
  assert.deepEqual(window.calls, ['acrylic', 'none', 'acrylic']);
});

test('recreated windows do not inherit the old native material state', () => {
  const oldWindow = createWindow();
  syncWindowsBackgroundMaterial(oldWindow, true);
  const newWindow = createWindow();
  syncWindowsBackgroundMaterial(newWindow, false);
  assert.deepEqual(newWindow.calls, []);
  syncWindowsBackgroundMaterial(newWindow, true);
  assert.deepEqual(newWindow.calls, ['acrylic']);
});

test('failed native updates can be retried', () => {
  let attempts = 0;
  const window = {
    setBackgroundMaterial() {
      if (++attempts === 1) throw new Error('failed');
    },
  };
  assert.throws(() => syncWindowsBackgroundMaterial(window, true));
  syncWindowsBackgroundMaterial(window, true);
  syncWindowsBackgroundMaterial(window, true);
  assert.equal(attempts, 2);
});
