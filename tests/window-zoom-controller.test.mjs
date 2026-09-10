import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
const compile = (file) =>
  transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const model = { exports: {} };
runInNewContext(compile('../src/shared/window-zoom.ts'), { module: model });
function setup() {
  const module = { exports: {} },
    handlers = new Map(),
    events = new Map();
  const saved = { windowZoomLevel: 2 },
    writes = [],
    sent = [],
    applied = [];
  runInNewContext(compile('../src/main/window/zoom.ts'), {
    module,
    process: { platform: 'win32' },
    require(name) {
      if (name === '../../shared/window-zoom') return model.exports;
      if (name === '../storage/settings')
        return {
          getMainAppSettings: () => saved,
          setMainAppSetting: (key, value) => {
            saved[key] = value;
            writes.push(value);
          },
        };
      if (name === '../ipc/registry')
        return { ipcRegistry: { registerHandler: (name, fn) => handlers.set(name, fn) } };
      throw new Error(name);
    },
  });
  const win = {
    webContents: {
      mainFrame: {},
      on: (name, fn) => events.set(name, fn),
      setZoomLevel: (value) => applied.push(value),
      setVisualZoomLevelLimits: async () => {},
      send: (name, value) => sent.push([name, value]),
    },
  };
  const controller = module.exports.installWindowZoom(win, () => {});
  module.exports.registerWindowZoomHandlers(
    () => win,
    () => controller,
  );
  return { win, controller, saved, writes, events, applied, handlers, sent };
}
test('zoom restores on every renderer reload and writes only on changes', () => {
  const e = setup();
  e.events.get('did-finish-load')();
  assert.deepEqual(e.applied, [2]);
  e.controller.set(3);
  e.controller.set(3);
  e.events.get('did-finish-load')();
  assert.equal(e.applied.at(-1), 3);
  assert.deepEqual(e.writes, [3]);
  assert.equal(e.saved.windowZoomLevel, 3);
  assert.throws(() => e.controller.set('4'));
  assert.throws(() => e.controller.set(Infinity));
});
test('rapid native shortcuts update the authoritative value and reset persists', () => {
  const e = setup();
  let prevented = 0;
  const input = { type: 'keyDown', key: '=', control: true, meta: false, alt: false };
  const send = (key) =>
    e.events.get('before-input-event')(
      {
        preventDefault() {
          prevented++;
        },
      },
      { ...input, key },
    );
  send('=');
  send('=');
  send('-');
  assert.equal(e.controller.get(), 3);
  send('0');
  assert.equal(e.controller.get(), 0);
  assert.equal(e.saved.windowZoomLevel, 0);
  assert.equal(prevented, 4);
});
test('zoom IPC rejects auxiliary renderers and subframes', () => {
  const e = setup();
  const invoke = e.handlers.get('window:zoom-set');
  assert.throws(() => invoke({ sender: {}, senderFrame: e.win.webContents.mainFrame }, 5));
  assert.throws(() => invoke({ sender: e.win.webContents, senderFrame: {} }, 5));
  assert.equal(
    invoke({ sender: e.win.webContents, senderFrame: e.win.webContents.mainFrame }, 5),
    5,
  );
});
for (const platform of ['linux', 'darwin'])
  test(`${platform} native control reservation is zoom-aware and clears in fullscreen`, () => {
    const code = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8').split(
      '// Native titlebar geometry',
    )[1];
    const properties = new Map(),
      handlers = new Map();
    let factor = 1;
    let left = 0;
    let right = 138;
    const overlay = {
      visible: true,
      getTitlebarAreaRect: () => ({ x: left / factor, width: (1000 - left - right) / factor }),
      addEventListener: (name, fn) => handlers.set(name, fn),
    };
    const win = { innerWidth: 1000, addEventListener: (name, fn) => handlers.set(name, fn) };
    runInNewContext(
      transformSync('// Native titlebar geometry' + code, { loader: 'ts', format: 'cjs' }).code,
      {
        process: { platform },
        navigator: { windowControlsOverlay: overlay },
        window: win,
        document: {
          documentElement: { style: { setProperty: (name, value) => properties.set(name, value) } },
        },
        webFrame: { getZoomFactor: () => factor },
        ipcRenderer: { on: (name, fn) => handlers.set(name, fn) },
      },
    );
    handlers.get('DOMContentLoaded')();
    assert.equal(properties.get('--window-controls-inset'), '138px');
    factor = 2;
    win.innerWidth = 500;
    handlers.get('geometrychange')();
    assert.equal(properties.get('--window-controls-inset'), '69px');
    left = 138;
    right = 0;
    handlers.get('geometrychange')();
    assert.equal(properties.get('--window-controls-left-inset'), '69px');
    assert.equal(properties.get('--window-controls-inset'), '0px');
    right = 92;
    handlers.get('geometrychange')();
    assert.equal(properties.get('--window-controls-left-inset'), '69px');
    assert.equal(properties.get('--window-controls-inset'), '46px');
    overlay.visible = false;
    handlers.get('geometrychange')();
    assert.equal(properties.get('--window-controls-inset'), '0px');
    if (platform === 'darwin') {
      assert.equal(properties.get('--window-controls-left-inset'), '40px');
      assert.equal(properties.get('--window-controls-left-height'), '23px');
    }
    handlers.get('window:fullscreen-changed')(null, true);
    assert.equal(properties.get('--window-controls-left-inset'), '0px');
    assert.equal(properties.get('--window-controls-left-height'), '0px');
    handlers.get('window:fullscreen-changed')(null, false);
    if (platform === 'darwin') assert.equal(properties.get('--window-controls-left-inset'), '40px');
  });
