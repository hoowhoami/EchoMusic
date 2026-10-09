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
const settle = () => new Promise((resolve) => setImmediate(resolve));
const bothHidden = { hideDockInBackground: true, hideMenuBarInBackground: true };
const iconCombinations = [
  { hideDockInBackground: false, hideMenuBarInBackground: false },
  { hideDockInBackground: true, hideMenuBarInBackground: false },
  { hideDockInBackground: false, hideMenuBarInBackground: true },
  bothHidden,
];

function setup(
  platform = 'darwin',
  {
    deferDockShow = false,
    forceDpi = false,
    displayCount = 1,
    diagnosticMode = false,
    weakMenus = false,
  } = {},
) {
  const calls = [];
  const trays = [];
  const pendingDockShows = [];
  const sent = [];
  const warnings = [];
  const diagnostics = [];
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
  const app = Object.assign(new EventEmitter(), {
    dock,
    getVersion: () => '2.3.2-test',
    commandLine: {
      hasSwitch: (name) => name === 'force-device-scale-factor' && forceDpi,
      getSwitchValue: (name) => {
        if (name === 'force-device-scale-factor' && forceDpi) return '1';
        return '';
      },
    },
  });
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
      if (weakMenus) this.menuRef = new WeakRef(menu);
      else this.menu = menu;
    }
    closeContextMenu() {
      (this.menuRef?.deref() ?? this.menu)?.emit('menu-will-close');
    }
    getBounds() {
      return { x: 1900, y: 1000, width: 20, height: 20 };
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
    Menu: {
      buildFromTemplate: (template) => {
        const events = new EventEmitter();
        return Object.assign(template, {
          once: events.once.bind(events),
          emit: events.emit.bind(events),
        });
      },
    },
    nativeImage: { createFromPath: makeImage, createEmpty: makeImage },
    screen: {
      getCursorScreenPoint: () => ({ x: 1900, y: 1000 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
      getAllDisplays: () =>
        Array.from({ length: displayCount }, (_, index) => ({
          id: index + 1,
          bounds: { x: index * 1920, y: 0, width: 1920, height: 1080 },
          workArea: { x: index * 1920, y: 0, width: 1920, height: 1040 },
          scaleFactor: index === 0 ? 2 : 1,
          rotation: index === 0 ? 0 : 90,
        })),
    },
  };
  const logger = {
    info: (...args) => diagnostics.push(args),
    isDiagnosticModeActive: () => diagnosticMode,
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
      process: {
        platform,
        versions: { electron: '43.7.6', chrome: 'test-chromium' },
        getSystemVersion: () => '10.0.test-build',
      },
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
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      isVisible: () => false,
      isMinimized: () => true,
      isFocused: () => false,
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
    diagnostics,
    screen: electron.screen,
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

for (const options of iconCombinations) {
  const { hideDockInBackground, hideMenuBarInBackground } = options;
  test(`macOS background independently hides Dock=${hideDockInBackground}, menu bar=${hideMenuBarInBackground}`, async () => {
    const e = setup();
    const tray = e.loadTray();
    const original = tray.initTray(e.context);
    e.background.enterMacBackgroundMode(options);
    assert.equal(e.background.isMacBackgroundMode(), true);
    assert.equal(e.dockVisible, !hideDockInBackground);
    assert.equal(original.destroyed, hideMenuBarInBackground);
    assert.equal(tray.initTray(e.context), hideMenuBarInBackground ? null : original);
    const refreshed = tray.refreshTray();
    assert.equal(refreshed === null, hideMenuBarInBackground);
    if (refreshed) assert.equal(refreshed.destroyed, false);
    await e.background.syncMacDockVisibility();
    assert.equal(
      e.dockVisible,
      !hideDockInBackground,
      'auxiliary window sync respects the Dock choice',
    );

    await e.background.leaveMacBackgroundMode();
    assert.equal(e.background.isMacBackgroundMode(), false);
    assert.equal(e.dockVisible, true);
    const expectedTrays = 2; // Hidden icons restore; visible icons are recreated by refresh.
    assert.equal(e.trays.length, expectedTrays);
    assert.equal(e.trays.at(-1).destroyed, false);
    assert.equal(e.trays.at(-1).tooltip, 'EchoMusic');
    await e.background.leaveMacBackgroundMode();
    assert.equal(e.trays.length, expectedTrays, 'reopening again does not duplicate the tray');
  });
}

test('menu-bar-only background restores its tray without changing the Dock activation policy', async () => {
  const e = setup();
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode({
    hideDockInBackground: false,
    hideMenuBarInBackground: true,
  });
  await e.background.leaveMacBackgroundMode();
  assert.deepEqual(e.calls, []);
  assert.equal(e.trays.length, 2);
});

test('Dock-only background allows tray registration and refresh before reopening', async () => {
  const e = setup();
  e.background.enterMacBackgroundMode({
    hideDockInBackground: true,
    hideMenuBarInBackground: false,
  });
  const tray = e.loadTray();
  const original = tray.initTray(e.context);
  assert.ok(original);
  const refreshed = tray.refreshTray();
  assert.ok(refreshed);
  assert.equal(refreshed.destroyed, false);
  assert.equal(e.dockVisible, false);
  await e.background.leaveMacBackgroundMode();
  assert.equal(e.trays.length, 2);
  assert.equal(e.dockVisible, true);
});

test('editing preferences in the foreground leaves both icons visible', () => {
  const e = setup();
  const tray = e.loadTray();
  const original = tray.initTray(e.context);
  e.background.updateMacBackgroundOptions(bothHidden);
  assert.equal(e.background.isMacBackgroundMode(), false);
  assert.equal(e.dockVisible, true);
  assert.equal(original.destroyed, false);
  assert.deepEqual(e.calls, []);
});

test('background preference updates independently restore icons without reopening', async () => {
  const e = setup();
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode(bothHidden);
  e.background.updateMacBackgroundOptions({
    hideDockInBackground: false,
    hideMenuBarInBackground: true,
  });
  await Promise.resolve();
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.dockVisible, true);
  assert.equal(tray.refreshTray(), null);
  e.background.updateMacBackgroundOptions({
    hideDockInBackground: true,
    hideMenuBarInBackground: false,
  });
  assert.equal(e.dockVisible, false);
  assert.equal(e.trays.at(-1).destroyed, false);
  e.background.updateMacBackgroundOptions({
    hideDockInBackground: false,
    hideMenuBarInBackground: false,
  });
  await Promise.resolve();
  assert.equal(e.background.isMacBackgroundMode(), true);
  assert.equal(e.dockVisible, true);
  assert.equal(e.trays.at(-1).destroyed, false);
});

for (const hideDockInBackground of [false, true]) {
  test(`a pending Dock restore obeys the latest hide-Dock=${hideDockInBackground} preference`, async () => {
    const e = setup('darwin', { deferDockShow: true });
    const tray = e.loadTray();
    tray.initTray(e.context);
    e.background.enterMacBackgroundMode(bothHidden);
    e.background.updateMacBackgroundOptions({
      hideDockInBackground: false,
      hideMenuBarInBackground: true,
    });
    e.background.updateMacBackgroundOptions({
      hideDockInBackground,
      hideMenuBarInBackground: true,
    });
    e.finishDockShow();
    await settle();
    assert.equal(e.background.isMacBackgroundMode(), true);
    assert.equal(e.dockVisible, !hideDockInBackground);
    assert.equal(tray.refreshTray(), null);
  });
}

test('reopening waits for a Dock restoration already started by a preference update', async () => {
  const e = setup('darwin', { deferDockShow: true });
  const tray = e.loadTray();
  tray.initTray(e.context);
  e.background.enterMacBackgroundMode(bothHidden);
  e.background.updateMacBackgroundOptions({
    hideDockInBackground: false,
    hideMenuBarInBackground: true,
  });
  let restored = false;
  const reopening = e.background.leaveMacBackgroundMode().then(() => {
    restored = true;
  });
  await Promise.resolve();
  assert.equal(restored, false);
  assert.equal(e.calls.filter((call) => call === 'dock:show').length, 1);
  e.finishDockShow();
  await reopening;
  assert.equal(restored, true);
  assert.equal(e.dockVisible, true);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: macOS background operations leave the tray and Dock untouched`, async () => {
    const e = setup(platform);
    const tray = e.loadTray();
    const original = tray.initTray(e.context);
    e.background.enterMacBackgroundMode(bothHidden);
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
  e.background.enterMacBackgroundMode(bothHidden);
  const reopening = e.background.leaveMacBackgroundMode();
  assert.equal(e.trays.length, 2);
  e.background.enterMacBackgroundMode(bothHidden);
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
  e.background.enterMacBackgroundMode(bothHidden);
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
  e.background.enterMacBackgroundMode(bothHidden);
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
  e.background.enterMacBackgroundMode(bothHidden);
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
  e.background.enterMacBackgroundMode(bothHidden);
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

test('normal tray configurations retain the existing Electron menu path', () => {
  for (const [platform, forceDpi, displayCount] of [
    ['win32', false, 2],
    ['win32', true, 2],
    ['win32', true, 1],
    ['darwin', true, 2],
    ['linux', true, 2],
  ]) {
    const e = setup(platform, {
      forceDpi,
      displayCount,
    });
    const icon = e.loadTray().initTray(e.context);
    icon.emit('right-click');
    assert.ok(icon.menu.some((item) => item.label === '显示窗口'));
    assert.equal(e.diagnostics.length, 0);
  }
});

test('Windows diagnostics observe the original menu path without changing it', () => {
  const e = setup('win32', {
    forceDpi: true,
    displayCount: 2,
    diagnosticMode: true,
  });
  const icon = e.loadTray().initTray(e.context);
  const eventBounds = { x: 1900, y: 1000, width: 20, height: 20 };
  icon.emit('right-click', {}, eventBounds);
  icon.menu.emit('menu-will-show');
  icon.menu.emit('menu-will-close');
  const snapshots = e.diagnostics.map(([, data]) => data);
  assert.deepEqual(
    snapshots.map((data) => data.phase),
    [
      'created',
      'right-click',
      'electron-popup-request',
      'electron-popup-returned',
      'menu-will-show',
      'menu-will-close',
    ],
  );
  const click = snapshots.find((data) => data.phase === 'right-click');
  assert.deepEqual(click.eventBounds, eventBounds);
  assert.equal(click.windowsVersion, '10.0.test-build');
  assert.equal(click.electron, '43.7.6');
  assert.equal(click.forcedScale, '1');
  assert.equal(click.displays.length, 2);
  assert.equal(click.displays[1].rotation, 90);
  assert.equal(click.mainWindow.minimized, true);
  const attempts = snapshots.filter((data) => data.attempt !== undefined);
  assert.ok(attempts.every((data) => data.attempt === attempts[0].attempt));
  assert.equal(e.warnings.length, 0);
});

test('diagnostic collection failure cannot prevent the Electron menu from opening', () => {
  const e = setup('win32', { diagnosticMode: true });
  e.screen.getCursorScreenPoint = () => {
    throw new Error('screen unavailable');
  };
  const icon = e.loadTray().initTray(e.context);
  icon.emit('right-click');
  assert.ok(icon.menu.some((item) => item.label === '显示窗口'));
  assert.ok(e.warnings.some(([message]) => message.includes('Snapshot failed')));
});

test(
  'Electron tray model survives GC through closing and is released after replacement',
  {
    skip: typeof global.gc !== 'function' ? 'Run with node --expose-gc --test' : false,
  },
  async () => {
    const e = setup('win32', { weakMenus: true, forceDpi: true, displayCount: 2 });
    const icon = e.loadTray().initTray(e.context);
    icon.emit('right-click');
    const reference = icon.menuRef;
    for (let i = 0; i < 8; i++) {
      await settle();
      global.gc();
    }
    assert.ok(reference.deref(), 'the native popup alone cannot keep the JS Menu alive');
    reference.deref().emit('menu-will-close');
    for (let i = 0; i < 8; i++) {
      await settle();
      global.gc();
    }
    assert.ok(reference.deref(), 'the native runner still owns the model after closing');
    icon.emit('right-click');
    for (let i = 0; i < 8; i++) {
      await settle();
      global.gc();
    }
    assert.equal(reference.deref(), undefined, 'release the old model after replacing its runner');
  },
);

test(
  'closing an older popup cannot release the current menu; tray destruction releases it',
  {
    skip: typeof global.gc !== 'function' ? 'Run with node --expose-gc --test' : false,
  },
  async () => {
    const e = setup('win32', { weakMenus: true });
    const tray = e.loadTray();
    const icon = tray.initTray(e.context);
    icon.emit('right-click');
    const olderMenu = icon.menuRef.deref();
    icon.emit('right-click');
    const reference = icon.menuRef;
    olderMenu.emit('menu-will-close');
    for (let i = 0; i < 8; i++) {
      await settle();
      global.gc();
    }
    assert.ok(reference.deref());
    tray.destroyTray();
    for (let i = 0; i < 8; i++) {
      await settle();
      global.gc();
    }
    assert.equal(reference.deref(), undefined);
  },
);
