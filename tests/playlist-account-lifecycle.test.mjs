import { userIdentity } from './helpers/user-identity.mjs';
import { userSessionWatch } from './helpers/user-session.mjs';
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
const loader = compile('../src/renderer/utils/PagedSongLoader.ts', { '@/utils/logger': logger });
const order = compile('../src/renderer/utils/playlistOrder.ts');
const track = (id) => ({
  id: String(id),
  mixSongId: id,
  fileId: id,
  hash: `hash-${id}`,
  name: `Song ${id}`,
});
const playlists = () => [
  { id: '12', listid: 12, name: '我喜欢的音乐', count: 0, listCreateUserid: 7 },
  { id: '13', listid: 13, name: '普通歌单', count: 0, listCreateUserid: 8 },
  { id: '14', listid: 14, name: '专辑', count: 0, source: 2 },
];
const page = (songs) => ({ status: 1, data: { songs } });
const lists = (info) => ({ status: 1, data: { info } });
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
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'first' },
  });
  const api = {
    addPlaylistTrack: async () => ({ status: 1 }),
    deletePlaylistTrack: async () => ({ status: 1 }),
    getPlaylistTracksNew: async () => page([]),
    getUserPlaylists: async () => lists(playlists()),
    addPlaylist: async () => ({ status: 1, data: { listid: 99 } }),
    deletePlaylist: async () => ({ status: 1 }),
    ...overrides,
  };
  const scope = compile('../src/renderer/stores/playlist/accountScope.ts', {
    '@/utils/watchUserSession': userSessionWatch,
    '@/utils/userSession': compile('../src/renderer/utils/userSession.ts'),
    '@/stores/user': { useUserStore: () => user },
  });
  const dependencies = {
    '@/api/playlist': api,
    '@/utils/logger': logger,
    './helpers': helpers,
    './accountScope': scope,
    '@/utils/mappers': {
      mapPlaylistMeta: (value) => value,
      parsePlaylistTracks: (response) => ({
        songs: (response?.data ?? response)?.songs ?? [],
        filteredCount: 0,
      }),
    },
  };
  const { favoritesActions } = compile('../src/renderer/stores/playlist/favoritesActions.ts', {
    '@/services/songMetadata': { completeSongMetadata: async (songs) => songs },
    ...dependencies,
    '@/utils/playlistOrder': order,
    '@/utils/PagedSongLoader': loader,
    '@/stores/user': { useUserStore: () => user },
    '@/stores/playlistCovers': {
      usePlaylistCoversStore: () => ({ updateFromPages: async () => {} }),
    },
    '@/utils/song': songUtils,
    './constants': constants,
  });
  const { userActions } = compile('../src/renderer/stores/playlist/userActions.ts', dependencies);
  const { usePlaylistStore } = compile('../src/renderer/stores/playlist/store.ts', {
    vue,
    pinia,
    './constants': constants,
    './helpers': helpers,
    './favoritesActions': { favoritesActions },
    './userActions': { userActions },
    './personalFmActions': { personalFmActions: {} },
    './discoverActions': { discoverActions: {} },
    './queueActions': { queueActions: {} },
  });
  const store = usePlaylistStore(pinia.createPinia());
  store.userPlaylists = playlists();
  store.favoritesLoaded = true;
  const reset = () => {
    user.accountRevision += 1;
    user.info = { userid: 8, token: 'second' };
    store.resetUserCollections();
    store.userPlaylists = playlists(); // IDs can be reused between accounts.
    store.favorites = [track(2)];
    store.rememberPlaylistSongs(12, [track(2)], true);
  };
  return { store, user, reset };
}

