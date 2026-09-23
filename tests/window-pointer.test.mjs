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
  let stopped = 0;
  let callback;
  let destroyed = false;
  let cursor = { x: 600, y: 120 };
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
    electron: { screen: { getCursorScreenPoint: () => cursor } },
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
  assert.deepEqual(s.sent, [
    ['window:native-pointerdown', undefined, { source: 'WM_NCLBUTTONDOWN', eventId: 1 }],
  ]);
});

const param = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(value);
  return buffer;
};

// Replace the wall clock so double-click timing is deterministic.
function makeClock() {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  return {
    advance: (ms) => {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

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

test('Windows transparent windows toggle emulated maximize on a caption double-click', async () => {
  let fullscreen = false;
  const s = setup('win32', { emulatedMaximize: true, isFullscreen: () => fullscreen });
  const calls = [];
  let maximized = false;
  s.win.isMaximized = () => maximized;
  s.win.maximize = () => {
    maximized = true;
    calls.push('maximize');
  };
  s.win.unmaximize = () => {
    maximized = false;
    calls.push('unmaximize');
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // No WS_CAPTION: the OS never produces SC_MAXIMIZE, only the non-client double-click.
  s.hooks.get(0x00a3)(param(2));
  await tick();
  s.hooks.get(0x00a3)(param(2));
  await tick();
  assert.deepEqual(calls, ['maximize', 'unmaximize']);
  // WCO caption buttons, resize borders and malformed parameters are not the drag region.
  for (const hit of [9, 8, 20, 1]) s.hooks.get(0x00a3)(param(hit));
  s.hooks.get(0x00a3)(Buffer.alloc(2));
  await tick();
  assert.deepEqual(calls, ['maximize', 'unmaximize']);
  fullscreen = true;
  s.hooks.get(0x00a3)(param(2));
  await tick();
  assert.deepEqual(calls, ['maximize', 'unmaximize']);
  fullscreen = false;
  s.hooks.get(0x0112)(param(0xf030));
  await tick();
  assert.deepEqual(calls, ['maximize', 'unmaximize'], 'system commands are only observed');
  assert.equal(s.sent.length, 1, 'popup dismissal is unchanged');
  s.destroy();
  s.hooks.get(0x00a3)(param(2));
  await tick();
  assert.deepEqual(calls, ['maximize', 'unmaximize']);
});

test('Windows opaque windows leave caption double-clicks to the OS', async () => {
  const s = setup('win32');
  let maximizeCalls = 0;
  s.win.isMaximized = () => false;
  s.win.maximize = () => maximizeCalls++;
  assert.equal(s.hooks.has(0x00a3), false);
  s.hooks.get(0x0112)(param(0xf030));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximizeCalls, 0);
});

test('moving or blurring the window dismisses without native monitor support', () => {
  const s = setup('linux');
  s.win.emit('move');
  s.win.emit('blur');
  assert.equal(s.sent.length, 2);
});

test('Windows transparent windows toggle on a paired client double-click', async () => {
  const clock = makeClock();
  try {
    let fullscreen = false;
    const s = setup('win32', { emulatedMaximize: true, isFullscreen: () => fullscreen });
    const calls = [];
    // isMaximized() is unreliable for emulated windows: it compares bounds to the
    // work area and can disagree with the visible state. The toggle must track state.
    s.win.isMaximized = () => false;
    s.win.maximize = () => calls.push('maximize');
    s.win.unmaximize = () => calls.push('unmaximize');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    // First press arms the window; the second within GetDoubleClickTime toggles once.
    s.hooks.get(0x0201)();
    clock.advance(140);
    s.hooks.get(0x0210)(param(0x0201));
    await tick();
    assert.deepEqual(calls, ['maximize']);
    assert.equal(s.sent.length, 1, 'the paired press does not notify the renderer again');
    // Toggling back uses the tracked state even though isMaximized() still reports false.
    clock.advance(140);
    s.hooks.get(0x0201)();
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, ['maximize', 'unmaximize']);
    // Fullscreen gates the second toggle.
    fullscreen = true;
    clock.advance(140);
    s.hooks.get(0x0201)();
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, ['maximize', 'unmaximize']);
  } finally {
    clock.restore();
  }
});

test('Windows client double-click pairing requires a stable cursor and a fresh window', async () => {
  const clock = makeClock();
  try {
    const s = setup('win32', { emulatedMaximize: true });
    const calls = [];
    s.win.maximize = () => calls.push('maximize');
    s.win.unmaximize = () => calls.push('unmaximize');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    // A press that moved between down events is a drag, not a double-click.
    s.hooks.get(0x0201)();
    s.setCursor({ x: 640, y: 120 });
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(s.sent.length, 2);
    // A press outside the titlebar clears the pending pair.
    s.setCursor({ x: 600, y: 120 });
    clock.advance(140);
    s.hooks.get(0x0201)();
    s.setCursor({ x: 600, y: 300 });
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(s.sent.length, 3);
    // Window move/blur clears the pair too (and the move itself sends a dismissal).
    s.setCursor({ x: 600, y: 120 });
    clock.advance(140);
    s.hooks.get(0x0201)();
    s.win.emit('move');
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(s.sent.length, 6);
  } finally {
    clock.restore();
  }
});

test('Windows client presses beyond the double-click window never pair', async () => {
  const clock = makeClock();
  try {
    const s = setup('win32', { emulatedMaximize: true });
    const calls = [];
    s.win.maximize = () => calls.push('maximize');
    s.win.unmaximize = () => calls.push('unmaximize');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    s.hooks.get(0x0201)();
    clock.advance(700);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(s.sent.length, 2);
  } finally {
    clock.restore();
  }
});

test('Windows same-press duplicates from multiple hooks do not create a double-click', async () => {
  const clock = makeClock();
  try {
    const s = setup('win32', { emulatedMaximize: true });
    const calls = [];
    s.win.isMaximized = () => false;
    s.win.maximize = () => calls.push('maximize');
    s.win.unmaximize = () => calls.push('unmaximize');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    // The same physical press can arrive as both a client and a PARENTNOTIFY message.
    s.hooks.get(0x0201)();
    clock.advance(5);
    s.hooks.get(0x0210)(param(0x0201));
    clock.advance(5);
    s.hooks.get(0x0210)(param(0x0201));
    assert.equal(s.sent.length, 1, 'duplicate reports of one press notify once');
    // A real second press later still pairs against the first press.
    clock.advance(120);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, ['maximize']);
    assert.equal(s.sent.length, 1);
  } finally {
    clock.restore();
  }
});

test('Windows right-button presses clear the armed double-click', async () => {
  const clock = makeClock();
  try {
    const s = setup('win32', { emulatedMaximize: true });
    const calls = [];
    s.win.maximize = () => calls.push('maximize');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    s.hooks.get(0x0201)();
    clock.advance(140);
    s.hooks.get(0x0204)();
    clock.advance(140);
    s.hooks.get(0x0201)();
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(s.sent.length, 3);
  } finally {
    clock.restore();
  }
});

test('Windows opaque windows never toggle from client presses', async () => {
  const clock = makeClock();
  try {
    const s = setup('win32');
    let maximizeCalls = 0;
    s.win.maximize = () => maximizeCalls++;
    s.hooks.get(0x0201)();
    clock.advance(120);
    s.hooks.get(0x0201)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(maximizeCalls, 0);
    assert.equal(s.sent.length, 2, 'both presses still notify');
  } finally {
    clock.restore();
  }
});
