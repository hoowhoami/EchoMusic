import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const compile = (path) =>
  transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const backgroundCode = compile('../src/main/macBackgroundMode.ts');
const trayCode = compile('../src/main/tray.ts');

function setup(platform = 'darwin', { deferDockShow = false } = {}) {
  const calls = [];
  const trays = [];
  const pendingDockShows = [];
  const sent = [];
  const warnings = [];
  let dockVisible = true;
  let restoreCount = 0;
  let quitCount = 0;
  const lyrics = { settings: { enabled: true, locked: false } };
  const dock = {
    hide() {
      calls.push('dock:hide');
      dockVisible = false;
    },
    show() {
      calls.push('dock:show');
      if (!deferDockShow) {
        dockVisible = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        pendingDockShows.push(() => {
          dockVisible = true;
          resolve();
        });
      });
    },
    setMenu(menu) {
      dock.menu = menu;
    },
  };
  const app = Object.assign(new EventEmitter(), { dock });
  class MockTray extends EventEmitter {
    constructor(image) {
      super();
      this.image = image;
      this.destroyed = false;
      trays.push(this);
    }
    setImage(image) {
      this.image = image;
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    popUpContextMenu(menu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
      this.removeAllListeners();
    }
  }
  const makeImage = () => ({
    isEmpty: () => false,
    setTemplateImage() {},
    resize() {
      return this;
    },
  });
  const electron = {
    app,
    Tray: MockTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: makeImage, createEmpty: makeImage },
  };
  const logger = {
    warn: (...args) => warnings.push(args),
    error: (...args) => warnings.push(args),
  };
  const modules = {
    electron,
    './logger': logger,
    fs: { statSync: () => ({ size: 10, mtimeMs: 1 }) },
    './window': { quitApplication: () => quitCount++ },
    '../shared/playback': { DEFAULT_PLAYER_VOLUME: 75 },
    './appIcons': { resolveTrayIconPath: () => '/mock/tray.png' },
  };
  const load = (code) => {
    const module = { exports: {} };
    runInNewContext(code, {
      module,
      process: { platform },
      require(name) {
        assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
        return modules[name];
      },
    });
    return module.exports;
  };
  const background = load(backgroundCode);
  modules['./macBackgroundMode'] = background;
  const context = {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => sent.push(args) },
    }),
    restoreWindow: () => restoreCount++,
    getDesktopLyricSnapshot: () => lyrics,
    toggleDesktopLyricLock: () => {
      lyrics.settings.locked = !lyrics.settings.locked;
      return lyrics;
    },
  };
  return {
    background,
    app,
    calls,
    dock,
    trays,
    context,
    sent,
    lyrics,
    warnings,
    loadTray: () => load(trayCode),
    finishDockShow() {
      assert.ok(pendingDockShows.length, 'expected a pending Dock transition');
      pendingDockShows.shift()();
    },
    get dockVisible() {
      return dockVisible;
    },
    get restoreCount() {
      return restoreCount;
    },
    get quitCount() {
      return quitCount;
    },
  };
}

