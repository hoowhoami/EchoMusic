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
  fullscreen: compile('../src/main/window/fullscreen.ts'),
  background: compile('../src/main/macBackgroundMode.ts'),
  app: compile('../src/shared/app.ts'),
  zoom: compile('../src/shared/windowZoom.ts'),
};
const noop = () => {};

async function setup({
  behavior = 'tray',
  platform = 'darwin',
  hideDockInBackground = true,
  hideMenuBarInBackground = true,
} = {}) {
  const events = [];
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  let activeMode = 'main';
  let quitCalls = 0;
  let dockShow = () => Promise.resolve();
  const saved = {
    closeBehavior: behavior,
    hideDockInBackground,
    hideMenuBarInBackground,
    theme: 'system',
    windowBackground: { enabled: false, frosted: false },
    rememberWindowSize: true,
    windowState: { width: 1150, height: 750, isMaximized: false },
    windowZoomLevel: 0,
    startMinimized: false,
  };
  const app = Object.assign(new EventEmitter(), {
    setLoginItemSettings: noop,
    quit() {
      quitCalls++;
      app.emit('before-quit');
    },
    dock: {
      hide: () => events.push('dock:hide'),
      show: () => {
        events.push('dock:show');
        return dockShow();
      },
    },
  });
  class FakeWindow extends EventEmitter {
    visible = false;
    focused = false;
    minimized = false;
    fullscreen = false;
    destroyed = false;
    skipTaskbar = false;
    fullscreenRequests = [];
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed,
      send: noop,
      setWindowOpenHandler: noop,
    });
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
      return this.minimized;
    }
    isFullScreen() {
      return this.fullscreen;
    }
    setFullScreen(value) {
      this.fullscreenRequests.push(value);
    }
    setSkipTaskbar(value) {
      this.skipTaskbar = value;
    }
    setSheetOffset() {}
    setBackgroundColor() {}
    loadFile() {}
    show() {
      events.push('window:show');
      this.visible = true;
      this.emit('show');
    }
    showInactive() {
      events.push('window:show-inactive');
      this.visible = true;
      this.emit('show');
    }
    hide() {
      events.push('window:hide');
      this.visible = false;
      this.focused = false;
      this.emit('hide');
    }
    restore() {
      this.minimized = false;
    }
    moveTop() {
      events.push('window:move-top');
    }
    focus() {
      this.focused = true;
      this.emit('focus');
    }
  }
  const mocks = {
    'node:os': { release: () => '25.0.0' },
    path: { join },
    electron: {
      app,
      BrowserWindow: FakeWindow,
      nativeTheme: Object.assign(new EventEmitter(), { themeSource: 'system' }),
      powerSaveBlocker: { isStarted: () => false },
      screen: { getAllDisplays: () => [{ id: 1 }], getPrimaryDisplay: () => ({ id: 1 }) },
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
    '../storage/settings': {
      getMainAppSettings: () => saved,
      setMainClosePreferences: (preferences) => Object.assign(saved, preferences),
      setMainAppSetting: (key, value) => {
        saved[key] = value;
      },
    },
    './mode': {
      getActiveWindowMode: () => activeMode,
      setActiveWindowMode: (value) => {
        activeMode = value;
      },
    },
    '../plugins': {},
    '../ipc/registry': {
      ipcRegistry: {
        registerListener: (name, listener) => listeners.set(name, listener),
        registerHandler: noop,
      },
    },
    '../appIcons': { applyWindowAppIcon: noop, resolveWindowIconPath: () => '' },
    '../diagnostics/memory': { logMainMemory: async () => {} },
    '../windowSizing': { resolveMainWindowPlacement: () => ({ bounds: saved.windowState }) },
    '../../shared/windowing': { isWaylandWindowingBackend: () => false },
    './state': { trackMainWindowState: () => ({ flush: noop, dispose: noop }) },
    './pointer': { installWindowPointerEvents: noop },
    './windowsComposition': { supportsWindowsAccent: () => false, applyWindowsComposition: noop },
    './macComposition': { applyMacWindowBackground: noop },
    './titleBar': { createTitleBarController: () => ({ sync: noop }) },
    './hyprlandBackground': {},
    './zoom': { installWindowZoom: () => ({}), registerWindowZoomHandlers: noop },
    './logger': { warn: noop },
  };
  const evaluate = (code) => {
    const module = { exports: {} };
    runInNewContext(code, {
      module,
      process: { platform, env: {} },
      __dirname: '/test/window',
      setTimeout: (callback) => {
        const id = ++timerId;
        timers.set(id, callback);
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
  const fullscreen = (mocks['./fullscreen'] = evaluate(compiled.fullscreen));
  const background = (mocks['../macBackgroundMode'] = evaluate(compiled.background));
  background.registerMacTrayVisibility((visible) => events.push(`tray:${visible}`));
  const api = evaluate(compiled.window);
  api.registerMainWindowPreferenceHandlers();
  const win = await api.createWindow();
  win.emit('ready-to-show');
  events.length = 0;
  return {
    api,
    win,
    events,
    timers,
    app,
    background,
    fullscreen,
    saved,
    get quitCalls() {
      return quitCalls;
    },
    nativeClose() {
      let prevented = false;
      win.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) {
        win.destroyed = true;
        win.emit('closed');
      }
      return prevented;
    },
    settleFullscreen(value) {
      win.fullscreen = value;
      win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    },
    deferDockShow() {
      let resolve;
      dockShow = () =>
        new Promise((done) => {
          resolve = done;
        });
      return () => resolve();
    },
    setBehavior(value, options = { hideDockInBackground, hideMenuBarInBackground }) {
      listeners.get('update-close-behavior')({}, value, options);
    },
  };
}

for (const entry of ['native', 'request']) {
  for (const hideDockInBackground of [false, true]) {
    for (const hideMenuBarInBackground of [false, true]) {
      test(`${entry} tray close: Dock hidden=${hideDockInBackground}, menu bar hidden=${hideMenuBarInBackground}`, async () => {
        const e = await setup({ hideDockInBackground, hideMenuBarInBackground });
        if (entry === 'native') assert.equal(e.nativeClose(), true);
        else e.api.requestMainWindowClose();
        assert.equal(e.win.isVisible(), false);
        assert.equal(e.win.isDestroyed(), false);
        assert.equal(e.win.skipTaskbar, true);
        assert.equal(e.quitCalls, 0);
        const hasHiddenIcon = hideDockInBackground || hideMenuBarInBackground;
        assert.equal(e.background.isMacBackgroundMode(), hasHiddenIcon);
        assert.deepEqual(e.events, [
          'window:hide',
          ...(hasHiddenIcon ? [`tray:${!hideMenuBarInBackground}`] : []),
          ...(hideDockInBackground ? ['dock:hide'] : []),
        ]);
        e.events.length = 0;
        await e.api.restoreWindow();
        assert.equal(e.win.isVisible(), true);
        assert.equal(e.win.isFocused(), true);
        assert.equal(e.background.isMacBackgroundMode(), false);
        assert.equal(e.events.includes('dock:show'), hideDockInBackground);
        assert.equal(e.events.includes('tray:true'), hasHiddenIcon);
      });
    }
  }

  test(`${entry} tray close preserves icons and exit still quits`, async () => {
    for (const behavior of ['tray', 'exit']) {
      const e = await setup({
        behavior,
        hideDockInBackground: false,
        hideMenuBarInBackground: false,
      });
      if (entry === 'native') assert.equal(e.nativeClose(), behavior === 'tray');
      else e.api.requestMainWindowClose();
      assert.equal(e.background.isMacBackgroundMode(), false);
      assert.equal(e.quitCalls, behavior === 'exit' ? 1 : 0);
      assert.deepEqual(e.events, behavior === 'tray' ? ['window:hide'] : []);
    }
  });
}

test('fullscreen close waits for AppKit to leave the Space before hiding icons', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  assert.equal(e.nativeClose(), true);
  assert.deepEqual(e.win.fullscreenRequests, [false]);
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.deepEqual(e.events, []);
  e.settleFullscreen(false);
  assert.equal(e.win.isVisible(), false);
  assert.deepEqual(e.events, ['window:hide', 'tray:false', 'dock:hide']);
  assert.equal(e.timers.size, 0);
});

test('close during fullscreen entry waits for entry and then the requested exit', async () => {
  const e = await setup();
  e.fullscreen.setWindowFullscreen(e.win, true);
  e.api.requestMainWindowClose();
  assert.deepEqual(e.win.fullscreenRequests, [true]);
  assert.deepEqual(e.events, []);
  e.settleFullscreen(true);
  assert.deepEqual(e.win.fullscreenRequests, [true, false]);
  assert.deepEqual(e.events, []);
  e.settleFullscreen(false);
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.win.isVisible(), false);
  assert.equal(e.timers.size, 0);
});

test('restoring cancels a pending fullscreen close', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  e.api.requestMainWindowClose();
  await e.api.restoreWindow();
  e.settleFullscreen(false);
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.equal(e.events.includes('window:hide'), false);
  assert.equal(e.events.includes('dock:hide'), false);
  assert.equal(e.timers.size, 0);
});

