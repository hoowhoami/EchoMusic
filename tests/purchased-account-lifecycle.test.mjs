import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';

const session = { exports: {} };
new Function(
  'module',
  'exports',
  transformSync(readFileSync('src/renderer/utils/userSession.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
)(session, session.exports);
const code = transformSync(
  compileScript(parse(readFileSync('src/renderer/views/Purchased.vue', 'utf8')).descriptor, {
    id: 'purchased-session',
  }).content,
  { loader: 'ts', format: 'cjs' },
).code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (id, total = 1) => ({
  data: {
    total,
    goods: [
      { album_audio_id: id, album_id: id, songname: `song-${id}`, album_name: `album-${id}` },
    ],
  },
});
function fixture(t) {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 1, token: 'A' },
  });
  const requests = [],
    unmount = [];
  const fetch = (kind, page) => {
    const pending = deferred();
    requests.push({ kind, page, userid: user.info?.userid, ...pending });
    return pending.promise;
  };
  const mocks = {
    vue: { ...vue, onUnmounted: (fn) => unmount.push(fn) },
    '@/stores/user': { useUserStore: () => user },
    '@/utils/userSession': session.exports,
    '@/api/purchased': {
      getPurchasedSongs: (page) => fetch('songs', page),
      getPurchasedAlbum: (page) => fetch('albums', page),
    },
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/player': { usePlayerStore: () => ({}) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/stores/theme': { useThemeStore: () => ({}) },
    '@/composables/useRouteTabs': {
      useRouteTabs: () => ({ state: { tab: vue.ref('songs') }, select() {} }),
    },
    '@/composables/useStickyTabsLayout': { useStickyTabsLayout: () => ({}) },
    '@/utils/cover': {},
    '@/utils/playback': {},
    '@/utils/songList': {},
    '@/icons': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    mod,
    mod.exports,
  );
  const scope = vue.effectScope();
  t.after(() => {
    unmount.forEach((fn) => fn());
    scope.stop();
  });
  const view = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  const switchAccount = (sameUser = false) => {
    user.info = { userid: sameUser ? 1 : 2, token: 'B' };
    user.accountRevision++;
  };
  return { user, view, requests, switchAccount, unmount };
}

for (const sameUser of [false, true]) {
  for (const outcome of ['success', 'failure']) {
    test(`purchased data refreshes on ${sameUser ? 'same-user relogin' : 'account switch'} and ignores old ${outcome}`, async (t) => {
      const f = fixture(t);
      assert.equal(f.requests.length, 2);
      f.switchAccount(sameUser);
      await vue.nextTick();
      assert.equal(f.requests.length, 4);
      assert.deepEqual(f.view.songs.value, []);
      assert.deepEqual(f.view.albums.value, []);
      for (const request of f.requests.slice(0, 2)) {
        if (outcome === 'success') request.resolve(response(1));
        else request.reject(new Error('old error'));
      }
      await flush();
      assert.equal(f.view.songsLoading.value, true);
      assert.equal(f.view.albumsLoading.value, true);
      f.requests.slice(2).forEach((request) => request.resolve(response(2)));
      await flush();
      assert.equal(f.view.songs.value[0].title, 'song-2');
      assert.equal(f.view.albums.value[0].name, 'album-2');
    });
  }
}

test('old pagination cannot append into a new account or release its loader', async (t) => {
  const f = fixture(t);
  f.requests.forEach((request) => request.resolve(response(1, 10)));
  await flush();
  const a = f.view.loadMoreSongs(),
    b = f.view.loadMoreAlbums();
  assert.equal(f.requests.length, 4);
  f.switchAccount();
  await vue.nextTick();
  f.requests.slice(2, 4).forEach((request) => request.resolve(response(9)));
  await Promise.all([a, b]);
  assert.deepEqual(f.view.songs.value, []);
  assert.deepEqual(f.view.albums.value, []);
  assert.equal(f.view.songsLoading.value, true);
  f.requests.slice(4).forEach((request) => request.resolve(response(2)));
  await flush();
  assert.equal(f.view.songsPage.value, 1);
  assert.equal(f.view.albumsPage.value, 1);
});

test('logout clears purchased data and relogin reloads both tabs', async (t) => {
  const f = fixture(t);
  f.requests.forEach((request) => request.resolve(response(1)));
  await flush();
  f.view.showBatchDrawer.value = true;
  f.user.isLoggedIn = false;
  f.user.info = null;
  f.user.accountRevision++;
  await vue.nextTick();
  assert.deepEqual(f.view.songs.value, []);
  assert.deepEqual(f.view.albums.value, []);
  assert.equal(f.view.showBatchDrawer.value, false);
  assert.equal(f.requests.length, 2);
  f.user.isLoggedIn = true;
  f.switchAccount();
  await vue.nextTick();
  assert.equal(f.requests.length, 4);
  f.requests.slice(2).forEach((request) => request.resolve(response(2)));
  await flush();
});

test('unmounted purchased pages ignore delayed responses', async (t) => {
  const f = fixture(t);
  f.unmount.forEach((fn) => fn());
  f.requests.forEach((request) => request.resolve(response(1)));
  await flush();
  assert.deepEqual(f.view.songs.value, []);
  assert.deepEqual(f.view.albums.value, []);
});
