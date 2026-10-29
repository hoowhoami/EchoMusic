import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/main/applicationMenu.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

const load = (platform) => {
  const state = { menu: null };
  const windows = new Map();
  const electron = {
    app: { setName: () => {} },
    BrowserWindow: { fromWebContents: (contents) => windows.get(contents) ?? null },
    Menu: {
      buildFromTemplate: (template) => template,
      setApplicationMenu: (menu) => {
        state.menu = menu;
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    process: { platform },
    require(name) {
      if (name === 'electron') return electron;
      if (name === './storage/settings') return { getDevToolsEnabledSetting: () => false };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { api: module.exports, state, windows };
};

const pressKey = (contents, input) => {
  let prevented = false;
  contents.emit(
    'before-input-event',
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    { type: 'keyDown', control: false, meta: false, alt: false, shift: false, ...input },
  );
  return prevented;
};

test('macOS Window menu closes the focused window with Command+W', () => {
  const { api, state } = load('darwin');
  const closed = [];
  api.configureApplicationMenu({ closeWindow: (window) => closed.push(window) });
  const windowMenu = state.menu.find((item) => item.label === '窗口');
  const closeItem = windowMenu.submenu.find((item) => item.label === '关闭窗口');
  assert.equal(closeItem.accelerator, 'Command+W');

  const focusedWindow = {};
  closeItem.click(closeItem, focusedWindow);
  closeItem.click(closeItem, undefined);
  assert.deepEqual(closed, [focusedWindow]);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} closes the window that receives Ctrl+W`, () => {
    const { api, windows } = load(platform);
    const closed = [];
    const contents = new EventEmitter();
    const window = {};
    windows.set(contents, window);
    api.configureWebContentsShortcuts(contents, { closeWindow: (target) => closed.push(target) });

    assert.equal(pressKey(contents, { key: 'w', control: true }), true);
    assert.deepEqual(closed, [window]);
    assert.equal(pressKey(contents, { key: 'W', control: true, shift: true }), false);
    assert.equal(pressKey(contents, { key: 'w', control: true, alt: true }), false);
    assert.equal(pressKey(contents, { key: 'w' }), false);
    assert.deepEqual(closed, [window]);
  });
}

test('macOS leaves Ctrl+W to the page because Command+W comes from the menu', () => {
  const { api, windows } = load('darwin');
  const closed = [];
  const contents = new EventEmitter();
  windows.set(contents, {});
  api.configureWebContentsShortcuts(contents, { closeWindow: (target) => closed.push(target) });
  assert.equal(pressKey(contents, { key: 'w', control: true }), false);
  assert.equal(pressKey(contents, { key: 'w', meta: true }), false);
  assert.deepEqual(closed, []);
});