for (const method of ['addToPlaylist', 'removeFromPlaylist']) {
  test(`${method}: a late success cannot change the next account's cache, hearts or counters`, async () => {
    const pending = deferred();
    const { store, reset } = setup({
      addPlaylistTrack: () => pending.promise,
      deletePlaylistTrack: () => pending.promise,
    });
    const operation = store[method](12, track(2));
    reset();
    const version = store.playlistContentChangeSeq;
    pending.resolve({ status: 1 });
    assert.equal(await operation, method === 'addToPlaylist' ? 'failed' : false);
    assert.deepEqual(
      store.getKnownPlaylistSongs(12).map((song) => song.id),
      ['2'],
    );
    assert.deepEqual(
      store.favorites.map((song) => song.id),
      ['2'],
    );
    assert.equal(store.playlistContentChangeSeq, version);
    assert.equal(store.userPlaylists[0].count, 0);
  });
}

test('duplicate pagination stops on an account switch and never publishes old complete caches', async () => {
  const pending = deferred();
  let reads = 0,
    writes = 0;
  const { store, reset } = setup({
    getPlaylistTracksNew: () => {
      reads += 1;
      return pending.promise;
    },
    addPlaylistTrack: async () => {
      writes += 1;
      return { status: 1 };
    },
  });
  store.userPlaylists[0].count = 301;
  const operation = store.addToPlaylist(12, track(999));
  reset();
  pending.resolve(page(Array.from({ length: 300 }, (_, index) => track(index + 1))));
  assert.equal(await operation, 'failed');
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.deepEqual(
    store.getKnownPlaylistSongs(12).map((song) => song.id),
    ['2'],
  );
});

test('a failed duplicate-check page never marks its partial cache complete', async () => {
  const { store } = setup({
    getPlaylistTracksNew: async (_id, number) =>
      number === 1
        ? page(Array.from({ length: 300 }, (_, index) => track(index + 1)))
        : Promise.reject(new Error('network')),
  });
  store.userPlaylists[0].count = 301;
  assert.equal(await store.addToPlaylist(12, track(999)), 'added');
  assert.equal(store.hasCompleteKnownPlaylistSongs(12), false);
});

test('checked batch additions read uncached targets and submit only missing songs', async () => {
  const writes = [];
  const batches = [];
  const { store } = setup({
    getPlaylistTracksNew: async () => page([track(1)]),
    addPlaylistTrack: async (_id, payload) => {
      writes.push(payload);
      return { status: 1 };
    },
  });
  store.userPlaylists[0].count = 1;
  assert.deepEqual(
    await store.addSongsToPlaylist(12, [track(1), track(2)], undefined, {
      checkDuplicates: true,
      onBatchResult: (songs, result) => batches.push([songs.map((song) => song.id), result]),
    }),
    { successCount: 1, failedCount: 0 },
  );
  assert.equal(writes.length, 1);
  assert.match(writes[0], /hash-2/);
  assert.doesNotMatch(writes[0], /hash-1/);
  assert.deepEqual(batches, [[['2'], 'added']]);
  assert.equal(store.hasCompleteKnownPlaylistSongs(12), false);
  assert.deepEqual(store.getKnownPlaylistSongs(12), []);
  assert.equal(store.userPlaylists[0].count, 2);
});

test('checked batches do not write after a failed duplicate read or mark a partial read complete', async () => {
  let writes = 0;
  const { store } = setup({
    getPlaylistTracksNew: async (_id, number) =>
      number === 1
        ? page(Array.from({ length: 300 }, (_, index) => track(index + 1)))
        : { status: 0, data: {} },
    addPlaylistTrack: async () => {
      writes++;
      return { status: 1 };
    },
  });
  store.userPlaylists[0].count = 301;
  const failed = [];
  assert.deepEqual(
    await store.addSongsToPlaylist(12, [track(999)], undefined, {
      checkDuplicates: true,
      onBatchResult: (songs, result) => failed.push([songs.map((song) => song.id), result]),
    }),
    { successCount: 0, failedCount: 1 },
  );
  assert.equal(writes, 0);
  assert.equal(store.hasCompleteKnownPlaylistSongs(12), false);
  assert.deepEqual(failed, [[['999'], 'failed']]);
});

