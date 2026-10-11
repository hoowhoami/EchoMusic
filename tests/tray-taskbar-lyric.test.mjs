import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

function setup(platform = 'win32') {
  let enabled = false;
  let menu;
  const refreshes = [];
  const errors = [];
  const image = { isEmpty: () => false, resize: () => image, setTemplateImage() {} };
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value) {
      menu = value;
    }
    popUpContextMenu(value) {
      menu = value;
    }
  }
  const mocks = {
    electron: {
      Menu: { buildFromTemplate: (items) => Object.assign(new EventEmitter(), { items }) },
      Tray,
      app: {},
      screen: {},
      nativeImage: { createFromPath: () => image },
    },
    fs: {},
    './window': { quitApplication() {} },
    '../shared/playback': { DEFAULT_PLAYER_VOLUME: 70 },
    './logger': {
      __esModule: true,
      default: { error: (...args) => errors.push(args) },
      isDiagnosticModeActive: () => false,
    },
    './appIcons': { resolveTrayIconPath: () => '' },
    './macBackgroundMode': { registerMacTrayVisibility() {} },
    './taskbarMediaBar': {
      getTaskbarPlayerState: () => ({ enabled }),
      setTaskbarPlayerEnabled: async (value) => {
        refreshes.push(value);
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(
    transformSync(readFileSync(new URL('../src/main/tray.ts', import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
    {
      module,
      process: { platform },
      require: (id) => {
        assert.ok(id in mocks, id);
        return mocks[id];
      },
    },
  );
  const tray = module.exports.initTray({
    getDesktopLyricSnapshot: () => ({ settings: { enabled: false } }),
  });
  return {
    refreshes,
    errors,
    open: (value) => {
      enabled = value;
      tray.emit('right-click', {}, {});
      return menu.items;
    },
  };
}

test('Windows tray offers redisplay only while taskbar lyrics are enabled and reuses the refresh path', async () => {
  const f = setup();
  assert.equal(
    f.open(false).some((item) => item.label === '重新显示任务栏歌词'),
    false,
  );
  const items = f.open(true);
  const action = items.find((item) => item.label === '重新显示任务栏歌词');
  assert.ok(action);
  assert.ok(
    items.findIndex((item) => item === action) < items.findIndex((item) => item.label === '退出'),
  );
  action.click();
  await new Promise(setImmediate);
  assert.deepEqual(f.refreshes, [true]);
  assert.equal(f.errors.length, 0);
  assert.equal(
    f.open(false).some((item) => item.label === '重新显示任务栏歌词'),
    false,
  );
});

test('macOS tray does not show the Windows-only taskbar action', () => {
  assert.equal(
    setup('darwin')
      .open(true)
      .some((item) => item.label === '重新显示任务栏歌词'),
    false,
  );
});
