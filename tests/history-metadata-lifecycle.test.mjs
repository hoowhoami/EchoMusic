import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { descriptor } = parse(read('../src/renderer/views/History.vue'));
const code = transformSync(compileScript(descriptor, { id: 'history-metadata' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const sessionModule = { exports: {} };
new Function(
  'module',
  'exports',
  transformSync(read('../src/renderer/utils/userSession.ts'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
)(sessionModule, sessionModule.exports);

function fixture(t) {
  const callbacks = [],
    hooks = {};
  let hydrations = 0;
  let clears = 0;
  const route = vue.reactive({ name: 'history' });
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 1, token: 'one' },
  });
  const history = vue.reactive({
    entries: [],
    playRecordVersion: 0,
    clear: () => {
      clears++;
      history.entries = [];
    },
    hydrate: async () => {
      hydrations++;
    },
    completeMetadata: async (isCurrent) => {
      callbacks.push(isCurrent);
    },
  });
  const dependencies = {
    vue: {
      ...vue,
      ...Object.fromEntries(
        ['onMounted', 'onUnmounted', 'onActivated', 'onDeactivated'].map((name) => [
          name,
          (fn) => (hooks[name] ??= []).push(fn),
        ]),
      ),
    },
    'vue-router': { useRoute: () => route },
    '@/stores/historyStore': { useHistoryStore: () => history },
    '@/stores/user': { useUserStore: () => user },
    ...Object.fromEntries(
      ['playlist', 'player', 'setting', 'theme', 'toast'].map((name) => [
        `@/stores/${name}`,
        { [`use${name[0].toUpperCase()}${name.slice(1)}Store`]: () => ({}) },
      ]),
    ),
    '@/utils/userSession': sessionModule.exports,
    '@/utils/cover': { createThemedIconCoverUrl: () => '' },
    '@/components/music/songContextMenuExtensions': {
      registerSongContextMenuExtension: () => () => {},
    },
    '@/utils/playback': {},
    '@/utils/songList': { sortSongs: (songs) => songs, filterSongsByQuery: (songs) => songs },
    '@/utils/share': {},
    '@/composables/useStickyTabsLayout': { useStickyTabsLayout: () => ({}) },
    '@/composables/useRouteTabs': {
      useRouteTabs: () => ({ state: { tab: vue.ref('songs') }, select: async () => {} }),
    },
    '@/icons': {},
    '@/stores/toast': { useToastStore: () => ({ success() {} }) },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, `Unexpected import ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  let stopped = false;
  const invoke = (name) => (hooks[name] ?? []).forEach((fn) => fn());
  const stop = () => {
    if (stopped) return;
    stopped = true;
    invoke('onUnmounted');
    scope.stop();
  };
  t.after(stop);
  return {
    callbacks,
    route,
    user,
    history,
    view,
    invoke,
    stop,
    clears: () => clears,
    hydrations: () => hydrations,
  };
}

const addHistory = (f) => {
  f.history.entries = [
    {
      song: { id: '1', name: '歌曲', artist: '歌手' },
      historyKey: '1:9',
      lastPlayedAt: 9,
      playCount: 1,
    },
  ];
};

test('clear history requires the open confirmation and clears immediately after confirming', (t) => {
  const f = fixture(t);
  addHistory(f);
  f.view.confirmClear();
  assert.equal(f.clears(), 0);
  f.view.historySecondaryActions.value[0].onTap();
  assert.equal(f.view.showClearDialog.value, true);
  assert.equal(f.clears(), 0);
  f.view.confirmClear();
  assert.equal(f.clears(), 1);
  assert.equal(f.history.entries.length, 0);
  assert.equal(f.view.showClearDialog.value, false);
  f.view.confirmClear();
  assert.equal(f.clears(), 1);
});

test('cancelling or unmounting clear confirmation keeps history', async (t) => {
  const f = fixture(t);
  addHistory(f);
  f.view.openClearDialog();
  await vue.nextTick();
  f.view.showClearDialog.value = false;
  await vue.nextTick();
  assert.equal(f.clears(), 0);
  assert.equal(f.history.entries.length, 1);
  f.view.openClearDialog();
  await vue.nextTick();
  f.stop();
  assert.equal(f.clears(), 0);
});

test('empty history disables the header action and cannot open or confirm clearing', (t) => {
  const f = fixture(t);
  assert.equal(f.view.historySecondaryActions.value[0].disabled, true);
  f.view.openClearDialog();
  assert.equal(f.view.showClearDialog.value, false);
  f.view.showClearDialog.value = true;
  f.view.confirmClear();
  assert.equal(f.clears(), 0);
});

test('history page requests completion when local rows load without recording another play', async (t) => {
  const f = fixture(t);
  f.invoke('onMounted');
  assert.equal(f.hydrations(), 1);
  f.history.entries = [
    { song: { id: '1', coverUrl: 'cover' }, historyKey: '1:9', lastPlayedAt: 9, playCount: 3 },
  ];
  await vue.nextTick();
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.callbacks[0](), false);
  assert.equal(f.callbacks[1](), true);
  assert.equal(f.view.songs.value[0].coverUrl, 'cover');
  assert.equal(f.view.songs.value[0].playCount, 3);
  assert.equal(f.history.playRecordVersion, 0);
});

for (const kind of ['route', 'deactivate', 'unmount', 'token', 'revision', 'logout']) {
  test(`history page drops old completion scope after ${kind}`, async (t) => {
    const f = fixture(t),
      old = f.callbacks[0];
    if (kind === 'route') f.route.name = 'cloud';
    if (kind === 'deactivate') f.invoke('onDeactivated');
    if (kind === 'unmount') f.stop();
    if (kind === 'token') f.user.info.token = 'two';
    if (kind === 'revision') f.user.accountRevision++;
    if (kind === 'logout') f.user.isLoggedIn = false;
    assert.equal(old(), false, 'scope must be invalid even before the next Vue flush');
    await vue.nextTick();
    if (['route', 'deactivate', 'unmount'].includes(kind)) assert.equal(f.callbacks.length, 1);
    if (kind === 'deactivate') {
      f.invoke('onActivated');
      await vue.nextTick();
      assert.equal(f.callbacks.length, 2);
      assert.equal(f.callbacks[1](), true);
      assert.equal(old(), false);
    }
  });
}