test('a confirmed batch updates an existing complete cache and count; cancellation stops subsequent batches', async () => {
  let active = true;
  let writes = 0;
  const { store } = setup({
    addPlaylistTrack: async () => {
      writes++;
      return { status: 1 };
    },
  });
  store.rememberPlaylistSongs(12, [], true);
  const songs = [1, 2].map((id) => ({ ...track(id), name: 'x'.repeat(3000) }));
  assert.deepEqual(
    await store.addSongsToPlaylist(12, songs, undefined, {
      checkDuplicates: true,
      isCurrent: () => active,
      onBatchResult: (_songs, result) => {
        assert.equal(result, 'added');
        assert.equal(store.userPlaylists[0].count, 1);
        assert.equal(store.getKnownPlaylistSongs(12).length, 1);
        active = false;
      },
    }),
    { successCount: 1, failedCount: 1 },
  );
  assert.equal(writes, 1);
});

test('closing during an in-flight write still publishes confirmed additions for the same account', async () => {
  let active = true;
  const pending = deferred();
  const { store } = setup({ addPlaylistTrack: () => pending.promise });
  const operation = store.addSongsToPlaylist(12, [track(1)], undefined, {
    checkDuplicates: true,
    isCurrent: () => active,
  });
  active = false;
  pending.resolve({ status: 1 });
  assert.deepEqual(await operation, { successCount: 1, failedCount: 0 });
  assert.equal(store.userPlaylists[0].count, 1);
  assert.deepEqual(store.getKnownPlaylistSongs(12), []);
  assert.equal(store.hasCompleteKnownPlaylistSongs(12), false);
});

test('batch result details permit retrying only failed songs without recounting successful batches', async () => {
  let writes = 0;
  const { store } = setup({ addPlaylistTrack: async () => ({ status: ++writes === 2 ? 0 : 1 }) });
  const songs = [1, 2].map((id) => ({ ...track(id), name: 'x'.repeat(3000) }));
  const failed = [];
  const options = {
    checkDuplicates: true,
    onBatchResult: (batch, result) => {
      if (result === 'failed') failed.push(...batch);
    },
  };
  assert.deepEqual(await store.addSongsToPlaylist(12, songs, undefined, options), {
    successCount: 1,
    failedCount: 1,
  });
  assert.deepEqual(
    failed.map((song) => song.id),
    ['2'],
  );
  assert.equal(store.userPlaylists[0].count, 1);
  assert.deepEqual(
    await store.addSongsToPlaylist(12, failed, undefined, { checkDuplicates: true }),
    { successCount: 1, failedCount: 0 },
  );
  assert.equal(writes, 3);
  assert.equal(store.userPlaylists[0].count, 2);
});

for (const method of ['addSongsToPlaylist', 'removeSongsFromPlaylist']) {
  for (const reject of [false, true]) {
    test(`${method}: ${reject ? 'rejected' : 'successful'} old batch stops subsequent requests and progress`, async () => {
      const pending = deferred();
      let calls = 0;
      const write = () => {
        calls += 1;
        return calls === 1 ? pending.promise : Promise.resolve({ status: 1 });
      };
      const { store, reset } = setup({ addPlaylistTrack: write, deletePlaylistTrack: write });
      const songs = [1, 2].map((id) => ({
        ...track(id),
        name: 'x'.repeat(3000),
        fileId: `${id}${'0'.repeat(3000)}`,
      }));
      const progress = [];
      const operation = store[method](12, songs, (...args) => progress.push(args));
      reset();
      if (reject) pending.reject(new Error('old network error'));
      else pending.resolve({ status: 1 });
      assert.deepEqual(await operation, { successCount: 0, failedCount: 2 });
      assert.equal(calls, 1);
      assert.deepEqual(progress, [[0, 2]]);
      assert.deepEqual(
        store.getKnownPlaylistSongs(12).map((song) => song.id),
        ['2'],
      );
      assert.deepEqual(
        store.favorites.map((song) => song.id),
        ['2'],
      );
    });
  }
}

