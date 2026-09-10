import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/main/window/pointer.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
function setup(platform) {
  const win = new EventEmitter();
  const sent = [];
  const hooks = new Map();
  let stopped = 0;
  let callback;
  let destroyed = false;
  win.isDestroyed = () => destroyed;
  win.getNativeWindowHandle = () => Buffer.alloc(8);
  win.hookWindowMessage = (message, fn) => hooks.set(message, fn);
  win.webContents = {
    isDestroyed: () => destroyed,
    getZoomFactor: () => 2,
    getZoomLevel: () => 0,
    send: (...args) => sent.push(args),
  };
  const module = { exports: {} };
  const imports = {
    '../native/platform': {
      getNativeWindowPointer: () => ({
        startWindowPointerMonitor: (_handle, fn) => {
          callback = fn;
        },
        stopWindowPointerMonitor: () => {
          stopped++;
        },
      }),
    },
    '../logger': { default: { warn() {} } },
    '../../shared/window-zoom': { titleBarHeight: () => 92 },
  };
  new Function('require', 'module', 'exports', 'process', code)(
    (id) => imports[id],
    module,
    module.exports,
    { platform },
  );
  module.exports.installWindowPointerEvents(win);
  return {
    win,
    sent,
    hooks,
    notify: (point) => callback(null, point),
    destroy() {
      destroyed = true;
      win.emit('closed');
    },
    stopped: () => stopped,
  };
}

test('macOS forwards titlebar points in CSS pixels and ignores body clicks', () => {
  const s = setup('darwin');
  s.notify({ x: 1000, y: 40 });
  s.notify({ x: 1000, y: 200 });
  s.notify({ x: 1000, y: -1 });
  assert.deepEqual(s.sent, [['window:native-pointerdown', { x: 500, y: 20 }]]);
});

test('window teardown removes native monitor and ignores queued callbacks', () => {
  const s = setup('darwin');
  s.destroy();
  s.notify({ x: 50, y: 20 });
  s.win.emit('move');
  assert.equal(s.stopped(), 1);
  assert.equal(s.sent.length, 0);
  assert.equal(s.win.listenerCount('blur'), 0);
});

test('Windows observes caption clicks but not native controls or resize borders', () => {
  const s = setup('win32');
  const hit = Buffer.alloc(8);
  for (const value of [1, 8, 10, 20, 2]) {
    hit.writeUInt32LE(value);
    s.hooks.get(0x00a1)(hit);
  }
  assert.deepEqual(s.sent, [['window:native-pointerdown', undefined]]);
});

test('moving or blurring the window dismisses without native monitor support', () => {
  const s = setup('linux');
  s.win.emit('move');
  s.win.emit('blur');
  assert.equal(s.sent.length, 2);
});
