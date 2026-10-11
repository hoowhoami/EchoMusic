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
const layout = () => ({
  left: { x: 0, y: 0, width: 600, height: 48 },
  right: { x: 1300, y: 0, width: 400, height: 48 },
  scaleFactor: 1,
  centered: true,
  isDark: true,
  available: true,
});
function setup({ page = async () => {}, available = true, autoReady = true } = {}) {
  const scheduled = new Map();
  let timerId = 0;
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
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.visible = false;
      this.dead = false;
      this.nativeDead = false;
      this.hooks = new Map();
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length + 2,
        setWindowOpenHandler() {},
        send: (...args) => this.sent.push(args),
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.dead;
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
    }
    hide() {
      this.visible = false;
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
        getNativeTaskbarLyric: () => (available ? { TaskbarLyricSession: Session } : null),
      },
      './nowPlaying': {
        bindVisibleNowPlayingWindow(_win, available) {
          isBarAvailable = available;
        },
      },
      '../shared/taskbar': shared,
      './logger': { __esModule: true, default: { error() {}, warn() {} } },
    },
    {
      setTimeout: (fn) => {
        scheduled.set(++timerId, fn);
        return timerId;
      },
      clearTimeout: (id) => scheduled.delete(id),
    },
  );
  api.registerTaskbarPlayerHandlers();
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
    runScheduled: () => {
      const tasks = Array.from(scheduled.values());
      scheduled.clear();
      tasks.forEach((fn) => fn());
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
  assert.equal(win.options.alwaysOnTop, undefined);
  assert.equal(win.options.movable, false);
  assert.equal(win.options.thickFrame, false);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  f.sessions[0].emit();
  assert.equal(win.visible, true);
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
  s.emit({
    ...layout(),
    left: { x: 0, y: 0, width: 100, height: 48 },
    right: { x: 0, y: 0, width: 100, height: 48 },
  });
  assert.equal(win.visible, false);
  s.emit();
  assert.equal(win.visible, true);
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