test('macOS close hides Dock and tray, and reopening restores both', async () => {
  const e = setup();
  const tray = e.loadTray();
  const original = tray.initTray(e.context);
  e.background.enterMacBackgroundMode();
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.dockVisible, false);
  assert.equal(original.destroyed, true);

  await e.background.leaveMacBackgroundMode();
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.equal(e.dockVisible, true);
  assert.equal(e.trays.length, 2);
  assert.equal(e.trays[1].destroyed, false);
  assert.equal(e.trays[1].tooltip, 'EchoMusic');
  await e.background.leaveMacBackgroundMode();
  assert.equal(e.trays.length, 2, 'reopening again does not duplicate the tray');
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: macOS background operations leave the tray and Dock untouched`, async () => {
    const e = setup(platform);
    const tray = e.loadTray();
    const original = tray.initTray(e.context);
    e.background.enterMacBackgroundMode();
    await e.background.leaveMacBackgroundMode();
    await e.background.syncMacDockVisibility();
    assert.equal(e.background.isMacBackgroundMode(), false);
    assert.equal(original.destroyed, false);
    assert.equal(tray.initTray(e.context), original);
    assert.deepEqual(e.calls, []);
  });
}

test('a delayed Dock show cannot override a newer background request', async () => {
  const e = setup('darwin', { deferDockShow: true });
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode();
  const reopening = e.background.leaveMacBackgroundMode();
  assert.equal(e.trays.length, 2);
  e.background.enterMacBackgroundMode();
  e.finishDockShow();
  await reopening;
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.dockVisible, false);
  assert.equal(e.trays[1].destroyed, true);
});

test('a delayed Dock show cannot reveal the application after quit begins', async () => {
  const e = setup('darwin', { deferDockShow: true });
  const showing = e.background.syncMacDockVisibility();
  e.app.emit('before-quit');
  e.finishDockShow();
  await showing;
  assert.equal(e.dockVisible, false);
  const previousShows = e.calls.filter((call) => call === 'dock:show').length;
  await e.background.syncMacDockVisibility();
  assert.equal(e.calls.filter((call) => call === 'dock:show').length, previousShows);
});

test('reopening after quit begins does not recreate a hidden tray', async () => {
  const e = setup();
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode();
  e.app.emit('before-quit');
  await e.background.leaveMacBackgroundMode();
  assert.equal(e.dockVisible, false);
  assert.equal(e.trays.length, 1);
  assert.equal(e.trays[0].destroyed, true);
  assert.equal(tray.refreshTray(), null);
});

test('icon refresh and repeated tray initialization remain hidden in background mode', async () => {
  const e = setup();
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode();
  assert.equal(tray.refreshTray(), null);
  assert.equal(tray.initTray(e.context), null);
  tray.refreshTrayMenus();
  await e.background.syncMacDockVisibility();
  assert.equal(e.trays.length, 1);
  assert.equal(e.trays[0].destroyed, true);
  assert.equal(e.dockVisible, false);
});

test('tray registration after entering background waits until reopening to create an icon', async () => {
  const e = setup();
  e.background.enterMacBackgroundMode();
  const tray = e.loadTray();
  assert.equal(tray.initTray(e.context), null);
  assert.equal(tray.refreshTray(), null);
  assert.equal(e.trays.length, 0);
  await e.background.leaveMacBackgroundMode();
  assert.equal(e.trays.length, 1);
  assert.equal(e.trays[0].destroyed, false);
});

test('restored tray keeps current playback, lyric controls, window recovery and quit actions', async () => {
  const e = setup();
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode();
  tray.updateTrayPlaybackState({ isPlaying: true, playMode: 'random', volume: 42 });
  e.lyrics.settings.locked = true;
  tray.refreshTrayMenus();
  await e.background.leaveMacBackgroundMode();

  const restored = e.trays.at(-1);
  restored.emit('right-click');
  const item = (label) => {
    const match = restored.menu.find((entry) => entry.label === label);
    assert.ok(match, `missing menu item: ${label}`);
    return match;
  };
  assert.equal(item('音量 42%').enabled, false);
  const modes = item('播放模式').submenu;
  assert.equal(modes.find((mode) => mode.label === '随机播放').checked, true);
  assert.equal(modes.filter((mode) => mode.checked).length, 1);
  assert.equal(item('解锁桌面歌词').enabled, true);
  assert.ok(e.dock.menu.some((entry) => entry.label === '暂停'));

  item('暂停').click();
  assert.deepEqual(e.sent.at(-1), ['shortcut-trigger', 'togglePlayback']);
  modes.find((mode) => mode.label === '单曲循环').click();
  assert.deepEqual(e.sent.at(-1), ['tray:set-play-mode', 'single']);
  item('解锁桌面歌词').click();
  assert.equal(e.lyrics.settings.locked, false);
  restored.emit('click');
  item('显示窗口').click();
  assert.equal(e.restoreCount, 2);
  item('退出').click();
  assert.equal(e.quitCount, 1);
});