test('preparing a mini presentation cancels a pending fullscreen background close', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  e.api.requestMainWindowClose();
  const canPresentMini = await e.api.prepareWindowPresentation();
  e.settleFullscreen(false);
  assert.equal(canPresentMini(), true);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.deepEqual(e.events, []);
  assert.equal(e.timers.size, 0);
});

test('mini ready-to-show and delayed presentation guards reject a newer close or quit', async () => {
  for (const action of ['close', 'quit']) {
    const e = await setup();
    const canPresentMini = await e.api.prepareWindowPresentation();
    const mini = new EventEmitter();
    let shown = 0;
    const showMini = () => {
      if (canPresentMini()) shown++;
    };
    mini.once('ready-to-show', showMini);
    assert.equal(canPresentMini(), true);
    if (action === 'close') e.api.requestMainWindowClose();
    else e.api.quitApplication();
    mini.emit('ready-to-show');
    showMini(); // The delayed focus/show callback uses the same guard.
    assert.equal(canPresentMini(), false, action);
    assert.equal(shown, 0, action);
  }
});

test('mini presentation waiting for the Dock is canceled by a newer close or quit', async () => {
  for (const action of ['close', 'quit']) {
    const e = await setup();
    e.api.requestMainWindowClose();
    e.events.length = 0;
    const finishDockShow = e.deferDockShow();
    const preparingMini = e.api.prepareWindowPresentation();
    if (action === 'close') e.api.requestMainWindowClose();
    else e.api.quitApplication();
    finishDockShow();
    const canPresentMini = await preparingMini;
    assert.equal(canPresentMini(), false, action);
    assert.equal(e.win.isVisible(), false);
    assert.equal(e.events.includes('window:show'), false);
    assert.equal(e.events.at(-1), 'dock:hide');
  }
});

