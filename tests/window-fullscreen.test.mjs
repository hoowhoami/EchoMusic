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
  module.exports.installWindowFullscreenShortcut({
    webContents: {
      on: (name, handler) => {
        assert.equal(name, 'before-input-event');
        listener = handler;
      },
    },
    isFullScreen: () => fullscreen,
    setFullScreen: (value) => {
      fullscreen = value;
      transitions.push(value);
    },
  });
  return {
    transitions,
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
}

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