for (const method of ['addSongsToPlaylist', 'removeSongsFromPlaylist']) {
  test(`${method}: switching from the progress callback prevents the next batch`, async () => {
    let calls = 0;
    const write = async () => {
      calls += 1;
      return { status: 1 };
    };
    const { store, reset } = setup({ addPlaylistTrack: write, deletePlaylistTrack: write });
    const songs = [1, 2].map((id) => ({
      ...track(id),
      name: 'x'.repeat(3000),
      fileId: `${id}${'0'.repeat(3000)}`,
    }));
    assert.deepEqual(
      await store[method](12, songs, (done) => {
        if (done === 1) reset();
      }),
      { successCount: 1, failedCount: 1 },
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      store.getKnownPlaylistSongs(12).map((song) => song.id),
      ['2'],
    );
  });
}

for (const method of ['addToFavorites', 'removeFavoriteSong']) {
  test(`${method}: waiting for the liked playlist cannot submit an old song under a new account`, async () => {
    const pending = deferred();
    let calls = 0;
    const write = async () => {
      calls += 1;
      return { status: 1 };
    };
    const { store, reset } = setup({ addPlaylistTrack: write, deletePlaylistTrack: write });
    store.ensureLikedPlaylistReady = () => pending.promise;
    const operation = store[method](track(1));
    reset();
    pending.resolve({ listId: 12, queryId: 12 });
    assert.equal(await operation, false);
    assert.equal(calls, 0);
    assert.deepEqual(
      store.favorites.map((song) => song.id),
      ['2'],
    );
  });
}

for (const change of ['token', 'revision']) {
  test(`same-user ${change} change discards old favorite pages even before an App reset`, async () => {
    const pending = deferred();
    const { store, user } = setup({ getPlaylistTracksNew: () => pending.promise });
    const operation = store.fetchLikedPlaylistSongs();
    if (change === 'token') user.info.token = 'renewed';
    else user.accountRevision += 1;
    store.favorites = [track(2)];
    pending.resolve(page([track(1)]));
    await operation;
    assert.deepEqual(
      store.favorites.map((song) => song.id),
      ['2'],
    );
  });
}

test('expired favorite loading does not prefetch subsequent pages under the new token', async () => {
  const pending = deferred();
  let reads = 0;
  const { store, user } = setup({
    getPlaylistTracksNew: () => {
      reads += 1;
      return reads === 1 ? pending.promise : Promise.resolve(page([]));
    },
  });
  const operation = store.fetchLikedPlaylistSongs();
  user.info.token = 'renewed';
  pending.resolve(page(Array.from({ length: 300 }, (_, index) => track(index + 1))));
  await operation;
  assert.equal(reads, 1);
});

test('parallel single and batch additions merge against the latest known cache', async () => {
  const pending = deferred();
  let calls = 0;
  const { store } = setup({
    addPlaylistTrack: () => (++calls === 1 ? pending.promise : Promise.resolve({ status: 1 })),
  });
  store.rememberPlaylistSongs(12, [], true);
  const operation = store.addSongsToPlaylist(12, [track(1)]);
  await store.addToPlaylist(12, track(2));
  pending.resolve({ status: 1 });
  await operation;
  assert.deepEqual(
    store
      .getKnownPlaylistSongs(12)
      .map((song) => song.id)
      .sort(),
    ['1', '2'],
  );
  const next = deferred();
  const single = setup({
    addPlaylistTrack: () => (++calls === 3 ? next.promise : Promise.resolve({ status: 1 })),
  }).store;
  single.rememberPlaylistSongs(12, [], true);
  const first = single.addToPlaylist(12, track(1));
  await single.addToPlaylist(12, track(2));
  next.resolve({ status: 1 });
  await first;
  assert.deepEqual(
    single
      .getKnownPlaylistSongs(12)
      .map((song) => song.id)
      .sort(),
    ['1', '2'],
  );
});

