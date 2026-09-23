import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const constants = compile('../src/renderer/stores/playlist/constants.ts');
const songUtils = compile('../src/renderer/utils/song.ts');
const helpers = compile('../src/renderer/stores/playlist/helpers.ts', {
  vue,
  '@/utils/song': songUtils,
  './constants': constants,
});
const order = compile('../src/renderer/utils/playlistOrder.ts');
const loader = compile('../src/renderer/utils/PagedSongLoader.ts', { '@/utils/logger': logger });
const track = (id) => ({
  id: String(id),
  mixSongId: id,
  fileId: id,
  hash: `hash-${id}`,
  name: `Song ${id}`,
});
const page = (songs) => ({ status: 1, data: { songs } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(overrides = {}) {
  const api = {
    addPlaylistTrack: async () => ({ status: 1 }),
    deletePlaylistTrack: async () => ({ status: 1 }),
    getPlaylistTracksNew: async () => page([]),
    ...overrides,
  };
  const { favoritesActions } = compile('../src/renderer/stores/playlist/favoritesActions.ts', {
    '@/api/playlist': api,
    '@/utils/playlistOrder': order,
    '@/utils/mappers': {
      parsePlaylistTracks: (response) => ({
        songs: (response.data ?? response).songs,
        filteredCount: 0,
      }),
    },
    '@/utils/PagedSongLoader': loader,
    '@/stores/user': { useUserStore: () => ({ info: { userid: 7 } }) },
    '@/stores/playlistCovers': {
      usePlaylistCoversStore: () => ({ updateFromPages: async () => {} }),
    },
    '@/utils/song': songUtils,
    '@/utils/logger': logger,
    './constants': constants,
    './helpers': helpers,
  });
  const { userActions } = compile('../src/renderer/stores/playlist/userActions.ts', {
    '@/api/playlist': api,
    '@/utils/logger': logger,
    '@/utils/mappers': {},
    './helpers': helpers,
  });
  const { usePlaylistStore } = compile('../src/renderer/stores/playlist/store.ts', {
    pinia,
    vue,
    './constants': constants,
    './helpers': helpers,
    './favoritesActions': { favoritesActions },
    './userActions': { userActions },
    './personalFmActions': { personalFmActions: {} },
    './queueActions': { queueActions: {} },
  });
  const store = usePlaylistStore(pinia.createPinia());
  store.userPlaylists = [
    { id: '12', listid: 12, globalCollectionId: 'liked-global', name: '我喜欢的音乐', count: 0 },
    { id: '13', listid: 13, name: '普通歌单', count: 0 },
  ];
  store.favoritesLoaded = true;
  return store;
}

test('single and batch playlist changes update reactive hearts only for the liked playlist', async () => {
  const store = setup();
  const song = track(1);
  const heart = vue.computed(() => store.isFavoriteSong(song));
  assert.equal(heart.value, false);
  assert.equal(await store.addToPlaylist(13, song), 'added');
  assert.equal(heart.value, false);
  assert.equal(await store.addToPlaylist('liked-global', song), 'added');
  assert.equal(heart.value, true);
  await store.removeFromPlaylist(13, song);
  assert.equal(heart.value, true);
  await store.removeFromPlaylist('liked-global', song);
  assert.equal(heart.value, false);
  await store.addSongsToPlaylist(12, [song, track(2)]);
  assert.equal(heart.value, true);
  assert.equal(store.isFavoriteSong(track(2)), true);
  await store.removeSongsFromPlaylist(12, [song, track(2)]);
  assert.equal(heart.value, false);
  assert.equal(store.favorites.length, 0);
});

test('already-existing songs reconcile missing hearts without increasing playlist counts', async () => {
  const store = setup({ getPlaylistTracksNew: async () => page([track(1)]) });
  store.userPlaylists[0].count = 1;
  assert.equal(await store.addToPlaylist(12, track(1)), 'exists');
  assert.equal(store.isFavoriteSong(track(1)), true);
  assert.equal(store.userPlaylists[0].count, 1);
  store.favorites = [];
  assert.equal(await store.addToPlaylist(12, track(1)), 'exists');
  assert.equal(store.isFavoriteSong(track(1)), true);
  store.favorites = [];
  assert.deepEqual(await store.addSongsToPlaylist(12, [track(1)]), {
    successCount: 0,
    failedCount: 0,
  });
  assert.equal(store.isFavoriteSong(track(1)), true);
  assert.equal(store.userPlaylists[0].count, 1);
});

for (const method of ['addToFavorites', 'addToPlaylist', 'addSongsToPlaylist']) {
  test(`${method} survives an older refresh, including callers waiting for playback`, async () => {
    const old = deferred();
    const store = setup({ getPlaylistTracksNew: () => old.promise });
    const refresh = store.fetchLikedPlaylistSongs();
    const waiting = store.waitForFavoritesLoaded();
    if (method === 'addToFavorites') await store[method](track(1));
    else await store[method](12, method === 'addSongsToPlaylist' ? [track(1)] : track(1));
    assert.equal(store.isFavoriteSong(track(1)), true);
    old.resolve(page([]));
    await refresh;
    assert.equal(store.isFavoriteSong(track(1)), true);
    assert.deepEqual(
      (await waiting).map((song) => song.id),
      ['1'],
    );
    assert.deepEqual(
      (await store.waitForFavoritesLoaded()).map((song) => song.id),
      ['1'],
    );
  });
}

for (const method of [
  'removeFavoriteSong',
  'removeFromFavorites',
  'removeFromPlaylist',
  'removeSongsFromPlaylist',
]) {
  test(`${method} is not resurrected by an older refresh`, async () => {
    const old = deferred();
    const store = setup({ getPlaylistTracksNew: () => old.promise });
    store.favorites = [track(1), track(2)];
    const refresh = store.fetchLikedPlaylistSongs();
    if (method === 'removeFavoriteSong') await store[method](track(1));
    else if (method === 'removeFromFavorites') await store[method]('1');
    else await store[method](12, method === 'removeSongsFromPlaylist' ? [track(1)] : track(1));
    old.resolve(page([track(1), track(2)]));
    await refresh;
    assert.equal(store.isFavoriteSong(track(1)), false);
    assert.equal(store.isFavoriteSong(track(2)), true);
    assert.deepEqual(
      (await store.waitForFavoritesLoaded()).map((song) => song.id),
      ['2'],
    );
  });
}

for (const success of [true, false]) {
  test(`pending optimistic additions survive a new refresh and settle with success=${success}`, async () => {
    const write = deferred();
    const store = setup({
      addPlaylistTrack: () => write.promise,
      getPlaylistTracksNew: async () => page([track(2)]),
    });
    const adding = store.addToFavorites(track(1));
    await flush();
    assert.equal(store.isFavoriteSong(track(1)), true);
    await store.fetchLikedPlaylistSongs();
    assert.equal(store.isFavoriteSong(track(1)), true);
    assert.equal(store.isFavoriteSong(track(2)), true);
    write.resolve({ status: success ? 1 : 0 });
    assert.equal(await adding, success);
    assert.equal(store.isFavoriteSong(track(1)), success);
    assert.equal(store.isFavoriteSong(track(2)), true);
  });
}

test('a failed removal restores only its song and preserves concurrent additions', async () => {
  const write = deferred();
  const store = setup({ deletePlaylistTrack: () => write.promise });
  store.favorites = [track(1)];
  const removing = store.removeFavoriteSong(track(1));
  await flush();
  assert.equal(store.isFavoriteSong(track(1)), false);
  await store.addToFavorites(track(2));
  write.reject(new Error('Network error'));
  assert.equal(await removing, false);
  assert.equal(store.isFavoriteSong(track(1)), true);
  assert.equal(store.isFavoriteSong(track(2)), true);
});

test('failed refresh rollback retains successful mutations made during loading', async () => {
  const read = deferred();
  const store = setup({ getPlaylistTracksNew: () => read.promise });
  store.favorites = [track(1)];
  const refreshing = store.fetchLikedPlaylistSongs();
  await store.addToFavorites(track(2));
  await store.removeFavoriteSong(track(1));
  read.reject(new Error('Network error'));
  await refreshing;
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    ['2'],
  );
  assert.equal(store.favoritesLoaded, true);
});

test('batch successes update hearts immediately and failed batches never do', async () => {
  const pending = deferred();
  let requests = 0;
  const store = setup({
    addPlaylistTrack: async () => (++requests === 1 ? { status: 1 } : pending.promise),
  });
  const songs = [1, 2].map((id) => ({ ...track(id), name: 'x'.repeat(3000) }));
  const adding = store.addSongsToPlaylist(12, songs);
  await flush();
  assert.equal(requests, 2);
  assert.equal(store.isFavoriteSong(songs[0]), true);
  assert.equal(store.isFavoriteSong(songs[1]), false);
  pending.resolve({ status: 0 });
  assert.deepEqual(await adding, { successCount: 1, failedCount: 1 });
  assert.equal(store.isFavoriteSong(songs[1]), false);
});

test('waiting for favorites after local edits returns current state, not the completed loader snapshot', async () => {
  const store = setup({ getPlaylistTracksNew: async () => page([track(1)]) });
  await store.fetchLikedPlaylistSongs();
  await store.removeFavoriteSong(track(1));
  await store.addToFavorites(track(2));
  assert.deepEqual(
    (await store.waitForFavoritesLoaded()).map((song) => song.id),
    ['2'],
  );
});

test('resetting collections discards in-flight optimistic operations', async () => {
  const write = deferred();
  const store = setup({ addPlaylistTrack: () => write.promise });
  const adding = store.addToFavorites(track(1));
  await flush();
  store.resetUserCollections();
  write.resolve({ status: 1 });
  assert.equal(await adding, false);
  assert.deepEqual(store.favorites, []);
});

test('initial paginated loading merges changes without dropping unloaded songs', async () => {
  const first = deferred();
  const second = deferred();
  const store = setup({
    getPlaylistTracksNew: (_id, number) =>
      number === 1 ? first.promise : number === 2 ? second.promise : page([]),
  });
  store.favoritesLoaded = false;
  const refreshing = store.fetchLikedPlaylistSongs();
  await store.addToFavorites(track(999));
  first.resolve(page(Array.from({ length: 300 }, (_, index) => track(index + 1))));
  await flush();
  assert.equal(store.favorites.length, 301);
  assert.equal(store.isFavoriteSong(track(999)), true);
  await store.removeFavoriteSong(track(1));
  second.resolve(page([track(301)]));
  await refreshing;
  assert.equal(store.favorites.length, 301);
  assert.equal(store.isFavoriteSong(track(999)), true);
  assert.equal(store.isFavoriteSong(track(1)), false);
  assert.equal(store.isFavoriteSong(track(301)), true);
  assert.equal(store.favoritesLoaded, true);
});

for (const success of [true, false]) {
  test(`pending removal remains hidden through refresh and settles with success=${success}`, async () => {
    const write = deferred();
    const store = setup({
      deletePlaylistTrack: () => write.promise,
      getPlaylistTracksNew: async () => page([track(1), track(2)]),
    });
    store.favorites = [track(1)];
    const removing = store.removeFavoriteSong(track(1));
    await flush();
    await store.fetchLikedPlaylistSongs();
    assert.equal(store.isFavoriteSong(track(1)), false);
    assert.equal(store.isFavoriteSong(track(2)), true);
    write.resolve({ status: success ? 1 : 0 });
    assert.equal(await removing, success);
    assert.equal(store.isFavoriteSong(track(1)), !success);
    assert.equal(store.isFavoriteSong(track(2)), true);
  });
}

test('waiters follow a forced replacement refresh instead of returning the aborted snapshot', async () => {
  const old = deferred();
  const fresh = deferred();
  let requests = 0;
  const store = setup({
    getPlaylistTracksNew: () => (++requests === 1 ? old.promise : fresh.promise),
  });
  const refreshing = store.fetchLikedPlaylistSongs();
  let finished = false;
  const waiting = store.waitForFavoritesLoaded().then((songs) => {
    finished = true;
    return songs;
  });
  const replacement = store.fetchLikedPlaylistSongs(true);
  await flush();
  assert.equal(finished, false);
  fresh.resolve(page([track(2)]));
  await replacement;
  assert.deepEqual(
    (await waiting).map((song) => song.id),
    ['2'],
  );
  old.resolve(page([track(1)]));
  await refreshing;
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    ['2'],
  );
});
