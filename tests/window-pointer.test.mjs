import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/main/window/pointer.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
function setup(platform, options) {
  const win = new EventEmitter();
  const sent = [];
  const hooks = new Map();
  let startCount = 0;
  let stopCount = 0;
  let pointerCallback;
  let dblclickCallback;
  let destroyed = false;
  let cursor = { x: 600, y: 120 };
  let dipCalls = 0;
  let totalDblclick = 0;
  const logs = [];
  win.id = 1;
  win.getContentBounds = () => ({ x: 100, y: 100, width: 1000, height: 700 });
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
    electron: {
      screen: {
        getCursorScreenPoint: () => cursor,
        screenToDipPoint: (point) => {
          dipCalls++;
          return { x: point.x, y: point.y };
        },
      },
    },
    '../native/platform': {
      getNativeWindowPointer: () => ({
        startWindowPointerMonitor: (_handle, fn) => {
          pointerCallback = fn;
        },
        stopWindowPointerMonitor: () => {
          stopCount++;
        },
      }),
      getWindowsDoubleClickMonitor: () => ({
        startWindowsDoubleClickMonitor: (_handle, fn) => {
          dblclickCallback = fn;
          startCount++;
        },
        stopWindowsDoubleClickMonitor: () => {
          stopCount++;
        },
        getWindowsDoubleClickDiagnostics: () => ({
          installed: true,
          totalDblclick,
          foregroundDblclick: totalDblclick,
        }),
      }),
    },
    '../logger': {
      __esModule: true,
      default: { warn() {}, info: (...args) => logs.push(args), debug() {} },
    },
    '../../shared/windowZoom': { titleBarHeight: () => 92 },
  };
  new Function('require', 'module', 'exports', 'process', code)(
    (id) => imports[id],
    module,
    module.exports,
    { platform },
  );
  module.exports.installWindowPointerEvents(win, options);
  return {
    win,
    sent,
    hooks,
    logs,
    setCursor: (point) => {
      cursor = point;
    },
    notify: (point) => pointerCallback(null, point),
    dblclick: (point) => {
      totalDblclick++;
      dblclickCallback(null, point);
    },
    started: () => startCount,
    stopped: () => stopCount,
    dipCalls: () => dipCalls,
    destroy() {
      destroyed = true;
      win.emit('closed');
    },
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
  assert.deepEqual(s.sent, [
    ['window:native-pointerdown', undefined, { source: 'WM_NCLBUTTONDOWN', eventId: 1 }],
  ]);
});

const param = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(value);
  return buffer;
};

test('Windows client clicks use content-relative CSS coordinates and filter body/borders', () => {
  const s = setup('win32');
  s.hooks.get(0x0201)();
  assert.deepEqual(s.sent[0], [
    'window:native-pointerdown',
    { x: 250, y: 10 },
    { source: 'WM_LBUTTONDOWN', eventId: 1 },
  ]);
  for (const point of [
    { x: 600, y: 300 },
    { x: 99, y: 120 },
    { x: 1100, y: 120 },
    { x: 600, y: 99 },
  ]) {
    s.setCursor(point);
    s.hooks.get(0x0204)();
  }
  assert.equal(s.sent.length, 1);
  assert.equal(s.logs[0][1].decision, 'ready');
  assert.equal(s.logs[1][1].eventId, s.sent[0][2].eventId);
});

test('Windows child notifications filter event type and support negative monitor origins', () => {
  const s = setup('win32');
  s.win.getContentBounds = () => ({ x: -1600, y: -200, width: 1000, height: 700 });
  s.setCursor({ x: -1000, y: -160 });
  s.hooks.get(0x0210)(param(0x12340201));
  assert.deepEqual(s.sent[0], [
    'window:native-pointerdown',
    { x: 300, y: 20 },
    { source: 'WM_PARENTNOTIFY', eventId: 1 },
  ]);
  for (const value of [1, 2, 0x200]) s.hooks.get(0x0210)(param(value));
  assert.equal(s.sent.length, 1);
});