const mutations = [
  ['createPlaylist', ['new', false, 7], false],
  ['createPlaylistAndReturnId', ['new', false, 7], null],
  ['deleteOwnedPlaylist', [13], false],
  ['favoritePlaylist', [{ id: 99, name: 'other', listCreateUserid: 99 }, 7], false],
  ['favoriteAlbum', [{ id: 99, name: 'album' }], false],
  ['unfavoriteAlbum', [14], false],
  ['unfavoritePlaylist', [{ id: 13 }, 7], false],
];
for (const [method, args, result] of mutations) {
  test(`${method}: late success does not refresh or report success for a different session`, async () => {
    const pending = deferred();
    const { store, user } = setup({
      addPlaylist: () => pending.promise,
      deletePlaylist: () => pending.promise,
    });
    let refreshes = 0;
    store.fetchUserPlaylists = async () => {
      refreshes += 1;
    };
    const operation = store[method](...args);
    user.info.token = 'renewed';
    pending.resolve({ status: 1, data: { listid: 99 } });
    assert.equal(await operation, result);
    assert.equal(refreshes, 0);
  });
}

test('creation discards its returned ID when the account changes while refreshing', async () => {
  const refresh = deferred();
  const { store, reset } = setup();
  store.fetchUserPlaylists = () => refresh.promise;
  const operation = store.createPlaylistAndReturnId('new', false, 7);
  await flush();
  reset();
  refresh.resolve();
  assert.equal(await operation, null);
});

test('same-user relogin starts a fresh playlist read; old cleanup cannot remove its in-flight deduplication', async () => {
  const old = deferred(),
    fresh = deferred();
  let reads = 0;
  const { store, user } = setup({
    getUserPlaylists: () => (++reads === 1 ? old.promise : fresh.promise),
  });
  store.fetchLikedPlaylistSongs = async () => true;
  const a = store.fetchUserPlaylists();
  user.accountRevision += 1;
  const b = store.fetchUserPlaylists();
  assert.equal(reads, 2);
  old.resolve(lists([{ id: 1, name: 'old' }]));
  await a;
  const c = store.fetchUserPlaylists();
  assert.equal(reads, 2);
  fresh.resolve(lists([{ id: 2, name: 'fresh' }]));
  await Promise.all([b, c]);
  assert.deepEqual(
    store.userPlaylists.map((list) => list.id),
    [2],
  );
});

const createUserStore = () => {
  const { useUserStore } = compile('../src/renderer/stores/user.ts', {
    '@/utils/userIdentity': userIdentity,
    pinia,
    '@/api/user': {},
    '@/stores/listenReport': { useListenReportStore: () => ({ reset() {} }) },
    '@/utils/mappers': {},
    '@/utils/logger': logger,
  });
  const user = useUserStore(pinia.createPinia());
  user.setUserInfo({ userid: 7, token: 'first' });
  return user;
};

test('App synchronously resets collections on actual same-user token replacement and logout/relogin', () => {
  const source = readFileSync(
    new URL('../src/renderer/app/useAppUserSession.ts', import.meta.url),
    'utf8',
  );
  const statement = source.match(/watchUserSession\(\s*userStore,[\s\S]*?\n\s*(?:\);|\}\);)/)[0];
  const userStore = createUserStore();
  const currentUserKey = vue.computed(() => String(userStore.info?.userid ?? ''));
  let resets = 0;
  const code = transformSync(statement, { loader: 'ts' }).code;
  new Function(
    'watchUserSession',
    'userStore',
    'currentUserKey',
    'playlistStore',
    'contentBlacklistStore',
    'scheduleCloudAudioIndexWarmup',
    'clearCloudAudioIndexWarmupTimer',
    'clearCloudAudioIndex',
    'loadedCloudUserKey',
    code,
  )(
    userSessionWatch.watchUserSession,
    userStore,
    currentUserKey,
    {
      resetUserCollections: () => {
        resets += 1;
      },
    },
    { reset() {} },
    () => {},
    () => {},
    () => {},
    '',
  );
  userStore.setUserInfo({ userid: 7, token: 'renewed' });
  assert.ok(resets > 0);
  userStore.logout();
  const loggedOut = resets;
  assert.ok(loggedOut > 1);
  userStore.setUserInfo({ userid: 7, token: 'renewed' });
  assert.ok(resets > loggedOut);
});

