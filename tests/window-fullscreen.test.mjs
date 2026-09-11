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

function windowsController() {
  const module = { exports: {} };
  runInNewContext(code, { module, process: { platform: 'win32' }, clearTimeout });
  let actual = false;
  const sent = [];
  const calls = [];
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => actual,
    setFullScreen(value) {
      calls.push(value);
      assert.ok(calls.length < 5, 'must not recursively request the same transition');
      nativeTransition(value);
    },
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (_channel, value) => sent.push(value),
    }),
  });
  function nativeTransition(value) {
    // Electron on Windows notifies BEFORE widget()->SetFullscreen(value).
    win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    actual = value;
  }
  const controller = module.exports.installWindowFullscreen(win);
  return { controller, calls, sent, nativeTransition };
}

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
  e.win.webContents.emit('did-finish-load');
  assert.equal(e.sent.at(-1), true);
  e.controller.set(false);
  e.expire();
  assert.equal(e.controller.get(), true);
  assert.equal(e.sent.at(-1), true);
  e.controller.set(false);
  e.win.emit('closed');
  assert.equal(e.controller.transitioning(), false);
});