test('Windows system move/maximize/restore commands dismiss and unrelated commands do not', () => {
  const s = setup('win32');
  for (const value of [0xf012, 0xf030, 0xf120, 0xf100, 0xf060]) s.hooks.get(0x0112)(param(value));
  assert.equal(s.sent.length, 3);
  assert.deepEqual(
    s.sent.map((event) => event[2].eventId),
    [1, 2, 3],
  );
  assert.ok(s.sent.every((event) => event[1] === undefined && event[2].source === 'WM_SYSCOMMAND'));
});

test('Windows ignores malformed parameters and callbacks after window destruction', () => {
  const s = setup('win32');
  for (const message of [0x00a1, 0x0210, 0x0112]) s.hooks.get(message)(Buffer.alloc(2));
  assert.equal(s.sent.length, 0);
  s.destroy();
  s.hooks.get(0x0201)();
  s.hooks.get(0x00a1)(param(2));
  s.hooks.get(0x0210)(param(0x201));
  s.hooks.get(0x0112)(param(0xf012));
  assert.equal(s.sent.length, 0);
});

test('Windows native double-click forwards CSS points to the renderer', () => {
  const s = setup('win32', { emulatedMaximize: true });
  assert.equal(s.started(), 1);
  assert.equal(
    s.logs.some((args) => args[1]?.decision === 'installed'),
    true,
  );
  s.dblclick({ x: 1000, y: 140 });
  assert.equal(s.dipCalls(), 1, 'physical hook pixels convert through screenToDipPoint');
  assert.deepEqual(s.sent, [
    ['window:native-dblclick', { x: 450, y: 20 }, { source: 'WM_LBUTTONDBLCLK', eventId: 1 }],
  ]);
  const forwardLog = s.logs.find((args) => args[1]?.decision === 'forward-dblclick');
  assert.equal(forwardLog[1].totalDblclick, 1, 'hook counters travel with the report');
  // A later single-click notification shares the same sequence.
  s.hooks.get(0x0201)();
  assert.equal(s.sent[1][0], 'window:native-pointerdown');
  assert.equal(s.sent[1][2].eventId, 2);
});

test('Windows native double-click filters to the titlebar band', () => {
  const s = setup('win32', { emulatedMaximize: true });
  for (const point of [
    { x: 1000, y: 600 }, // body click below the band
    { x: 99, y: 140 }, // left edge
    { x: 1100, y: 140 }, // right edge
    { x: 1000, y: 99 }, // above the band after the content offset
    { x: 1000, y: 193 }, // one pixel past the 92px band
  ]) {
    s.dblclick(point);
  }
  assert.equal(s.sent.length, 0);
  s.dblclick({ x: 1000, y: 150 });
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0][1], { x: 450, y: 25 });
});

test('Windows native double-click ignores fullscreen windows', () => {
  let fullscreen = false;
  const s = setup('win32', { emulatedMaximize: true, isFullscreen: () => fullscreen });
  fullscreen = true;
  s.dblclick({ x: 1000, y: 140 });
  assert.equal(s.sent.length, 0);
  assert.equal(s.logs.at(-1)?.[1]?.decision, 'ignored-maximize-while-fullscreen');
});

test('Windows teardown stops the native monitor and drops late callbacks', () => {
  const s = setup('win32', { emulatedMaximize: true });
  s.destroy();
  s.dblclick({ x: 1000, y: 140 });
  assert.equal(s.sent.length, 0);
  assert.equal(s.stopped(), 1);
  assert.equal(s.win.listenerCount('blur'), 0);
});

test('Windows opaque windows leave double-clicks to the OS', () => {
  const s = setup('win32');
  let maximizeCalls = 0;
  s.win.maximize = () => maximizeCalls++;
  assert.equal(s.started(), 0, 'no native monitor without emulated maximize');
  assert.equal(s.hooks.has(0x00a3), false, 'the system caption is left untouched');
  s.hooks.get(0x0201)();
  s.hooks.get(0x0201)();
  assert.equal(maximizeCalls, 0);
  assert.equal(s.sent.length, 2, 'both presses still notify');
});

test('moving or blurring the window dismisses without native monitor support', () => {
  const s = setup('linux');
  s.win.emit('move');
  s.win.emit('blur');
  assert.equal(s.sent.length, 2);
});