test('quitting cancels a pending fullscreen close without entering background mode', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  e.api.requestMainWindowClose();
  e.api.quitApplication();
  e.settleFullscreen(false);
  assert.equal(e.quitCalls, 1);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.deepEqual(e.events, []);
  assert.equal(e.timers.size, 0);
});

test('restoring waits for the Dock before showing and focusing the window', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  const finishDockShow = e.deferDockShow();
  const restoring = e.api.restoreWindow();
  assert.deepEqual(e.events, ['tray:true', 'dock:show']);
  assert.equal(e.win.isVisible(), false);
  finishDockShow();
  await restoring;
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.win.isFocused(), true);
  assert.equal(e.win.skipTaskbar, false);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.deepEqual(e.events, ['tray:true', 'dock:show', 'window:show', 'window:move-top']);
});

test('a new close while Dock restoration is pending prevents the old show from reopening', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  const finishDockShow = e.deferDockShow();
  const restoring = e.api.showMainWindow();
  e.api.requestMainWindowClose();
  finishDockShow();
  await restoring;
  assert.equal(e.win.isVisible(), false);
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.events.includes('window:show'), false);
  assert.equal(e.events.at(-1), 'dock:hide');
});

test('concurrent show requests wait for the same Dock restoration and show only once', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  const finishDockShow = e.deferDockShow();
  const first = e.api.showMainWindow();
  const second = e.api.showMainWindow();
  await Promise.resolve();
  assert.equal(e.win.isVisible(), false);
  assert.deepEqual(e.events, ['tray:true', 'dock:show']);
  finishDockShow();
  await Promise.all([first, second]);
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.win.isFocused(), true);
  assert.deepEqual(e.events, ['tray:true', 'dock:show', 'window:show', 'window:move-top']);
});

test('a later inactive show supersedes a pending focused show without stealing focus', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  const finishDockShow = e.deferDockShow();
  const first = e.api.showMainWindow();
  const second = e.api.showMainWindow(false);
  await Promise.resolve();
  assert.equal(e.win.isVisible(), false);
  finishDockShow();
  await Promise.all([first, second]);
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.win.isFocused(), false);
  assert.deepEqual(e.events, ['tray:true', 'dock:show', 'window:show-inactive', 'window:move-top']);
});

test('an explicit raise moves an already-focused window above an inactive window without refocusing', async () => {
  const e = await setup();
  // A plugin can use showInactive() without taking the main window's focus.
  e.win.focused = true;
  let focusCalls = 0;
  e.win.on('focus', () => focusCalls++);
  e.events.length = 0;

  await e.api.showMainWindow(false, true);

  assert.deepEqual(e.events, ['window:move-top']);
  assert.equal(focusCalls, 0, 'focus:false must not activate the window again');
});

