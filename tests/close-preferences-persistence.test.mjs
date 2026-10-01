import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { transformSync } from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const compile = (path) =>
  transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const compiled = {
  app: compile('../src/shared/app.ts'),
  storage: compile('../src/main/storage/settings.ts'),
  backup: compile('../src/main/settingsBackup.ts'),
  portable: compile('../src/shared/settingsBackup.ts'),
  network: compile('../src/shared/portableNetworkSettings.ts'),
  objectSafety: compile('../src/shared/objectSafety.ts'),
  persistence: compile('../src/shared/storePersistence.ts'),
  logging: compile('../src/shared/logging.ts'),
  renderer: compile('../src/renderer/stores/setting.ts'),
};

function setup({ saved, imported = {}, platform = 'darwin' } = {}) {
  const data = new Map(
    saved
      ? [
          ['main:settings', saved],
          ['pinia:setting', saved],
        ]
      : [],
  );
  const writes = [];
  const kv = {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
      writes.push({ key, value });
    },
  };
  const archive = gzipSync(
    JSON.stringify({
      format: 'echomusic-settings-backup',
      version: 1,
      includes: { settings: true, plugins: false },
      settings: imported,
    }),
  );
  const mocks = {
    '../windowSizing': { MAIN_WINDOW_DEFAULT_SIZE: { width: 1150, height: 750 } },
    '../../shared/windowBackground': { DEFAULT_WINDOW_BACKGROUND: {} },
    '../../shared/desktopLyric': { DEFAULT_DESKTOP_LYRIC_SETTINGS: {} },
    './kv': { getKvStorage: () => kv },
    './storage/kv': { getKvStorage: () => kv },
    './logger': { warn() {}, error() {} },
    './plugins': {},
    './plugins/sqlite': {},
    './plugins/webServer': {},
    '../shared/settingsBackupValidation': {},
    electron: {
      app: {},
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['/test/backup'] }),
      },
    },
    'fs/promises': {
      stat: async () => ({ isFile: () => true, size: archive.byteLength }),
      readFile: async () => archive,
    },
  };
  const evaluate = (code) => {
    const module = { exports: {} };
    new Function('require', 'module', 'process', code)(
      (id) => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (['crypto', 'fs', 'path', 'util', 'zlib'].includes(id)) return nodeRequire(id);
        throw new Error(`Unexpected dependency: ${id}`);
      },
      module,
      { platform },
    );
    return module.exports;
  };
  mocks['../../shared/app'] = mocks['../shared/app'] = evaluate(compiled.app);
  mocks['../../shared/logging'] = mocks['../shared/logging'] = evaluate(compiled.logging);
  mocks['./objectSafety'] = mocks['../shared/objectSafety'] = evaluate(compiled.objectSafety);
  mocks['./portableNetworkSettings'] = evaluate(compiled.network);
  mocks['../shared/storePersistence'] = evaluate(compiled.persistence);
  mocks['../shared/settingsBackup'] = evaluate(compiled.portable);
  const storage = evaluate(compiled.storage);
  mocks['./storage/settings'] = storage;
  return { storage, backup: evaluate(compiled.backup), data, writes };
}

const pickPreferences = ({ closeBehavior, hideDockInBackground, hideMenuBarInBackground }) => ({
  closeBehavior,
  hideDockInBackground,
  hideMenuBarInBackground,
});

test('main storage defaults missing flags and rejects malformed saved values', () => {
  const e = setup({
    saved: { closeBehavior: 'unknown', hideDockInBackground: 'true', hideMenuBarInBackground: 1 },
  });
  assert.deepEqual(pickPreferences(e.storage.getMainAppSettings()), {
    closeBehavior: 'tray',
    hideDockInBackground: false,
    hideMenuBarInBackground: false,
  });
  assert.deepEqual(pickPreferences(setup().storage.getMainAppSettings()), {
    closeBehavior: 'tray',
    hideDockInBackground: false,
    hideMenuBarInBackground: false,
  });
});

test('main storage writes all close preferences atomically without replacing unrelated settings', () => {
  const e = setup({ saved: { theme: 'dark', rememberWindowSize: false } });
  const preferences = {
    closeBehavior: 'tray',
    hideDockInBackground: true,
    hideMenuBarInBackground: false,
  };
  e.storage.setMainClosePreferences(preferences);
  assert.equal(e.writes.length, 1);
  assert.deepEqual(pickPreferences(e.storage.getMainAppSettings()), preferences);
  assert.equal(e.storage.getMainAppSettings().theme, 'dark');
  assert.equal(e.storage.getMainAppSettings().rememberWindowSize, false);
});

test('renderer normalizes preferences and sends both icon switches with the close behavior', () => {
  const shared = { exports: {} };
  new Function('module', compiled.app)(shared);
  const renderer = { exports: {} };
  const sends = [];
  new Function('require', 'module', 'window', compiled.renderer)(
    (id) => {
      if (id === 'pinia') return { defineStore: (_name, options) => options };
      if (id === '../../shared/app') return shared.exports;
      return {};
    },
    renderer,
    { electron: { ipcRenderer: { send: (...args) => sends.push(args) } } },
  );
  const store = {
    closeBehavior: 'tray',
    hideDockInBackground: true,
    hideMenuBarInBackground: 'true',
    $patch(preferences) {
      Object.assign(this, preferences);
    },
  };
  renderer.exports.useSettingStore.actions.syncCloseBehavior.call(store);
  assert.deepEqual(pickPreferences(store), {
    closeBehavior: 'tray',
    hideDockInBackground: true,
    hideMenuBarInBackground: false,
  });
  assert.deepEqual(sends, [
    [
      'update-close-behavior',
      'tray',
      { hideDockInBackground: true, hideMenuBarInBackground: false },
    ],
  ]);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`backup restores all four icon combinations to both stores on ${platform}`, async () => {
    for (const hideDockInBackground of [false, true]) {
      for (const hideMenuBarInBackground of [false, true]) {
        const preferences = {
          closeBehavior: 'tray',
          hideDockInBackground,
          hideMenuBarInBackground,
        };
        const e = setup({ imported: preferences, platform });
        const inspection = await e.backup.inspectSettingsBackup();
        assert.equal(inspection.ok, true, inspection.error);
        const result = await e.backup.importSettingsBackup({
          token: inspection.token,
          settings: true,
          plugins: false,
        });
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(pickPreferences(e.data.get('pinia:setting')), preferences);
        assert.deepEqual(pickPreferences(e.storage.getMainAppSettings()), preferences);
      }
    }
  });
}

test('partial backup restores retain omitted preferences and normalize malformed flags', async () => {
  const e = setup({
    saved: { closeBehavior: 'exit', hideDockInBackground: true, hideMenuBarInBackground: true },
    imported: { hideDockInBackground: 'false' },
  });
  const inspection = await e.backup.inspectSettingsBackup();
  assert.equal(inspection.ok, true, inspection.error);
  const result = await e.backup.importSettingsBackup({
    token: inspection.token,
    settings: true,
    plugins: false,
  });
  assert.equal(result.ok, true, result.error);
  const preferences = {
    closeBehavior: 'exit',
    hideDockInBackground: false,
    hideMenuBarInBackground: true,
  };
  assert.deepEqual(pickPreferences(e.data.get('pinia:setting')), preferences);
  assert.deepEqual(pickPreferences(e.storage.getMainAppSettings()), preferences);
});
