import * as throttling from '../src/main/windowBackgroundThrottling.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { join } from 'node:path';
const load = (file, mocks, extras = {}) => {
  const module = { exports: {} };
  runInNewContext(
    transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
    {
      module,
      Buffer,
      process: { platform: 'win32', env: {} },
      __dirname: '/test',
      setTimeout,
      clearTimeout,
      require: (id) => {
        assert.ok(id in mocks, id);
        return mocks[id];
      },
      ...extras,
    },
  );
  return module.exports;
};
const shared = load('../src/shared/taskbar.ts', {});
// 歌词是任务栏的子窗口，left/right 已经是相对任务栏客户区的偏移。
const layout = () => ({
  left: { x: 0, y: 0, width: 600, height: 48 },
  right: { x: 1300, y: 0, width: 400, height: 48 },
  scaleFactor: 1,
  centered: true,
  isDark: true,
  available: true,
});
function setup({
  page = async () => {},
  available = true,
  autoReady = true,
  mountedTaskbar: initialTaskbar = 0,
} = {}) {
  let mountedTaskbar = initialTaskbar;
  const scheduled = new Map();
  let timerId = 0;
  let clockNow = 1_000_000;
  const logs = [];
  const intervals = new Set();
  let isBarAvailable;
  const windows = [],
    sessions = [],
    handlers = new Map(),
    listeners = new Map(),
    settings = {
      taskbarLyric: { ...shared.DEFAULT_TASKBAR_LYRIC_SETTINGS },
      taskbarPlayerEnabled: false,
    };
  const main = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => false,
    webContents: { id: 1, send() {} },
  });
  const theme = Object.assign(new EventEmitter(), {
    shouldUseDarkColorsForSystemIntegratedUI: true,
  });
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ bounds: { width: 1920, height: 1080 } }),
  });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.throttled = options.webPreferences.backgroundThrottling;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.visible = false;
      this.dead = false;
      this.nativeDead = false;
      this.hooks = new Map();
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length + 2,
        setWindowOpenHandler() {},
        isDestroyed: () => this.dead,
        setBackgroundThrottling: (value) => {
          this.throttled = value;
        },
        send: (...args) => this.sent.push(args),
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.dead;
    }
    isMinimized() {
      return false;
    }
    isVisible() {
      assert.equal(this.nativeDead, false, 'native host must be alive');
      return this.visible;
    }
    getBounds() {
      assert.equal(this.nativeDead, false, 'native host must be alive');
      return this.bounds;
    }
    setBounds(b) {
      this.bounds = { ...b };
    }
    setShape(shape) {
      this.shape = shape;
    }
    showInactive() {
      this.visible = true;
      this.emit('show');
    }
    hide() {
      this.visible = false;
      this.emit('hide');
    }
    getNativeWindowHandle() {
      const h = Buffer.alloc(8);
      h.writeBigUInt64LE(BigInt(this.webContents.id));
      return h;
    }
    hookWindowMessage(message, callback) {
      this.hooks.set(message, callback);
    }
    destroy() {
      this.nativeDead = true;
      this.hooks.get(0x0002)?.();
      this.dead = true;
      this.visible = false;
      this.emit('closed');
    }
    async loadFile() {
      await page(this);
      if (autoReady && !this.dead) this.emit('ready-to-show');
    }
  }
  class Session {
    constructor(handle, width, callback) {
      this.handle = handle;
      this.width = width;
      this.callback = callback;
      this.stopped = false;
      sessions.push(this);
    }
    update(width) {
      this.width = width;
      this.updates = (this.updates || 0) + 1;
    }
    stop() {
      this.stopped = true;
    }
    emit(value = layout()) {
      this.callback(value);
    }
  }
  const api = load(
    '../src/main/taskbarMediaBar.ts',
    {
      electron: {
        BrowserWindow: Window,
        Menu: { buildFromTemplate: () => ({ popup() {} }) },
        nativeTheme: theme,
        screen,
      },
      'node:path': { join },
      './ipc/registry': {
        ipcRegistry: {
          registerHandler: (key, fn) => handlers.set(key, fn),
          registerListener: (key, fn) => listeners.set(key, fn),
        },
      },
      './window': { getMainWindow: () => main, showMainWindow() {} },
      './storage/settings': {
        getMainAppSettings: () => settings,
        setMainAppSetting: (key, value) => (settings[key] = value),
      },
      './native/platform': {
        getNativeTaskbarLyric: () =>
          available
            ? {
                TaskbarLyricSession: Session,
                taskbarLyricMountedTaskbar: () => mountedTaskbar,
              }
            : null,
      },
      './windowBackgroundThrottling': throttling,
      './nowPlaying': {
        bindVisibleNowPlayingWindow(_win, available) {
          isBarAvailable = available;
        },
      },
      '../shared/taskbar': shared,
      './logger': {
        __esModule: true,
        default: {
          error(...args) {
            logs.push(args);
          },
          warn(...args) {
            logs.push(args);
          },
        },
      },
    },
    {
      setTimeout: (fn) => {
        scheduled.set(++timerId, fn);
        return timerId;
      },
      clearTimeout: (id) => scheduled.delete(id),
      // 心跳是常驻定时器：真实 setInterval 会自我重复，这里记录 fn 以便反复触发。
      setInterval: (fn) => {
        intervals.add(fn);
        return fn;
      },
      clearInterval: (fn) => intervals.delete(fn),
      Date: { now: () => clockNow },
      log: { error() {}, warn() {} },
    },
  );
  api.registerTaskbarPlayerHandlers();
  const runScheduled = () => {
    const tasks = Array.from(scheduled.values());
    scheduled.clear();
    tasks.forEach((fn) => fn());
  };
  return {
    api,
    windows,
    sessions,
    handlers,
    listeners,
    settings,
    screen,
    theme,
    main,
    isBarAvailable: () => isBarAvailable?.(),
    advanceClock: (ms) => {
      clockNow += ms;
    },
    setMountedTaskbar: (value) => {
      mountedTaskbar = value;
    },
    runScheduled,
    logs,
    // 心跳是常驻定时器，与一次性任务队列分开驱动。
    runHeartbeat: (ticks = 1) => {
      for (let i = 0; i < ticks; i += 1) {
        for (const fn of Array.from(intervals)) fn();
        runScheduled();
      }
    },
  };
}
test('concurrent enable creates one hidden window, then shows only after a valid native layout', async () => {
  const f = setup();
  await Promise.all([f.api.setTaskbarPlayerEnabled(true), f.api.setTaskbarPlayerEnabled(true)]);
  assert.equal(f.windows.length, 1);
  assert.equal(f.sessions.length, 1);
  const win = f.windows[0];
  assert.equal(win.visible, false);
  assert.equal(win.throttled, true);
  assert.equal(win.options.alwaysOnTop, undefined);
  assert.equal(win.options.movable, false);
  assert.equal(win.options.thickFrame, false);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  f.sessions[0].emit();
  assert.equal(win.visible, true);
  assert.equal(win.throttled, false);
  assert.equal(win.bounds.width, 400);
  assert.equal(win.bounds.x, 8);
  f.api.cleanupTaskbarPlayer();
  assert.equal(f.sessions[0].stopped, true);
  assert.equal(f.screen.listenerCount('display-added'), 0);
});
test('embedding waits for the first painted frame, even after page load completes', async () => {
  const f = setup({ autoReady: false });
  const pending = f.api.setTaskbarPlayerEnabled(true);
  await new Promise(setImmediate);
  const win = f.windows[0];
  assert.equal(f.sessions.length, 0);
  assert.equal(win.visible, false);
  win.emit('ready-to-show');
  await pending;
  assert.equal(f.sessions.length, 1);
  assert.equal(win.listenerCount('ready-to-show'), 0);
  f.api.cleanupTaskbarPlayer();
});
test('disable before the first frame cancels startup without waiting for a paint event', async () => {
  const f = setup({ autoReady: false });
  const pending = f.api.setTaskbarPlayerEnabled(true);
  await new Promise(setImmediate);
  await f.api.setTaskbarPlayerEnabled(false);
  assert.equal((await pending).enabled, false);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.windows[0].listenerCount('ready-to-show'), 0);
});
test('disable during page load destroys the candidate and prevents native session startup', async () => {
  const page = Promise.withResolvers();
  const f = setup({ page: () => page.promise });
  const pending = f.api.setTaskbarPlayerEnabled(true);
  await new Promise(setImmediate);
  await f.api.setTaskbarPlayerEnabled(false);
  page.resolve();
  assert.equal((await pending).enabled, false);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.windows[0].dead, true);
});
test('cleanup during creation neither recreates a window nor overwrites persisted visibility', async () => {
  const page = Promise.withResolvers();
  const f = setup({ page: () => page.promise });
  const pending = f.api.setTaskbarPlayerEnabled(true);
  f.api.cleanupTaskbarPlayer();
  page.resolve();
  assert.equal((await pending).visible, false);
  assert.equal(f.sessions.length, 0);
});
test('crowded, fullscreen and failed layouts hide, valid space restores without raising over shell', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const win = f.windows[0],
    s = f.sessions[0];
  s.emit();
  assert.equal(win.visible, true);
  s.emit({ ...layout(), available: false });
  assert.equal(win.visible, false);
  assert.equal(win.throttled, true);
  s.emit({
    ...layout(),
    left: { x: 0, y: 0, width: 100, height: 48 },
    right: { x: 0, y: 0, width: 100, height: 48 },
  });
  assert.equal(win.visible, false);
  s.emit();
  assert.equal(win.visible, true);
  assert.equal(win.throttled, false);
  f.main.isFullScreen = () => true;
  f.main.emit('enter-full-screen');
  assert.equal(win.visible, false);
  f.api.cleanupTaskbarPlayer();
});
test('stale callbacks from a destroyed session cannot move or show the replacement', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const old = f.sessions[0];
  await f.api.setTaskbarPlayerEnabled(false);
  await f.api.setTaskbarPlayerEnabled(true);
  const win = f.windows[1];
  old.emit();
  assert.equal(win.visible, false);
  f.sessions[1].emit();
  assert.equal(win.visible, true);
  f.api.cleanupTaskbarPlayer();
});
test('content clipping leaves unused region clickable and honors right anchoring without moving HWND', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const win = f.windows[0];
  f.handlers.get('taskbar-player:set-settings')({ sender: { id: 1 } }, { position: 'right' });
  f.sessions[0].emit();
  const before = { ...win.bounds };
  f.listeners.get('taskbar-player:content-width')({ sender: { id: win.webContents.id } }, 190);
  assert.deepEqual(win.bounds, before);
  assert.equal(win.shape[0].width, 190);
  assert.equal(win.shape[0].x, win.bounds.width - 190);
  f.listeners.get('taskbar-player:content-width')({ sender: { id: 999 } }, 300);
  assert.equal(win.shape[0].width, 190);
  f.api.cleanupTaskbarPlayer();
});
test('settings persist, clamp malformed inputs, and all mutations reject foreign senders', async () => {
  const f = setup();
  const set = f.handlers.get('taskbar-player:set-settings');
  assert.throws(() => set({ sender: { id: 999 } }, { maxWidth: 200 }), /sender/);
  const s = set({ sender: { id: 1 } }, { maxWidth: Infinity, fontSize: 999, showCover: false });
  assert.equal(s.settings.maxWidth, 400);
  assert.equal(s.settings.fontSize, 22);
  assert.equal(f.settings.taskbarLyric.showCover, false);
  assert.throws(
    () => f.handlers.get('taskbar-player:set-enabled')({ sender: { id: 1 } }, 'yes'),
    /state/,
  );
});
test('redisplay requests a fresh native layout even if the existing window is enabled', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const session = f.sessions[0];
  session.emit({ ...layout(), available: false });
  assert.equal(f.windows[0].visible, false);
  const before = session.updates;
  await f.api.setTaskbarPlayerEnabled(true);
  assert.equal(session.updates, before + 1);
  assert.equal(f.windows.length, 1);
  session.emit();
  assert.equal(f.windows[0].visible, true);
  f.api.cleanupTaskbarPlayer();
});
test('external HWND destruction blocks late layout/visibility access and defers one replacement', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const oldWindow = f.windows[0],
    oldSession = f.sessions[0];
  oldSession.emit();
  oldWindow.nativeDead = true;
  oldWindow.hooks.get(0x0002)();
  assert.equal(oldWindow.isDestroyed(), false); // Chromium 的 closed 尚未到达。
  assert.equal(f.isBarAvailable(), false);
  oldSession.emit();
  assert.equal(f.api.getTaskbarPlayerState().visible, false);
  oldWindow.destroy();
  assert.equal(oldSession.stopped, true);
  assert.equal(f.windows.length, 1, 'no new BrowserWindow inside native destruction');
  f.runScheduled();
  await new Promise(setImmediate);
  assert.equal(f.windows.length, 2);
  assert.equal(f.sessions.length, 2);
  assert.equal(f.isBarAvailable(), true);
  oldSession.emit();
  assert.equal(f.windows[1].visible, false);
  f.sessions[1].emit();
  assert.equal(f.windows[1].visible, true);
  f.api.cleanupTaskbarPlayer();
});
test('disable or application cleanup cancels a queued Explorer replacement', async () => {
  for (const quit of [false, true]) {
    const f = setup();
    await f.api.setTaskbarPlayerEnabled(true);
    f.windows[0].destroy();
    if (quit) f.api.cleanupTaskbarPlayer();
    else await f.api.setTaskbarPlayerEnabled(false);
    f.runScheduled();
    await new Promise(setImmediate);
    assert.equal(f.windows.length, 1);
    assert.equal(f.sessions.length, 1);
  }
});
test('native failure and page failure reject honestly and reset persisted enable state', async () => {
  for (const options of [
    { available: false },
    {
      page: async () => {
        throw Error('page failed');
      },
    },
  ]) {
    const f = setup(options);
    await assert.rejects(f.api.setTaskbarPlayerEnabled(true));
    assert.equal(f.settings.taskbarPlayerEnabled, false);
    assert.equal(f.handlers.get('taskbar-player:get-state')().enabled, false);
  }
});
test('DPI conversion uses parent-client coordinates and falls back only to another safe side', () => {
  const settings = shared.DEFAULT_TASKBAR_LYRIC_SETTINGS;
  const r = shared.resolveTaskbarLyricRegion(
    { ...layout(), scaleFactor: 1.5, left: { x: 30, y: 0, width: 900, height: 72 } },
    settings,
  );
  assert.equal(r.bounds.x, 28);
  assert.equal(r.bounds.height, 48);
  assert.equal(r.bounds.width, 400);
  const fallback = shared.resolveTaskbarLyricRegion(
    { ...layout(), left: { x: 0, y: 0, width: 40, height: 48 } },
    { ...settings, position: 'left' },
  );
  assert.equal(fallback.anchor, 'left');
  assert.equal(fallback.bounds.x, 1308);
  assert.equal(fallback.bounds.width, 384);
  assert.equal(
    shared.resolveTaskbarLyricRegion(
      {
        ...layout(),
        left: { x: 0, y: 0, width: 40, height: 48 },
        right: { x: 1300, y: 0, width: 170, height: 48 },
      },
      { ...settings, position: 'left' },
    ),
    null,
  );
  assert.equal(shared.resolveTaskbarLyricRegion({ ...layout(), scaleFactor: NaN }, settings), null);
});
test('the lyric is a taskbar child window, so bounds stay relative to the bar', () => {
  const settings = shared.DEFAULT_TASKBAR_LYRIC_SETTINGS;
  // 歌词是 Shell_TrayWnd 的子窗口，setBounds 按父窗口客户区解释，
  // 因此直接使用 left/right 的相对偏移，不再叠加任务栏屏幕原点。
  const bottom = shared.resolveTaskbarLyricRegion(layout(), settings);
  assert.equal(bottom.bounds.x, 8);
  assert.equal(bottom.bounds.y, 0);

  // 相对偏移按缩放比折算成 DIP，不能混用物理像素。
  const scaled = shared.resolveTaskbarLyricRegion(
    {
      ...layout(),
      scaleFactor: 2,
      left: { x: 60, y: 4, width: 1200, height: 96 },
    },
    settings,
  );
  assert.equal(scaled.bounds.x, 38);
  assert.equal(scaled.bounds.y, 2);

  // 首选侧高度不足 28 DIP 时回退到另一侧，两侧都不够才隐藏。
  const short = { x: 0, y: 0, width: 400, height: 40 };
  assert.equal(
    shared.resolveTaskbarLyricRegion(
      { ...layout(), scaleFactor: 2, left: short, right: short },
      settings,
    ),
    null,
  );

  // 区域坐标非有限时回退到另一侧，两侧都不可信才隐藏。
  const broken = { x: NaN, y: 0, width: 400, height: 48 };
  const fallback = shared.resolveTaskbarLyricRegion(
    { ...layout(), left: broken },
    settings,
  );
  assert.equal(fallback.anchor, 'right');
  assert.equal(
    shared.resolveTaskbarLyricRegion({ ...layout(), left: broken, right: broken }, settings),
    null,
  );
});
test('a native session that stops answering is rebuilt instead of leaving a stranded window', async () => {
  // Explorer 打开快速设置等 XAML 弹层时会销毁并重建 Shell_TrayWnd，原生工作线程
  // 可能正好在任务栏缺席的窗口期静默退出。此时 JS 侧仍持有一个"有效"会话，
  // update() 发给死线程，窗口再也收不到布局，会停在初始尺寸上。
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const win = f.windows[0];
  f.sessions[0].emit();
  assert.equal(win.visible, true);

  // 会话仍在产出布局：每次心跳前推进一个间隔，并让会话回报，心跳不该重建窗口。
  for (let i = 0; i < 3; i += 1) {
    f.advanceClock(2000);
    f.sessions[0].emit();
    f.runHeartbeat(1);
  }
  assert.equal(win.dead, false, 'a responsive session must not be rebuilt');

  // 会话停止响应：连续超过容忍窗口没有布局，就应重建。
  for (let i = 0; i < 4; i += 1) {
    f.advanceClock(2000);
    f.runHeartbeat(1);
  }
  assert.equal(win.dead, true, 'a dead session must destroy the stranded window');

  // 重建要经过 destroy -> closed -> 恢复定时器 -> createBar(含 await)，逐级推进。
  for (let i = 0; i < 30 && f.sessions.length < 2; i += 1) {
    f.runHeartbeat(1);
    f.runScheduled();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.sessions.length, 2, 'the window is recreated after the dead session');
  f.sessions[1].emit();
  assert.equal(f.windows[1].visible, true);
});
test('a rebuilt taskbar is not mistaken for a dead session', async () => {
  // Explorer 打开快速设置等弹层时会销毁并重建 Shell_TrayWnd，这期间拿不到布局
  // 是预期的，native 侧会自行重新挂载。此时若重建 Chromium 窗口，新窗口又会
  // 落进下一个重建空窗，形成死循环 —— 歌词就会一直闪/消失。
  const f = setup({ mountedTaskbar: 1000 });
  await f.api.setTaskbarPlayerEnabled(true);
  const win = f.windows[0];
  f.sessions[0].emit();

  // 任务栏句柄变了 + 长时间无响应：应当只等待，不重建窗口。
  f.setMountedTaskbar(2000);
  for (let i = 0; i < 5; i += 1) {
    f.advanceClock(2000);
    f.runHeartbeat(1);
  }
  assert.equal(win.dead, false, 'a rebuilt taskbar must not destroy the window');
  assert.equal(f.windows.length, 1);

  // 任务栏稳定下来后，native 重新挂载并恢复回调。
  f.sessions[0].emit();
  assert.equal(win.visible, true);
});
test('left preference retains native space reservation and restores into the safe right-only region', async () => {
  const f = setup();
  f.handlers.get('taskbar-player:set-settings')({ sender: { id: 1 } }, { position: 'left' });
  await f.api.setTaskbarPlayerEnabled(true);
  const session = f.sessions[0];
  assert.equal(session.width, 400);
  session.emit({ ...layout(), left: { x: 0, y: 0, width: 0, height: 48 } });
  assert.equal(f.windows[0].visible, true);
  assert.equal(f.windows[0].bounds.x, 1308);
  assert.equal(f.handlers.get('taskbar-player:get-state')().anchor, 'left');
  const set = f.handlers.get('taskbar-player:set-settings');
  set({ sender: { id: 1 } }, { position: 'right', maxWidth: 300 });
  assert.equal(session.width, 300);
  session.emit({ ...layout(), right: { x: 1800, y: 0, width: 80, height: 48 } });
  assert.equal(f.windows[0].bounds.x, 292);
  assert.equal(f.handlers.get('taskbar-player:get-state')().anchor, 'right');
  f.api.cleanupTaskbarPlayer();
});
test('left and right preferences keep distinct alignment even when only one safe region exists', async () => {
  const f = setup();
  await f.api.setTaskbarPlayerEnabled(true);
  const set = f.handlers.get('taskbar-player:set-settings');
  const available = {
    ...layout(),
    centered: false,
    left: { x: 0, y: 0, width: 0, height: 48 },
    right: { x: 600, y: 0, width: 1000, height: 48 },
  };
  f.sessions[0].emit(available);
  const win = f.windows[0];
  f.listeners.get('taskbar-player:content-width')({ sender: { id: win.webContents.id } }, 180);
  assert.equal(win.bounds.x, 1192);
  assert.equal(win.shape[0].x, 220);
  set({ sender: { id: 1 } }, { position: 'left' });
  assert.equal(win.bounds.x, 608);
  assert.equal(win.shape[0].x, 0);
  assert.equal(f.handlers.get('taskbar-player:get-state')().anchor, 'left');
  set({ sender: { id: 1 } }, { position: 'right' });
  assert.equal(win.bounds.x, 1192);
  assert.equal(win.shape[0].x, 220);
  assert.equal(f.handlers.get('taskbar-player:get-state')().anchor, 'right');
  // hover 展开只扩展有效裁切，不移动窗口，也不会超出已确认的空闲区域。
  f.listeners.get('taskbar-player:content-width')({ sender: { id: win.webContents.id } }, 400);
  assert.equal(win.bounds.x, 1192);
  assert.equal(win.shape.length, 0);
  // 离开 hover 后重新裁切，空白区域恢复穿透。
  f.listeners.get('taskbar-player:content-width')({ sender: { id: win.webContents.id } }, 180);
  assert.equal(win.shape[0].x, 220);
  assert.equal(win.shape[0].width, 180);
  f.api.cleanupTaskbarPlayer();
});
