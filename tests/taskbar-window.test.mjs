import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { join } from 'node:path';

const load = (file, mocks, globals = {}) => {
  const module = { exports: {} };
  runInNewContext(
    transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
    {
      module,
      process: { platform: 'win32', env: {} },
      __dirname: 'test',
      require: (id) => {
        if (id in mocks) return mocks[id];
        throw new Error(`Unexpected dependency ${id}`);
      },
      ...globals,
    },
  );
  return module.exports;
};

function setup() {
  const windows = [],
    timers = new Set(),
    handlers = new Map();
  const monitor = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  };
  const shell = { foregroundFullscreen: false, shellAbovePlayer: false };
  const main = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getBounds: () => monitor.bounds,
    isFullScreen: () => false,
    webContents: { id: 1 },
  });
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: () => monitor,
    getPrimaryDisplay: () => monitor,
    getAllDisplays: () => [monitor],
  });
  const theme = Object.assign(new EventEmitter(), {
    shouldUseDarkColors: false,
    shouldUseDarkColorsForSystemIntegratedUI: false,
  });
  let failLoad = false,
    saved = false;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false;
      this.dead = false;
      this.presentations = 0;
      this.levels = [];
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length + 2,
        setWindowOpenHandler() {},
        invalidate() {},
        send: (...args) => this.sent.push(args),
      });
      windows.push(this);
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(value) {
      this.bounds = { ...value };
      this.emit('moved');
    }
    isDestroyed() {
      return this.dead;
    }
    isVisible() {
      return this.visible;
    }
    getNativeWindowHandle() {
      return Buffer.alloc(8);
    }
    setAlwaysOnTop(value, level) {
      this.levels.push(level);
    }
    showInactive() {
      this.visible = true;
      this.presentations++;
    }
    moveTop() {}
    hide() {
      this.visible = false;
    }
    destroy() {
      this.dead = true;
      this.visible = false;
      this.emit('closed');
    }
    async loadFile() {
      if (failLoad) throw new Error('test load failed');
    }
  }
  const boundsGate = load('../src/main/windowBoundsPersistence.ts', {});
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
          registerListener() {},
        },
      },
      './window': { getMainWindow: () => main, showMainWindow() {} },
      './storage/settings': {
        getMainAppSettings: () => ({ taskbarPlayerEnabled: saved }),
        setMainAppSetting: (_key, value) => {
          saved = value;
        },
      },
      './windowBoundsPersistence': boundsGate,
      './taskbarDock': {
        calculateTaskbarDock: () => ({
          mode: 'taskbar',
          edge: 'bottom',
          bounds: { x: 640, y: 1033, width: 360, height: 46 },
        }),
      },
      './taskbarShell': {
        getTaskbarShellLayout: () => shell,
        refreshTaskbarShellLayout: async () => {},
        setTaskbarProbeWindow() {},
      },
      './logger': { __esModule: true, default: { error() {} } },
    },
    {
      setInterval: (callback) => {
        const timer = { callback, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearInterval: (timer) => timers.delete(timer),
    },
  );
  api.registerTaskbarPlayerHandlers();
  return {
    api,
    windows,
    shell,
    screen,
    theme,
    timers,
    handlers,
    fail: (value) => {
      failLoad = value;
    },
  };
}

test('concurrent show requests create one isolated window and explicit reopening restores presentation', async () => {
  const env = setup();
  await Promise.all([env.api.setTaskbarPlayerEnabled(true), env.api.setTaskbarPlayerEnabled(true)]);
  assert.equal(env.windows.length, 1);
  const win = env.windows[0];
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.webSecurity, undefined);
  assert.equal(win.levels.at(-1), 'pop-up-menu');
  const before = win.presentations;
  await env.api.setTaskbarPlayerEnabled(true);
  assert.ok(win.presentations > before);
  assert.equal(env.timers.size, 1);
  env.api.cleanupTaskbarPlayer();
  assert.equal(env.timers.size, 0);
});

test('programmatic moved events keep docking; a real manual move detaches', async () => {
  const env = setup();
  await env.api.setTaskbarPlayerEnabled(true);
  const win = env.windows[0];
  win.setBounds({ x: 100, y: 100, width: 360, height: 46 });
  await env.api.setTaskbarPlayerEnabled(true);
  assert.equal(win.bounds.y, 1033);
  win.emit('will-move');
  win.setBounds({ x: 100, y: 100, width: 360, height: 46 });
  assert.equal(win.bounds.y, 100);
  assert.equal(win.levels.at(-1), 'floating');
  env.api.cleanupTaskbarPlayer();
});

