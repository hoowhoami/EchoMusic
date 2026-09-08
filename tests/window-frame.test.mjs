import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/renderer/utils/windowFrame.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
function setup() {
  const classes = new Set(),
    properties = new Map();
  let listener, resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const root = {
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      remove: (name) => classes.delete(name),
    },
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    document: { documentElement: root },
    window: {
      electron: {
        ipcRenderer: {
          on: (_channel, callback) => {
            listener = callback;
          },
          off: (_channel, callback) => {
            if (listener === callback) listener = null;
          },
          invoke: () => pending,
        },
      },
    },
  });
  const dispose = module.exports.installWindowFrame();
  return {
    classes,
    properties,
    dispose,
    resolve,
    emit: (state) => listener?.(state),
    listening: () => Boolean(listener),
  };
}

test('frame follows native window state and an old initial response cannot override an event', async () => {
  const env = setup();
  env.emit({ visible: false, radius: 8 });
  env.resolve({ visible: true, radius: 10 });
  await new Promise(setImmediate);
  assert.equal(env.classes.has('app-window-frame'), false);
  env.emit({ visible: true, radius: 8 });
  assert.equal(env.classes.has('app-window-frame'), true);
  assert.equal(env.properties.get('--app-window-frame-radius'), '8px');
  env.dispose();
  assert.equal(env.listening(), false);
  assert.equal(env.classes.size, 0);
});

test('unmount prevents a late initial response from restoring the frame', async () => {
  const env = setup();
  env.dispose();
  env.resolve({ visible: true, radius: 10 });
  await new Promise(setImmediate);
  assert.equal(env.classes.size, 0);
  assert.equal(env.properties.size, 0);
});

const mainCode = transformSync(
  readFileSync(new URL('../src/main/ipc/window.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`native frame state handles ${platform} platform APIs and window transitions`, () => {
    const handlers = new Map(),
      events = new Map(),
      sent = [];
    let maximized = false,
      fullscreen = false,
      snapped = false;
    const win = {
      isMaximized: () => maximized,
      isFullScreen: () => fullscreen,
      isDestroyed: () => false,
      on: (name, callback) => events.set(name, callback),
      webContents: { isDestroyed: () => false, send: (_channel, state) => sent.push(state) },
    };
    // macOS/Linux do not expose the Windows-only method at runtime.
    if (platform === 'win32') win.isSnapped = () => snapped;
    const module = { exports: {} };
    runInNewContext(mainCode, {
      module,
      process: { platform },
      require: (name) => {
        if (name === 'electron') return { BrowserWindow: { fromWebContents: () => win } };
        if (name === 'node:os') return { release: () => '10.0.22631' };
        if (name === './registry')
          return {
            ipcRegistry: {
              registerHandler: (channel, handler) => handlers.set(channel, handler),
              registerListener() {},
            },
          };
        return {};
      },
    });
    module.exports.registerWindowHandlers({ getMainWindow: () => win });
    const query = () => handlers.get('window:frame-state')({ sender: {} });
    assert.equal(query().visible, true);
    assert.equal(query().radius, platform === 'darwin' ? 10 : platform === 'win32' ? 8 : 0);
    maximized = true;
    events.get('maximize')();
    assert.equal(sent.at(-1).visible, false);
    maximized = false;
    events.get('unmaximize')();
    assert.equal(sent.at(-1).visible, true);
    fullscreen = true;
    events.get('enter-full-screen')();
    assert.equal(sent.at(-1).visible, false);
    fullscreen = false;
    if (platform === 'win32') {
      snapped = true;
      assert.equal(query().visible, false);
    }
  });
}