test('plugin host show-on-top explicitly raises and waits for main window presentation', async () => {
  const handlers = new Map();
  const calls = [];
  let finishPresentation;
  const presentation = new Promise((resolve) => {
    finishPresentation = resolve;
  });
  const win = { isDestroyed: () => false };
  const modules = {
    electron: {},
    'node:os': { release: () => '25.0.0' },
    './registry': {
      ipcRegistry: {
        registerHandler: (name, handler) => handlers.set(name, handler),
        registerListener: noop,
      },
    },
    '../window': {
      showMainWindow: (...args) => {
        calls.push(args);
        return presentation;
      },
    },
    '../window/modeController': {},
    '../miniPlayer': {},
    '../systemShutdown': {},
    '../window/fullscreen': {},
  };
  const module = { exports: {} };
  runInNewContext(compile('../src/main/ipc/window.ts'), {
    module,
    process: { platform: 'darwin' },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  module.exports.registerWindowHandlers({ getMainWindow: () => win });

  let returned = false;
  const result = handlers.get('plugins:host:show-on-top')({}, 'main', { focus: false });
  result.then(() => {
    returned = true;
  });
  await Promise.resolve();
  assert.equal(returned, false, 'IPC must wait until Dock/window presentation completes');
  finishPresentation();
  const response = await result;
  assert.equal(response.ok, true);
  assert.equal(response.target, 'main');
  assert.deepEqual(calls, [[false, true]], 'the explicit raise must survive delegation');
});

test('quitting while Dock restoration is pending never reopens the window', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  const finishDockShow = e.deferDockShow();
  const restoring = e.api.showMainWindow();
  e.api.quitApplication();
  finishDockShow();
  await restoring;
  assert.equal(e.quitCalls, 1);
  assert.equal(e.win.isVisible(), false);
  assert.equal(e.events.includes('window:show'), false);
  assert.equal(e.events.at(-1), 'dock:hide');
});

test('changing the close preference cancels a pending background transition', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  e.api.requestMainWindowClose();
  e.setBehavior('exit');
  e.settleFullscreen(false);
  assert.equal(e.saved.closeBehavior, 'exit');
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.equal(e.timers.size, 0);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} ignores macOS icon preferences and retains tray behavior`, async () => {
    const e = await setup({ behavior: 'tray', platform });
    e.setBehavior('tray', { hideDockInBackground: true, hideMenuBarInBackground: true });
    assert.equal(e.saved.closeBehavior, 'tray');
    assert.equal(e.nativeClose(), true);
    assert.equal(e.win.isVisible(), false);
    assert.equal(e.win.isDestroyed(), false);
    assert.equal(e.quitCalls, 0);
    assert.equal(e.background.isMacBackgroundMode(), false);
    assert.deepEqual(e.events, ['window:hide']);
  });
}

test('editing icon preferences while visible leaves icons alone until the next tray close', async () => {
  const e = await setup({ hideDockInBackground: false, hideMenuBarInBackground: false });
  e.setBehavior('tray', { hideDockInBackground: true, hideMenuBarInBackground: false });
  assert.equal(e.saved.hideDockInBackground, true);
  assert.equal(e.saved.hideMenuBarInBackground, false);
  assert.equal(e.win.isVisible(), true);
  assert.deepEqual(e.events, []);
  e.api.requestMainWindowClose();
  assert.deepEqual(e.events, ['window:hide', 'tray:true', 'dock:hide']);
});

test('editing icon preferences while hidden changes icons without showing the window', async () => {
  const e = await setup();
  e.api.requestMainWindowClose();
  e.events.length = 0;
  e.setBehavior('tray', { hideDockInBackground: false, hideMenuBarInBackground: true });
  assert.deepEqual(e.events, ['tray:false', 'dock:show']);
  assert.equal(e.win.isVisible(), false);
  assert.equal(e.background.isMacBackgroundMode(), true);
  e.events.length = 0;
  e.setBehavior('tray', { hideDockInBackground: false, hideMenuBarInBackground: false });
  assert.deepEqual(e.events, ['tray:true']);
  assert.equal(e.win.isVisible(), false);
  assert.equal(e.background.isMacBackgroundMode(), true);
  await e.api.restoreWindow();
  assert.equal(e.win.isVisible(), true);
  assert.equal(e.background.isMacBackgroundMode(), false);
});

test('a pending fullscreen close applies the latest independent icon preferences', async () => {
  const e = await setup();
  e.settleFullscreen(true);
  e.api.requestMainWindowClose();
  e.setBehavior('tray', { hideDockInBackground: false, hideMenuBarInBackground: true });
  e.settleFullscreen(false);
  assert.equal(e.win.isVisible(), false);
  assert.deepEqual(e.events, ['window:hide', 'tray:false']);
  assert.equal(e.timers.size, 0);
});
