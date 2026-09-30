import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const compile = (file) =>
  transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const compiled = {
  window: compile('../src/main/window/index.ts'),
  mini: compile('../src/main/miniPlayer.ts'),
  mode: compile('../src/main/window/mode.ts'),
  modeController: compile('../src/main/window/modeController.ts'),
  fullscreen: compile('../src/main/window/fullscreen.ts'),
  background: compile('../src/main/macBackgroundMode.ts'),
  app: compile('../src/shared/app.ts'),
  zoom: compile('../src/shared/windowZoom.ts'),
  miniDimensions: compile('../src/shared/miniPlayer.ts'),
};
const noop = () => {};
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup({ loadMiniPage = async () => {} } = {}) {
  const windows = [];
  const events = [];
  const timers = new Map();
  let timerId = 0;
  let dockShow = async () => {};
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 860 },
  };
  const saved = {
    closeBehavior: 'tray',
    hideDockInBackground: true,
    hideMenuBarInBackground: true,
    theme: 'system',
    windowBackground: { enabled: false, frosted: false },
    rememberWindowSize: true,
    windowState: { width: 1150, height: 750, isMaximized: false },
    windowZoomLevel: 0,
    startMinimized: false,
    miniPlayerWindowState: { alwaysOnTop: false },
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setLoginItemSettings: noop,
    quit: () => app.emit('before-quit'),
    dock: { hide: noop, show: () => dockShow() },
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: 0, y: 0, ...options };
      this.visible = false;
      this.focused = false;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        send: noop,
        setWindowOpenHandler: noop,
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isMinimized() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(value) {
      this.bounds = { ...value };
    }
    setSkipTaskbar() {}
    setSheetOffset() {}
    setBackgroundColor() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    restore() {}
    moveTop() {}
    focus() {
      this.focused = true;
    }
    show() {
      this.visible = true;
      events.push({ window: this, action: 'show' });
      this.emit('show');
    }
    showInactive() {
      this.show();
    }
    hide() {
      this.visible = false;
      this.focused = false;
      events.push({ window: this, action: 'hide' });
      this.emit('hide');
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
    async loadFile() {
      if (this.options.title === 'EchoMusic Mini Player') await loadMiniPage(this);
    }
  }
  const settings = {
    getMainAppSettings: () => saved,
    setMainClosePreferences: (preferences) => Object.assign(saved, preferences),
    setMainAppSetting: (key, value) => {
      saved[key] = value;
    },
  };
  const registry = { ipcRegistry: { registerListener: noop, registerHandler: noop } };
  const mocks = {
    'node:os': { release: () => '25.0.0' },
    path: { join },
    electron: {
      app,
      BrowserWindow: FakeWindow,
      nativeTheme: new EventEmitter(),
      powerSaveBlocker: { isStarted: () => false },
      screen: {
        getAllDisplays: () => [display],
        getPrimaryDisplay: () => display,
        getDisplayNearestPoint: () => display,
      },
    },
    '../../shared/windowBackground': {
      normalizeWindowBackground: (value) => ({ ...value }),
      getWindowComposition: () => ({ transparent: false, clientCornerRadius: 12 }),
      resolveWindowBackground: (value) => value,
      resolveRunningWindowBackground: (background) => ({ background, restartRequired: false }),
    },
    '../../shared/windowBackgroundStrategy': {
      detectWindowBackgroundStrategy: () => 'native',
      resolveWindowBackgroundCapabilities: () => ({ supportsFrost: true }),
    },
    '../storage/settings': settings,
    './storage/settings': settings,
    '../plugins': {},
    '../ipc/registry': registry,
    './ipc/registry': registry,
    '../appIcons': { applyWindowAppIcon: noop, resolveWindowIconPath: () => '' },
    '../diagnostics/memory': { logMainMemory: async () => {} },
    '../windowSizing': { resolveMainWindowPlacement: () => ({ bounds: saved.windowState }) },
    '../../shared/windowing': { isWaylandWindowingBackend: () => false },
    './state': { trackMainWindowState: () => ({ flush: noop, dispose: noop }) },
    './pointer': { installWindowPointerEvents: noop },
    './windowsComposition': {},
    './macComposition': { applyMacWindowBackground: noop },
    './titleBar': { createTitleBarController: () => ({ sync: noop }) },
    './hyprlandBackground': {},
    './zoom': { installWindowZoom: () => ({}), registerWindowZoomHandlers: noop },
    './logger': { warn: noop },
    '../shared/playback': { createPlaybackBridgeState: () => ({}) },
    './windowDrag': {
      WindowDragController: class {
        dispose() {}
        clear() {}
      },
    },
  };
  const evaluate = (code) => {
    const module = { exports: {} };
    runInNewContext(code, {
      module,
      process: { platform: 'darwin', env: {} },
      __dirname: '/test/window',
      setTimeout: (callback, delay) => {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      setImmediate,
      require(name) {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        throw new Error(`Unexpected dependency: ${name}`);
      },
    });
    return module.exports;
  };
  mocks['../../shared/app'] = evaluate(compiled.app);
  mocks['../../shared/windowZoom'] = evaluate(compiled.zoom);
  mocks['../shared/miniPlayer'] = evaluate(compiled.miniDimensions);
  mocks['./fullscreen'] = evaluate(compiled.fullscreen);
  const mode = evaluate(compiled.mode);
  mocks['./mode'] = mocks['./window/mode'] = mode;
  const background = evaluate(compiled.background);
  mocks['../macBackgroundMode'] = mocks['./macBackgroundMode'] = background;
  const mainApi = evaluate(compiled.window);
  mocks['./window'] = mocks['./index'] = mainApi;
  const miniApi = evaluate(compiled.mini);
  mocks['../miniPlayer'] = miniApi;
  const modeController = evaluate(compiled.modeController);
  const main = await mainApi.createWindow();
  main.emit('ready-to-show');
  events.length = 0;
  return {
    mainApi,
    miniApi,
    mode,
    modeController,
    main,
    windows,
    events,
    deferDockShow() {
      let finish;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      dockShow = () => pending;
      return finish;
    },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test('two mini toggles while restoring the Dock return to the main window', async () => {
  const e = await setup();
  e.mainApi.requestMainWindowClose();
  const finishDock = e.deferDockShow();
  const first = e.miniApi.toggleMiniPlayerWindow();
  await settle();
  const second = e.miniApi.toggleMiniPlayerWindow();
  finishDock();
  await Promise.all([first, second]);
  await settle();
  assert.equal(e.mode.getActiveWindowMode(), 'main');
  assert.equal(e.main.isVisible(), true);
  assert.equal(e.miniApi.getMiniPlayerWindow()?.isVisible() ?? false, false);
});

test('a main-window request publishes its mode before Dock activation can restore the old mini mode', async () => {
  const e = await setup();
  await e.miniApi.showMiniPlayerWindow();
  e.mainApi.requestMainWindowClose();
  const finishDock = e.deferDockShow();
  const showingMain = e.mainApi.showMainWindow();
  // app.activate dispatches restoreActiveWindowMode while Dock restoration is pending.
  const activating = e.modeController.restoreActiveWindowMode();
  finishDock();
  await Promise.all([showingMain, activating]);
  await settle();
  assert.equal(e.mode.getActiveWindowMode(), 'main');
  assert.equal(e.main.isVisible(), true);
});

test('an expired mini presentation timer cannot hide a newer main window', async () => {
  const e = await setup();
  await e.miniApi.showMiniPlayerWindow();
  await e.mainApi.showMainWindow();
  e.events.length = 0;
  e.runTimers(80);
  assert.equal(e.main.isVisible(), true);
  assert.equal(e.mode.getActiveWindowMode(), 'main');
  assert.equal(
    e.events.some((event) => event.window === e.main && event.action === 'hide'),
    false,
  );
});

test('a mini page finishing after a newer main request stays hidden', async () => {
  let finishPage;
  const pendingPage = new Promise((resolve) => {
    finishPage = resolve;
  });
  const e = await setup({ loadMiniPage: () => pendingPage });
  const showingMini = e.miniApi.showMiniPlayerWindow();
  await settle();
  const mini = e.miniApi.getMiniPlayerWindow();
  assert.ok(mini);
  await e.mainApi.showMainWindow();
  mini.emit('ready-to-show');
  finishPage();
  await showingMini;
  e.runTimers(80);
  assert.equal(e.mode.getActiveWindowMode(), 'main');
  assert.equal(e.main.isVisible(), true);
  assert.equal(mini.isVisible(), false);
});
