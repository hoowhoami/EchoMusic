import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/main/window/modeController.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

const load = (mode = 'main') => {
  const events = [];
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    require(name) {
      if (name === '../miniPlayer') {
        return {
          closeMiniPlayerWindow: () => events.push('mini:close'),
          getMiniPlayerWindow: () => null,
          showMiniPlayerWindow: async () => events.push('mini:show'),
        };
      }
      if (name === './mode') {
        return { getActiveWindowMode: () => mode, setActiveWindowMode: () => {} };
      }
      if (name === './index') {
        return {
          hideMainWindowToBackground: () => events.push('main:hide'),
          showMainWindow: async () => events.push('main:show'),
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { api: module.exports, events };
};

const fakeWindow = (visible, focused) => ({
  isVisible: () => visible,
  isFocused: () => focused,
});

test('toggle hides the main window only when it is visible and focused', async () => {
  const { api, events } = load();
  await api.toggleMainWindow(fakeWindow(true, true));
  assert.deepEqual(events, ['main:hide']);
});

test('toggle raises a visible main window covered by other windows', async () => {
  const { api, events } = load();
  await api.toggleMainWindow(fakeWindow(true, false));
  assert.deepEqual(events, ['main:show']);
});

test('toggle shows a hidden main window', async () => {
  const { api, events } = load();
  await api.toggleMainWindow(fakeWindow(false, false));
  assert.deepEqual(events, ['main:show']);
});

test('toggle restores the mini player when it is the active window mode', async () => {
  const { api, events } = load('mini');
  await api.toggleMainWindow(fakeWindow(false, false));
  assert.deepEqual(events, ['mini:show']);
});
