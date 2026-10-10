import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

function load(file, mocks = {}, globals = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'es2019',
    supported: { 'dynamic-import': false },
  }).code;
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}
const { createAppLifetime } = load('../src/renderer/app/lifetime.ts');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function setup(t, { mini = false, hydration, desktopSync, autoPlay = false } = {}) {
  const events = [],
    disposals = [],
    timers = new Map(),
    unmounts = [];
  let mount;
  const record = (name) => () => {
    events.push(name);
  };
  const subscribe = (name) => () => {
    events.push(name);
    return () => disposals.push(name);
  };
  const settings = Object.assign(
    { autoPlayOnLaunch: autoPlay, autoCheckUpdate: true },
    Object.fromEntries(
      [
        'ensureShortcutDefaults',
        'hydrateLogSettings',
        'syncTheme',
        'syncCloseBehavior',
        'syncRememberWindowSize',
        'syncTaskbarCoverPreview',
        'syncTaskbarProgress',
        'syncPreventSleep',
        'syncLogSettings',
      ].map((name) => [name, record(name)]),
    ),
  );
  const activePlayer = vue.reactive({
    currentTrackId: 'song',
    isPlaying: false,
    playMode: 'list',
    volume: 50,
    init: async () => {
      events.push('player.init');
      return false;
    },
    togglePlay: record('player.play'),
    setPlayMode() {},
    refreshOutputDevices() {},
  });
  const mocks = {
    vue: {
      ...vue,
      onMounted: (fn) => {
        mount = fn;
      },
      onUnmounted: (fn) => unmounts.push(fn),
    },
    'vue-router': { useRouter: () => ({ isReady: async () => {}, push() {} }) },
    '@/stores/setting': { useSettingStore: () => settings },
    '@/stores/output': { useOutputStore: () => ({ bind: record('output.bind') }) },
    '@/stores/update': {
      useUpdateStore: () => ({
        init: record('update.init'),
        dispose: () => disposals.push('update'),
        check: record('update.check'),
      }),
    },
    '@/stores/playlist': {
      usePlaylistStore: () => ({
        hydratePlaybackStateFromStorage: record('queue.hydrate'),
        hydratePersonalFmPreferences: record('fm.hydrate'),
      }),
    },
    '@/stores/historyStore': { useHistoryStore: () => ({ hydrate: record('history.hydrate') }) },
    '@/stores/user': {
      useUserStore: () => ({ isLoggedIn: true, fetchUserInfoOnce: record('user.fetch') }),
    },
    '@/stores/sqlitePersist': {
      waitForSqlitePersistHydration: async () => {
        events.push('hydrate');
        await hydration?.promise;
      },
    },
    '@/stores/player/utils': { normalizeQuality: (v) => v },
    '@/stores/pluginUpdates': { setupStartupPluginUpdateCheck: subscribe('plugin.updates') },
    '@/services/contentBlacklistIntegration': {
      registerContentBlacklistIntegration: subscribe('blacklist'),
    },
    '@/utils/windowFrame': { installWindowFrame: subscribe('frame') },
    '@/theme/registry': { setOpenThemesHandler() {} },
    '@/composables/useSettingsDialog': { settingsDialogOpen: vue.ref(false) },
    './lifetime': { createAppLifetime },
    './useAppAppearance': {
      useAppAppearance: () => ({
        start: record('appearance.start'),
        apply: record('appearance.apply'),
        initWindowBackground: async () => {
          events.push('background');
        },
      }),
    },
    './useAppShare': {
      useAppShare: () => ({
        start: record('share.start'),
        scheduleClipboardShareCheck: record('clipboard.schedule'),
      }),
    },
    './useAppUserSession': { useAppUserSession() {} },
    '@/plugins/runtime': {
      onPluginRuntimeReloadRequested: subscribe('plugin.reload'),
      refreshPlugins: (options) =>
        events.push(options?.miniPlayer ? 'plugins.mini' : 'plugins.main'),
    },
    '@/stores/player': { usePlayerStore: () => activePlayer },
    '@/utils/shortcuts': { initShortcutSync: subscribe('shortcuts'), syncGlobalShortcuts() {} },
    '@/desktopLyric/sync': {
      initDesktopLyricSync: async () => {
        events.push('desktop.sync');
        if (desktopSync) await desktopSync.promise;
        return () => disposals.push('desktop.sync');
      },
    },
    '@/miniPlayer/sync': { initMiniPlayerSync: async () => subscribe('mini.sync')() },
    '@/nowPlaying/sync': { initNowPlayingSync: async () => subscribe('nowPlaying.sync')() },
    '@/tasks/taskBridges': { setupTaskBridges: subscribe('tasks') },
  };
  const window = {
    setTimeout: (fn, delay) => {
      const id = timers.size + 1;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    electron: {
      tray: { syncPlayback: record('tray.sync'), onSetPlayMode: subscribe('tray.mode') },
      power: { onResume: subscribe('power.resume') },
    },
  };
  const { useAppRuntime } = load('../src/renderer/app/useAppRuntime.ts', mocks, { window });
  const scope = vue.effectScope();
  const player = scope.run(() => useAppRuntime(vue.ref(mini)));
  const stop = () => {
    scope.stop();
    unmounts.forEach((fn) => fn());
  };
  t.after(stop);
  return { mount: () => mount(), stop, player, activePlayer, events, disposals, timers };
}

test('main startup preserves hydration order and owns each auxiliary-window publisher once', async (t) => {
  const f = setup(t);
  await f.mount();
  assert.equal(f.player.value, f.activePlayer);
  for (const name of ['desktop.sync', 'mini.sync', 'nowPlaying.sync']) {
    assert.equal(f.events.filter((event) => event === name).length, 1);
  }
  assert.ok(f.events.indexOf('user.fetch') > f.events.indexOf('hydrate'));
  assert.ok(f.events.indexOf('player.init') > f.events.indexOf('queue.hydrate'));
  assert.ok(f.events.indexOf('appearance.apply') > f.events.indexOf('player.init'));
  assert.ok(f.events.indexOf('plugins.main') > f.events.indexOf('plugin.updates'));
  f.stop();
  assert.equal(f.timers.size, 0);
  for (const name of [
    'frame',
    'desktop.sync',
    'mini.sync',
    'nowPlaying.sync',
    'tasks',
    'plugin.updates',
    'shortcuts',
    'tray.mode',
    'power.resume',
    'plugin.reload',
    'blacklist',
    'update',
  ]) {
    assert.equal(f.disposals.filter((event) => event === name).length, 1, name);
  }
});

test('Mini route loads its plugins without initializing a second player or sync publishers', async (t) => {
  const f = setup(t, { mini: true });
  await f.mount();
  assert.deepEqual(f.events, ['output.bind', 'share.start', 'plugin.reload', 'plugins.mini']);
  assert.equal(f.player.value, null);
  f.stop();
  assert.deepEqual(f.disposals, ['plugin.reload']);
});

test('unmount during hydration prevents player startup and late bridge registration', async (t) => {
  const hydration = deferred();
  const f = setup(t, { hydration });
  const mounted = f.mount();
  for (let i = 0; i < 20 && !f.events.includes('hydrate'); i++) await new Promise(setImmediate);
  assert.ok(f.events.includes('hydrate'));
  f.stop();
  hydration.resolve();
  await mounted;
  assert.equal(f.events.includes('player.init'), false);
  assert.equal(f.events.includes('nowPlaying.sync'), false);
  assert.equal(f.events.includes('user.fetch'), false);
});

test('late lyric initializer is disposed after unmount and delayed autoplay is canceled', async (t) => {
  const desktopSync = deferred();
  const f = setup(t, { desktopSync, autoPlay: true });
  await f.mount();
  assert.deepEqual(
    [...f.timers.values()].map(({ delay }) => delay),
    [300, 4000],
  );
  f.stop();
  desktopSync.resolve();
  await new Promise(setImmediate);
  assert.equal(f.disposals.filter((name) => name === 'desktop.sync').length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.events.includes('player.play'), false);
});

test('cleanup continues after a disposer fails and remains idempotent', () => {
  const lifetime = createAppLifetime();
  let count = 0;
  lifetime.add(() => {
    throw Error('broken subscription');
  });
  lifetime.add(() => {
    count++;
  });
  assert.throws(lifetime.dispose, AggregateError);
  lifetime.dispose();
  assert.equal(count, 1);
  lifetime.add(() => {
    count++;
  });
  assert.equal(count, 2);
});