test('fullscreen hides and restores; disabled stays hidden; crashed renderer can reopen', async () => {
  const env = setup();
  await env.api.setTaskbarPlayerEnabled(true);
  const win = env.windows[0];
  env.shell.foregroundFullscreen = true;
  assert.equal((await env.api.setTaskbarPlayerEnabled(true)).visible, false);
  env.shell.foregroundFullscreen = false;
  assert.equal((await env.api.setTaskbarPlayerEnabled(true)).visible, true);
  await env.api.setTaskbarPlayerEnabled(false);
  env.theme.emit('updated');
  assert.equal(win.visible, false);
  assert.equal(env.timers.size, 0);
  await env.api.setTaskbarPlayerEnabled(true);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(win.dead, true);
  await env.api.setTaskbarPlayerEnabled(true);
  assert.equal(env.windows.length, 2);
  assert.equal(env.windows[1].visible, true);
  env.api.cleanupTaskbarPlayer();
});

test('failed page load rejects rather than reporting shown, and retry is possible', async () => {
  const env = setup();
  env.fail(true);
  await assert.rejects(env.api.setTaskbarPlayerEnabled(true), /test load failed/);
  assert.equal(env.windows[0].dead, true);
  env.fail(false);
  assert.equal((await env.api.setTaskbarPlayerEnabled(true)).visible, true);
  env.api.cleanupTaskbarPlayer();
});

test('only main or the bar can change its visibility', async () => {
  const env = setup();
  const change = env.handlers.get('taskbar-player:set-enabled');
  assert.throws(() => change({ sender: { id: 999 } }, true), /Invalid taskbar sender/);
  assert.throws(() => change({ sender: { id: 1 } }, 'true'), /Invalid taskbar state/);
  await change({ sender: { id: 1 } }, true);
  await change({ sender: { id: env.windows[0].webContents.id } }, false);
  assert.equal(env.windows[0].visible, false);
  env.api.cleanupTaskbarPlayer();
});

test('periodic native hidden/occluded evidence restores an Electron-visible docked window', async () => {
  const env = setup();
  await env.api.setTaskbarPlayerEnabled(true);
  const win = env.windows[0];
  const tick = async () => {
    [...env.timers][0].callback();
    await new Promise(setImmediate);
  };
  let before = win.presentations;
  await tick();
  assert.equal(win.presentations, before, 'unknown native state must not repeatedly raise the bar');
  env.shell.playerVisible = false;
  await tick();
  assert.ok(
    win.presentations > before,
    'actual hidden HWND must be restored even if Electron says visible',
  );
  before = win.presentations;
  env.shell.playerVisible = true;
  env.shell.shellAbovePlayer = true;
  await tick();
  assert.ok(win.presentations > before, 'Explorer occlusion must restore z-order');
  before = win.presentations;
  env.shell.foregroundFullscreen = true;
  env.shell.playerVisible = false;
  await tick();
  assert.equal(win.visible, false);
  assert.equal(win.presentations, before, 'fullscreen suppression must win over recovery');
  env.api.cleanupTaskbarPlayer();
});

test('initial and live bar theme follows Windows shell, not the independently selected app theme', async () => {
  for (const systemDark of [false, true]) {
    for (const appDark of [false, true]) {
      const env = setup();
      env.theme.shouldUseDarkColors = appDark;
      env.theme.shouldUseDarkColorsForSystemIntegratedUI = systemDark;
      const getState = env.handlers.get('taskbar-player:get-state');
      assert.equal(getState().isDark, systemDark);
      await env.api.setTaskbarPlayerEnabled(true);
      const win = env.windows[0];
      assert.equal(win.sent.at(-1)[1].isDark, systemDark);
      env.theme.shouldUseDarkColorsForSystemIntegratedUI = !systemDark;
      env.theme.emit('updated');
      assert.equal(win.sent.at(-1)[1].isDark, !systemDark);
      assert.equal(getState().isDark, !systemDark);
      env.api.cleanupTaskbarPlayer();
    }
  }
});
