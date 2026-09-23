import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { EventEmitter } from 'node:events';

const code = transformSync(
  readFileSync(new URL('../src/main/window/fullscreen.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

function setup(platform) {
  const module = { exports: {} };
  runInNewContext(code, { module, process: { platform } });
  let listener;
  let fullscreen = false;
  let prevented = 0;
  const transitions = [];
  const sent = [];
  const webContents = Object.assign(new EventEmitter(), {
    send: (channel) => sent.push(channel),
  });
  webContents.on('newListener', (name, handler) => {
    if (name === 'before-input-event') listener = handler;
  });
  module.exports.installWindowFullscreenShortcut({
    webContents,
    isFullScreen: () => fullscreen,
    setFullScreen: (value) => {
      fullscreen = value;
      transitions.push(value);
    },
  });
  return {
    transitions,
    sent,
    webContents,
    get prevented() {
      return prevented;
    },
    get installed() {
      return Boolean(listener);
    },
    send(input = {}) {
      listener?.(
        { preventDefault: () => prevented++ },
        { type: 'keyDown', key: 'F11', isAutoRepeat: false, ...input },
      );
    },
  };
}

for (const platform of ['win32', 'linux']) {
  test(`${platform}: F11 enters and exits fullscreen without toggling on repeat`, () => {
    const window = setup(platform);
    window.send();
    window.send({ isAutoRepeat: true });
    window.send({ type: 'keyUp' });
    assert.deepEqual(window.transitions, [true]);
    window.send();
    assert.deepEqual(window.transitions, [true, false]);
    assert.equal(window.prevented, 3);
  });

  test(`${platform}: modified F11 and other keys remain available`, () => {
    const window = setup(platform);
    for (const modifier of ['control', 'meta', 'alt', 'shift']) {
      window.send({ [modifier]: true });
    }
    window.send({ key: 'F12' });
    window.send({ key: '=' });
    assert.deepEqual(window.transitions, []);
    assert.equal(window.prevented, 0);
  });

  test(`${platform}: F11 exits HTML fullscreen before changing the native window`, () => {
    const window = setup(platform);
    window.webContents.emit('enter-html-full-screen');
    window.send();
    window.send({ isAutoRepeat: true });
    assert.deepEqual(window.sent, ['window:exit-html-fullscreen']);
    assert.deepEqual(window.transitions, []);
    window.webContents.emit('leave-html-full-screen');
    window.send();
    assert.deepEqual(window.transitions, [true]);
  });

  test(`${platform}: leaving a video preserves a pre-existing native fullscreen session`, () => {
    const window = setup(platform);
    window.send();
    window.webContents.emit('enter-html-full-screen');
    window.send();
    assert.deepEqual(window.sent, ['window:exit-html-fullscreen']);
    assert.deepEqual(window.transitions, [true]);
    window.webContents.emit('leave-html-full-screen');
    window.send();
    assert.deepEqual(window.transitions, [true, false]);
  });
}

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const NORMAL = { x: 100, y: 80, width: 1200, height: 800 };
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key]);

function windowsController(options, initial = {}) {
  const module = { exports: {} };
  runInNewContext(code, { module, process: { platform: 'win32' }, clearTimeout, setImmediate });
  let actual = false;
  const sent = [];
  const details = [];
  const calls = [];
  const maximizable = [];
  const minimizable = [];
  const emulated = options?.emulated === true;
  // Electron's transparent-window emulation: one restore rectangle shared by
  // Maximize() and SetFullScreen(), and "maximized" means bounds == work area.
  let bounds = initial.maximized ? { ...WORK_AREA } : { ...NORMAL };
  let restoreBounds = { ...NORMAL };
  let maximized = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => actual,
    isMaximized: () => (emulated ? sameRect(bounds, WORK_AREA) : maximized),
    getBounds: () => bounds,
    getNormalBounds: () => (emulated ? restoreBounds : bounds),
    setBounds(value) {
      bounds = { ...value };
    },
    maximize() {
      if (emulated) {
        restoreBounds = bounds;
        bounds = { ...WORK_AREA };
      } else maximized = true;
      win.emit('maximize');
    },
    setMaximizable: (value) => maximizable.push(value),
    setMinimizable: (value) => minimizable.push(value),
    setFullScreen(value) {
      calls.push(value);
      assert.ok(calls.length < 5, 'must not recursively request the same transition');
      nativeTransition(value);
    },
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (_channel, value, detail) => {
        sent.push(value);
        details.push(detail);
      },
    }),
  });
  function nativeTransition(value) {
    // Electron on Windows notifies BEFORE widget()->SetFullscreen(value).
    win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    if (!emulated) {
      actual = value;
      return;
    }
    // Transparent windows only get SetBounds: the widget never reports fullscreen.
    if (value) {
      restoreBounds = bounds;
      bounds = { ...DISPLAY };
    } else bounds = restoreBounds;
  }
  const controller = module.exports.installWindowFullscreen(win, options);
  return {
    win,
    controller,
    calls,
    sent,
    details,
    maximizable,
    minimizable,
    nativeTransition,
    bounds: () => bounds,
    normalBounds: () => restoreBounds,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('Windows transparent windows leave fullscreen back to the maximized state they entered from', async () => {
  const e = windowsController({ emulated: true }, { maximized: true });
  assert.equal(e.win.isMaximized(), true);
  e.controller.set(true);
  assert.deepEqual(e.maximizable, [false], 'hide the maximize button while fullscreen');
  assert.deepEqual(e.minimizable, [false], 'hide the minimize button like real fullscreen');
  assert.deepEqual(e.bounds(), DISPLAY);
  e.controller.set(false);
  assert.equal(e.controller.get(), false);
  await e.settle();
  assert.deepEqual(e.maximizable, [false, true]);
  assert.deepEqual(e.minimizable, [false, true]);
  assert.equal(e.win.isMaximized(), true);
  assert.deepEqual(e.normalBounds(), NORMAL, 'restore keeps the pre-maximize rectangle');
});

test('Windows transparent windows leave fullscreen back to their normal bounds', async () => {
  const e = windowsController({ emulated: true });
  e.controller.set(true);
  e.controller.set(false);
  await e.settle();
  assert.equal(e.win.isMaximized(), false);
  assert.deepEqual(e.bounds(), NORMAL);
  assert.deepEqual(e.maximizable, [false, true]);
});

test('Windows transparent windows keep app fullscreen across a nested HTML fullscreen video', async () => {
  const e = windowsController({ emulated: true }, { maximized: true });
  e.controller.set(true);
  const published = e.sent.length;
  // Chromium cannot see emulated fullscreen, so a video re-enters and leaves it natively.
  e.nativeTransition(true);
  e.nativeTransition(false);
  await e.settle();
  assert.equal(e.controller.get(), true);
  assert.equal(e.sent.length, published, 'nested transitions publish nothing');
  assert.deepEqual(e.bounds(), DISPLAY);
  assert.deepEqual(e.maximizable, [false]);
  e.controller.set(false);
  await e.settle();
  assert.equal(e.controller.get(), false);
  assert.equal(e.win.isMaximized(), true);
  assert.deepEqual(e.normalBounds(), NORMAL);
});

test('Windows opaque windows never touch maximizable or bounds around fullscreen', async () => {
  const e = windowsController();
  e.controller.set(true);
  e.controller.set(false);
  await e.settle();
  assert.deepEqual(e.maximizable, []);
  assert.deepEqual(e.minimizable, []);
  assert.deepEqual(e.bounds(), NORMAL);
});

test('Windows transparent windows track emulated fullscreen from Electron notifications', () => {
  const e = windowsController({ emulated: true });
  e.controller.set(true);
  assert.equal(e.controller.get(), true, 'isFullScreen() stays false for emulated fullscreen');
  assert.equal(e.details.at(-1)?.nativeControls, true);
  e.controller.set(true);
  assert.deepEqual(e.calls, [true], 'a repeated request must not re-enter fullscreen');
  e.controller.set(false);
  assert.equal(e.controller.get(), false);
  assert.deepEqual(e.calls, [true, false]);
  // Request and Electron's notification both publish, like the opaque path.
  assert.equal(e.sent.at(-1), false);
  assert.ok(e.sent.every((value) => typeof value === 'boolean'));
});

test('Windows opaque windows report hidden native controls while fullscreen', () => {
  const e = windowsController();
  e.controller.set(true);
  assert.equal(e.details.at(-1)?.nativeControls, false);
});

test('Windows: video entry and Escape exit publish the event state, not the old native state', () => {
  const e = windowsController();
  e.nativeTransition(true);
  assert.equal(e.sent.at(-1), true);
  e.nativeTransition(false);
  assert.equal(e.sent.at(-1), false);
  assert.equal(e.controller.get(), false);
  assert.deepEqual(e.calls, []);
});

test('Windows: app fullscreen requests never recurse inside early native notifications', () => {
  const e = windowsController();
  e.controller.set(true);
  assert.equal(e.sent.at(-1), true);
  e.controller.set(false);
  assert.equal(e.sent.at(-1), false);
  assert.deepEqual(e.calls, [true, false]);
});

test('macOS keeps its native fullscreen entry', () => {
  assert.equal(setup('darwin').installed, false);
});

function macController() {
  const module = { exports: {} };
  let timeout;
  runInNewContext(code, {
    module,
    process: { platform: 'darwin' },
    setTimeout: (callback) => {
      timeout = callback;
      return 1;
    },
    clearTimeout: () => {
      timeout = undefined;
    },
  });
  const calls = [],
    sent = [];
  let actual = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => actual,
    setFullScreen: (value) => calls.push(value),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (_channel, value) => sent.push(value),
    }),
  });
  const controller = module.exports.installWindowFullscreen(win);
  return {
    win,
    controller,
    calls,
    sent,
    expire: () => timeout?.(),
    settle(value) {
      actual = value;
      win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    },
  };
}
test('macOS serializes opposite requests until AppKit completes each animation', () => {
  const e = macController();
  e.controller.set(true);
  assert.equal(e.controller.get(), true);
  e.controller.set(false);
  assert.deepEqual(e.calls, [true]);
  assert.equal(e.controller.transitioning(), true);
  e.settle(true);
  assert.deepEqual(e.calls, [true, false]);
  e.settle(false);
  assert.equal(e.controller.transitioning(), false);
  assert.equal(e.controller.get(), false);
});
test('native traffic lights, reload, timeout and closing reconcile fullscreen state', () => {
  const e = macController();
  e.settle(true);
  assert.equal(e.sent.at(-1), true);
  e.win.webContents.emit('did-finish-load', { sender: e.win.webContents });
  assert.equal(e.sent.at(-1), true);
  e.controller.set(false);
  e.expire();
  assert.equal(e.controller.get(), true);
  assert.equal(e.sent.at(-1), true);
  e.controller.set(false);
  e.win.emit('closed');
  assert.equal(e.controller.transitioning(), false);
});