test('Sidebar reloads collections after a same-user token replacement without duplicate patch-stage reads', async () => {
  const source = readFileSync(
    new URL('../src/renderer/layouts/Sidebar.vue', import.meta.url),
    'utf8',
  );
  const statement = source.match(/watchUserSession\(\s*userStore,[\s\S]*?\n(?:\);|\}\);)/)[0];
  const userStore = createUserStore();
  const isLoggedIn = vue.computed(() => userStore.isLoggedIn);
  const currentUserId = vue.computed(() => String(userStore.info?.userid ?? ''));
  let reads = 0;
  const code = transformSync(statement, { loader: 'ts' }).code;
  new Function(
    'watchUserSession',
    'isLoggedIn',
    'currentUserId',
    'userStore',
    'syncCloudData',
    'playlistStore',
    code,
  )(
    userSessionWatch.watchUserSession,
    isLoggedIn,
    currentUserId,
    userStore,
    () => {
      reads += 1;
    },
    { userPlaylists: [] },
  );
  userStore.setUserInfo({ userid: 7, token: 'renewed' });
  await vue.nextTick();
  assert.equal(reads, 1);
  userStore.setUserInfo({ userid: 8, token: 'other' });
  await vue.nextTick();
  assert.equal(reads, 2);
});

test('Favorites refreshes account-bound tabs after same-user relogin', async () => {
  const source = readFileSync(
    new URL('../src/renderer/views/Favorites.vue', import.meta.url),
    'utf8',
  );
  const statement = source.match(/watchUserSession\(\s*userStore,[\s\S]*?\n(?:\);|\}\);)/)[0];
  const userStore = createUserStore();
  const isLoggedIn = vue.computed(() => userStore.isLoggedIn);
  const currentUserKey = vue.computed(() => String(userStore.info?.userid ?? ''));
  const events = [];
  const code = transformSync('let accountGeneration = 0;\n' + statement, { loader: 'ts' }).code;
  new Function(
    'watchUserSession',
    'isLoggedIn',
    'currentUserKey',
    'userStore',
    'resetFollowed',
    'resetVideos',
    'refreshFavorites',
    'loadActiveTabData',
    code,
  )(
    userSessionWatch.watchUserSession,
    isLoggedIn,
    currentUserKey,
    userStore,
    () => events.push('followed'),
    () => events.push('videos'),
    () => events.push('favorites'),
    () => events.push('active'),
  );
  userStore.setUserInfo({ userid: 7, token: 'renewed' });
  await vue.nextTick();
  assert.deepEqual(events, ['followed', 'videos', 'favorites', 'active']);
});

test('collection reset retires local change history for reused playlist IDs and preserves the playback queue', async () => {
  const { store } = setup();
  store.rememberPlaylistSongs(12, [], true);
  await store.addToPlaylist(12, track(1));
  const sequence = store.playlistContentChangeSeq;
  store.defaultList = [track(3)];
  assert.ok(store.playlistContentChanges['12'].length);
  store.resetUserCollections();
  assert.deepEqual(store.playlistContentChanges, {});
  assert.deepEqual(store.playlistContentVersions, {});
  assert.equal(store.playlistContentChangeSeq, sequence);
  assert.deepEqual(
    store.defaultList.map((song) => song.id),
    ['3'],
  );
});

for (const raw of [[], null]) {
  test(`an explicit empty playlist page (${JSON.stringify(raw)}) commits an empty successful collection`, async () => {
    const { store } = setup({ getUserPlaylists: async () => lists(raw) });
    let refreshes = 0;
    store.fetchLikedPlaylistSongs = async () => {
      refreshes += 1;
      return false;
    };
    await store.fetchUserPlaylists();
    assert.deepEqual(store.userPlaylists, []);
    assert.equal(refreshes, 1);
  });
}
