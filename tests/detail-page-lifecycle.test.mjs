import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { renderToString } from '@vue/server-renderer';
const require = createRequire(import.meta.url);
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc');
const load = (path, deps = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
  )(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const object = load('../src/shared/object.ts');
const extractors = load('../src/renderer/utils/extractors.ts', { '../../shared/object': object });
const session = load('../src/renderer/utils/userSession.ts');
const log = { error() {}, debug() {}, info() {}, warn() {} };
const loaders = load('../src/renderer/utils/PagedSongLoader.ts', { '@/utils/logger': log });
const trackSource = load('../src/renderer/utils/playlistTrackSource.ts');
const sources = Object.fromEntries(
  ['Album', 'Artist', 'Playlist'].map((kind) => {
    const { descriptor } = parse(
      readFileSync(
        new URL(`../src/renderer/views/details/${kind}Detail.vue`, import.meta.url),
        'utf8',
      ),
    );
    return [
      kind,
      transformSync(compileScript(descriptor, { id: `detail-${kind}` }).content, {
        loader: 'ts',
        format: 'cjs',
      }).code,
    ];
  }),
);
const { descriptor: songCardDescriptor } = parse(
  readFileSync(new URL('../src/renderer/components/music/SongCard.vue', import.meta.url), 'utf8'),
);
const songCardCode = transformSync(
  compileScript(songCardDescriptor, { id: 'metadata-song-card' }).content,
  {
    loader: 'ts',
    format: 'cjs',
  },
).code;
const songCardModule = { exports: {} };
new Function('require', 'module', 'exports', songCardCode)(
  (name) => {
    if (name.endsWith('.vue')) return {};
    const dependencies = {
      vue,
      'vue-router': { useRouter: () => ({ push() {} }) },
      '@/stores/playlist': { usePlaylistStore: () => ({ isFavoriteSong: () => false }) },
      '@/stores/player': { usePlayerStore: () => ({}) },
      '@/stores/setting': { useSettingStore: () => ({}) },
      '@/utils/format': {},
      '@/icons': {},
      '@/utils/playback': {},
      '@/utils/song': {},
    };
    assert.ok(name in dependencies, name);
    return dependencies[name];
  },
  songCardModule,
  songCardModule.exports,
);

const observeSongCard = (t, songs) => {
  const props = vue.shallowReactive({ song: songs.value[0] });
  const state = songCardModule.exports.default.setup(props, { expose() {} });
  const stop = vue.watch(
    () => songs.value[0],
    (song) => {
      props.song = song;
    },
    { flush: 'sync' },
  );
  t.after(stop);
  return state;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('detail operation did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const row = (id) => ({ id: String(id), mixSongId: String(id), name: `song ${id}` });
const page = (ids) => ({ status: 1, data: { info: ids.map(row) } });
const range = (length, start = 0) => Array.from({ length }, (_, i) => i + start);
const detail = (id = 'A', count = 1) => ({
  status: 1,
  data: { id, name: id, songCount: count, count, albumCount: 40 },
});

function fixture(t, kind) {
  const id = vue.ref('A'),
    active = vue.ref(true),
    tab = vue.ref('songs'),
    routeCallbacks = [],
    unmounts = [],
    notices = [],
    errors = [],
    reads = [],
    cache = [],
    covers = [],
    queueUpdates = [],
    followed = [],
    mutations = [];
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'one' },
    ensureFollowedArtists: async () => {},
    isArtistFollowed: () => false,
    addFollowedArtist: (id) => followed.push(['add', id]),
    removeFollowedArtist: (id) => followed.push(['remove', id]),
  });
  const playlistStore = vue.reactive({
    userCollectionsGeneration: 0,
    userPlaylists: [],
    fetchUserPlaylists: async () => mutations.push('reload'),
    playlistContentVersions: {},
    playlistContentChanges: {},
    activeQueueId: '',
    getPlaylistContentChanges: () => [],
    findPlaylistByIdentity: () => undefined,
    rememberPlaylistSongs: (...args) => cache.push(args),
    getQueueById: (queueId) => queues.get(queueId),
    setPlaybackQueueWithOptions: (songs, filtered, options) => {
      queueUpdates.push([songs, filtered, options]);
      const queue = queues.get(options.queueId);
      if (queue) queue.songs = songs;
    },
  });
  const blacklist = vue.reactive({
    state: 'absent',
    singer: { entries: [], error: '' },
    status: () => blacklist.state,
    ensureFullyLoaded: async () => true,
    addSinger: async (target) => {
      blacklistWrites.push(['add', target]);
      return true;
    },
    remove: async (entry) => {
      blacklistWrites.push(['remove', entry]);
      return true;
    },
  });
  const blacklistWrites = [];
  const queues = new Map();
  const player = { currentTrackId: null };
  const api = {
    getAlbumComments: async () => ({ status: 1, data: { list: [], total: 0 } }),
    getPlaylistComments: async () => ({ status: 1, data: { list: [], total: 0 } }),
    favoriteAlbum: async () => ({ status: 1 }),
    unfavoriteAlbum: async () => ({ status: 1 }),
    followArtist: async () => ({ status: 1 }),
    unfollowArtist: async () => ({ status: 1 }),
    getAlbumDetail: async () => detail(),
    getArtistDetail: async () => detail(),
    getPlaylistDetail: async () => ({ status: 1, data: [{ id: 'A', name: 'A', count: 1 }] }),
    getAlbumSongs: async () => page([1]),
    getArtistSongsV2: async () => page([1]),
    getPlaylistTracks: async () => page([1]),
    getPlaylistTracksNew: async () => page([1]),
    getArtistAlbums: async () => page([1]),
    getArtistVideos: async () => ({ status: 1, data: [], total: 0 }),
  };
  for (const name of Object.keys(api)) {
    const fn = api[name];
    api[name] = (...args) => {
      reads.push([name, ...args]);
      return fn(...args);
    };
  }
  const mappers = {
    mapAlbumDetailMeta: (r) => r,
    mapArtistDetailMeta: (r) => r,
    mapPlaylistMeta: (r) => r,
    mapAlbumMeta: (r) => r,
    mapAlbumSong: (r) => r,
    mapArtistSongV2: (r) => r,
    mapCommentItem: (r) => r,
    resolvePlaylistTrackQueryId: (id) => String(id),
    parsePlaylistTracks: (payload) => {
      const raw = extractors.extractList(payload);
      return {
        songs: raw.filter((r) => !r.invalid),
        filteredCount: raw.filter((r) => r.invalid).length,
      };
    },
  };
  let play = async () => true;
  let vip = async (rows) => rows;
  const fixtureLogger = { ...log, error: (...args) => errors.push(args) };
  let metadata = async (rows) => rows;
  const deps = {
    vue: {
      ...vue,
      onMounted() {},
      onActivated() {},
      onBeforeUnmount: (fn) => unmounts.push(fn),
      onUnmounted: (fn) => unmounts.push(fn),
    },
    'vue-router': { useRouter: () => ({ push() {} }) },
    '@/composables/useRouteId': {
      useRouteId: () => ({ id, onIdChange: (fn) => routeCallbacks.push(fn) }),
    },
    '@/composables/useRouteTabs': {
      useRouteTabs: () => ({ state: { tab }, isActive: active, select() {} }),
    },
    '@/composables/usePageScroll': { useScrollContainer: () => vue.ref(null) },
    '@/composables/useStickyTabsLayout': {
      useStickyTabsLayout: () => ({ tabsTop: vue.ref(0), tabsMinHeight: vue.ref(0) }),
    },
    '@/utils/extractors': extractors,

    '@/utils/userSession': session,
    '@/utils/PagedSongLoader': loaders,
    '@/utils/mappers': mappers,
    '@/utils/logger': { ...fixtureLogger, logger: fixtureLogger },
    '@/utils/playlistTrackSource': trackSource,
    '@/utils/playlistOrder': {
      orderByPlaylistPosition: (songs) =>
        songs.slice().sort((a, b) => (a.playlistSort ?? 0) - (b.playlistSort ?? 0)),
    },
    '@/utils/song': { isSameSong: (a, b) => String(a.id) === String(b.id) },
    '@/utils/songList': {
      sortSongs: (songs) => songs.slice(),
      filterSongsByQuery: (songs, query) =>
        songs.filter((song) => !query || song.name.includes(query)),
    },
    '@/utils/playback': {
      replaceQueueAndPlay: (_store, _player, songs, _filtered, _requested, options) => {
        playlistStore.activeQueueId = options.queueId;
        queues.set(options.queueId, { songs, playbackRevision: 0 });
        return play();
      },
    },
    '@/utils/share': {},
    '@/utils/format': {},
    '@/utils/playlistTags': { parsePlaylistTags: () => [] },
    '@/utils/commentVipCache': { enrichCommentsWithYoungVip: (rows) => vip(rows) },
    '@/api/comment': Object.assign(api, {
      assertCommentSuccess: (res) => {
        assert.equal(Number(res?.status), 1);
      },
    }),
    '@/api/album': api,
    '@/api/artist': api,
    '@/api/playlist': api,
    '@/services/playlistEditing': { canEditPlaylist: () => false },
    '@/services/songMetadata': {
      completeSongMetadata: (rows, isCurrent) => metadata(rows, isCurrent),
    },
    '@/stores/playlist': { usePlaylistStore: () => playlistStore },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/setting': {
      useSettingStore: () => ({ artistSongSort: 'new', artistAlbumSort: 'new' }),
    },
    '@/stores/contentBlacklist': { useContentBlacklistStore: () => blacklist },
    '@/stores/playlistCovers': {
      usePlaylistCoversStore: () => ({
        hydrate: async () => {},
        updateFromPages: async (...args) => covers.push(args),
      }),
    },
    '@/stores/toast': {
      useToastStore: () =>
        Object.fromEntries(
          [
            'loadFailed',
            'actionCompleted',
            'actionSucceeded',
            'actionFailed',
            'loginRequired',
            'warning',
          ].map((name) => [
            name,
            (value) => notices.push(name === 'loadFailed' ? value : [name, value]),
          ]),
        ),
    },
    '@/icons': {},
    '../../../shared/object': object,
    '../../shared/object': object,
  };
  deps['@/composables/useDetailComments'] = load(
    '../src/renderer/composables/useDetailComments.ts',
    deps,
  );
  const module = { exports: {} };
  new Function('require', 'module', 'exports', sources[kind])(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unmounts.forEach((fn) => fn());
    scope.stop();
  };
  t.after(stop);
  const go = (newId) => {
    id.value = newId;
    routeCallbacks.forEach((fn) => fn(newId));
  };
  const loader = () => view.songLoader;
  const run = () => (kind === 'Artist' ? view.loadArtistSongs() : view.fetchData());
  const songApi =
    kind === 'Album'
      ? 'getAlbumSongs'
      : kind === 'Artist'
        ? 'getArtistSongsV2'
        : 'getPlaylistTracks';
  return {
    view,
    api,
    user,
    playlistStore,
    reads,
    notices,
    errors,
    cache,
    covers,
    queues,
    queueUpdates,
    id,
    tab,
    active,
    stop,
    go,
    loader,
    run,
    songApi,
    followed,
    blacklist,
    blacklistWrites,
    mutations,
    setVip: (fn) => {
      vip = fn;
    },
    setMetadata: (fn) => {
      metadata = fn;
    },
    setPlay: (fn) => {
      play = fn;
    },
  };
}

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: failed refresh preserves an existing complete song snapshot`, async (t) => {
    const f = fixture(t, kind);
    await f.run();
    await bounded(f.loader().waitForAll());
    const songs = f.view.songs.value;
    f.api[f.songApi] = async () => {
      throw new Error('network');
    };
    await f.run();
    assert.equal(f.view.songs.value, songs);
    assert.equal(f.view.loadedSongCount.value, 1);
    assert.equal(f.loader().failed, true);
    assert.equal(f.notices.length, 1);
  });
  test(`${kind}: late page after resource switch cannot populate the new page`, async (t) => {
    const f = fixture(t, kind),
      old = deferred(),
      fresh = deferred();
    f.api[f.songApi] = (id) => (id === 'A' ? old.promise : fresh.promise);
    const first = f.run();
    await flush();
    f.go('B');
    await flush();
    old.resolve(page([1]));
    await first;
    assert.equal(f.view.songs.value.length, 0);
    fresh.resolve(page([2]));
    await flush();
    await flush();
    assert.deepEqual(
      f.view.songs.value.map((s) => s.id),
      ['2'],
    );
  });
  test(`${kind}: successful empty list remains a valid completed response`, async (t) => {
    const f = fixture(t, kind);
    f.api[f.songApi] = async () => page([]);
    await f.run();
    assert.equal(f.loader().fullyLoaded, true);
    assert.equal(f.loader().failed, false);
    assert.deepEqual(f.notices, []);
  });
}

test('artist song pagination continues when the first page arrives before metadata', async (t) => {
  const f = fixture(t, 'Artist'),
    meta = deferred();
  const pages = [];
  f.api.getArtistDetail = () => meta.promise;
  f.api.getArtistSongsV2 = async (_id, p) => {
    pages.push(p);
    return page(p === 1 ? range(100) : p === 2 ? [100] : []);
  };
  const pending = f.view.fetchData();
  await flush();
  await flush();
  assert.ok(pages.includes(2));
  assert.equal(f.view.songs.value.length, 101);
  assert.equal(f.loader().fullyLoaded, true);
  meta.resolve(detail('A', 101));
  await pending;
});

test('artist unmount aborts background pages, ignores errors, and prevents later requests', async (t) => {
  const f = fixture(t, 'Artist'),
    rest = deferred();
  const pages = [];
  f.view.artist.value = { songCount: 500 };
  f.api.getArtistSongsV2 = (_id, p) => {
    pages.push(p);
    return p === 1 ? Promise.resolve(page(range(100))) : rest.promise;
  };
  await f.run();
  await flush();
  const loader = f.loader();
  const waiting = loader.waitForAll();
  f.stop();
  await bounded(waiting);
  rest.reject(new Error('late error'));
  await flush();
  assert.equal(f.view.songs.value.length, 100);
  assert.deepEqual(f.notices, []);
  const count = pages.length;
  await f.run();
  assert.equal(pages.length, count);
});

test('playlist failed refresh preserves the complete filtered-song count and cache', async (t) => {
  const f = fixture(t, 'Playlist');
  f.api.getPlaylistDetail = async () => ({ status: 1, data: [{ id: 'A', count: 2 }] });
  f.api.getPlaylistTracks = async () => ({
    status: 1,
    data: { info: [row(1), { invalid: true }] },
  });
  await f.run();
  assert.equal(f.view.playlistFilteredInvalidCount.value, 1);
  assert.equal(f.cache.at(-1)[2], true);
  const count = f.cache.length;
  f.api.getPlaylistTracks = async () => {
    throw new Error('network');
  };
  await f.run();
  assert.equal(f.view.songs.value.length, 1);
  assert.equal(f.view.playlistFilteredInvalidCount.value, 1);
  assert.equal(f.cache.length, count);
});

for (const owned of [false, true]) {
  test(`playlist ${owned ? 'owned' : 'public'}: metadata completes in the background and updates shared cache without changing playback identity`, async (t) => {
    const f = fixture(t, 'Playlist');
    const gate = deferred();
    const song = {
      ...row(1),
      hash: 'original-hash',
      albumAudioId: '64323384',
      fileId: 2418,
      playlistSort: 0,
      coverUrl: '',
      privilege: 0,
    };
    f.api.getPlaylistDetail = async () => ({
      status: 1,
      data: [
        {
          id: 'A',
          count: 1,
          ...(owned ? { listid: 12, listCreateListid: 12, listCreateUserid: 7 } : {}),
        },
      ],
    });
    const requests = [];
    f.api.getPlaylistTracks = async (...args) => {
      requests.push(['public', ...args]);
      return { status: 1, data: { info: [song] } };
    };
    f.api.getPlaylistTracksNew = async (...args) => {
      requests.push(['owned', ...args]);
      return { status: 1, data: { info: [song] } };
    };
    f.setMetadata((items, isCurrent) => {
      assert.equal(items[0], song);
      assert.equal(isCurrent(), true);
      return gate.promise;
    });
    await bounded(f.run());
    assert.equal(f.view.loading.value, false);
    assert.equal(f.loader().fullyLoaded, true);
    assert.equal(requests[0][0], owned ? 'owned' : 'public');
    assert.equal(f.view.songs.value[0].coverUrl, '');
    const card = observeSongCard(t, f.view.songs);
    assert.equal(card.songCoverUrl.value, '');
    assert.deepEqual(card.songArtists.value, []);
    const covers = vue.computed(() => f.view.songs.value.map((item) => item.coverUrl));
    assert.deepEqual(covers.value, ['']);
    song.privilege = 10;
    song.relateGoods = [{ hash: 'fresh-flac', quality: 'flac' }];
    gate.resolve([
      {
        ...song,
        privilege: 0,
        relateGoods: [],
        coverUrl: 'real-cover',
        cover: 'real-cover',
        albumId: '2603117',
        albumName: '倔强',
        artists: [{ name: '云朵', id: '6743' }],
      },
    ]);
    await flush();
    assert.deepEqual(covers.value, ['real-cover']);
    assert.equal(card.songCoverUrl.value, 'real-cover');
    assert.equal(card.songArtists.value[0].id, '6743');
    assert.equal(f.view.songs.value[0].albumId, '2603117');
    assert.equal(f.view.songs.value[0].artists[0].id, '6743');
    assert.equal(f.cache.at(-1)[1][0].coverUrl, 'real-cover');
    assert.equal(f.cache.at(-1)[2], true);
    for (const key of ['id', 'hash', 'albumAudioId', 'fileId', 'playlistSort'])
      assert.equal(f.view.songs.value[0][key], song[key]);
    assert.equal(f.view.songs.value[0].privilege, 10);
    assert.equal(f.view.songs.value[0].relateGoods[0].hash, 'fresh-flac');
    assert.equal(f.view.playlist.value.count, 1);
    assert.deepEqual(f.notices, []);
  });
}

for (const change of ['route', 'account', 'refresh', 'unmount']) {
  test(`playlist: late metadata is discarded after ${change}`, async (t) => {
    const f = fixture(t, 'Playlist');
    const gate = deferred();
    const old = { ...row(1), coverUrl: '' };
    f.api.getPlaylistTracks = async () => ({ status: 1, data: { info: [old] } });
    f.setMetadata(() => gate.promise);
    await f.run();
    f.api.getPlaylistTracks = async () => ({
      status: 1,
      data: { info: [{ ...row(2), coverUrl: 'fresh-cover' }] },
    });
    f.setMetadata(async (items) => items);
    if (change === 'route') f.go('B');
    if (change === 'account') {
      f.user.info.token = 'new';
      f.playlistStore.userCollectionsGeneration++;
    }
    if (change === 'refresh') await f.run();
    if (change === 'unmount') f.stop();
    await flush();
    const current = f.view.songs.value;
    gate.resolve([{ ...old, coverUrl: 'stale-cover', albumId: '999' }]);
    await flush();
    assert.equal(old.coverUrl, '');
    assert.equal(f.view.songs.value, current);
    if (change !== 'unmount') assert.equal(f.view.songs.value[0].coverUrl, 'fresh-cover');
    assert.deepEqual(f.notices, []);
  });
}

test('playlist metadata never restores locally removed songs or drops a concurrent addition', async (t) => {
  const f = fixture(t, 'Playlist');
  const gate = deferred();
  const first = { ...row(1), coverUrl: '' },
    second = { ...row(2), coverUrl: '' };
  f.api.getPlaylistDetail = async () => ({ status: 1, data: [{ id: 'A', count: 2 }] });
  f.api.getPlaylistTracks = async () => ({ status: 1, data: { info: [first, second] } });
  f.setMetadata(() => gate.promise);
  await f.run();
  f.view.applyRemovedPlaylistSongs([first]);
  f.view.applyAddedPlaylistSongs([row(3)]);
  gate.resolve([
    { ...first, coverUrl: 'removed-cover' },
    { ...second, coverUrl: 'remaining-cover' },
  ]);
  await flush();
  assert.deepEqual(
    f.view.songs.value.map((song) => song.id),
    ['3', '2'],
  );
  assert.equal(f.view.songs.value[1].coverUrl, 'remaining-cover');
  assert.equal(f.view.playlist.value.count, 2);
  assert.equal(f.view.loadedSongCount.value, 2);
  assert.deepEqual(
    f.cache.at(-1)[1].map((song) => song.id),
    ['3', '2'],
  );
});

test('playlist completion replaces only changed row props and preserves every untouched row reference', async (t) => {
  const f = fixture(t, 'Playlist');
  const gate = deferred();
  const changed = { ...row(1), coverUrl: '' },
    unchanged = { ...row(2), coverUrl: 'existing-cover' };
  f.api.getPlaylistTracks = async () => ({ status: 1, data: { info: [changed, unchanged] } });
  f.setMetadata(() => gate.promise);
  await f.run();
  const card = observeSongCard(t, f.view.songs);
  assert.equal(card.songCoverUrl.value, '');
  gate.resolve([{ ...changed, coverUrl: 'real-cover' }, unchanged]);
  await flush();
  assert.notEqual(f.view.songs.value[0], changed);
  assert.equal(f.view.songs.value[1], unchanged);
  assert.equal(card.songCoverUrl.value, 'real-cover');
  assert.equal(f.cache.at(-1)[1][0], changed);
  assert.equal(changed.coverUrl, 'real-cover');
});

test('playlist metadata failure leaves the complete song list playable without a load failure toast', async (t) => {
  const f = fixture(t, 'Playlist');
  f.setMetadata(async () => {
    throw Error('optional metadata unavailable');
  });
  await bounded(f.run());
  await flush();
  assert.equal(f.view.songs.value.length, 1);
  assert.equal(f.view.loading.value, false);
  assert.equal(f.loader().fullyLoaded, true);
  assert.deepEqual(f.notices, []);
});

test('playlist metadata only receives accepted, deduplicated page songs, excluding speculative pages', async (t) => {
  const f = fixture(t, 'Playlist');
  const batches = [];
  f.api.getPlaylistDetail = async () => ({ status: 1, data: [{ id: 'A', count: 201 }] });
  f.api.getPlaylistTracks = async (_id, p) =>
    page(p === 1 ? range(200) : p === 2 ? [0, 200] : [999]);
  f.setMetadata(async (songs) => {
    batches.push(songs.map((song) => song.id));
    return songs;
  });
  await f.run();
  await flush();
  assert.equal(f.view.songs.value.length, 201);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 200);
  assert.deepEqual(batches[1], ['200']);
  assert.ok(!batches.flat().includes('999'));
});

test('owned playlist sidebar cover receives completed artwork once after the full snapshot without another page request', async (t) => {
  const f = fixture(t, 'Playlist'),
    gate = deferred();
  const song = { ...row(1), coverUrl: '' };
  let reads = 0;
  f.api.getPlaylistDetail = async () => ({
    status: 1,
    data: [{ id: 'A', listid: 12, listCreateListid: 12, listCreateUserid: 7, count: 1 }],
  });
  f.api.getPlaylistTracksNew = async () => {
    reads++;
    return { status: 1, data: { info: [song] } };
  };
  f.setMetadata(() => gate.promise);
  await bounded(f.run());
  assert.equal(f.covers.length, 1);
  gate.resolve([{ ...song, coverUrl: 'real-cover' }]);
  await flush();
  assert.equal(reads, 1);
  assert.equal(f.covers.length, 2);
  assert.equal(f.covers[1][4][0].coverUrl, 'real-cover');
  assert.equal(f.covers[1][3](), true);
});

test('playlist edits invalidate the delayed enriched sidebar cover snapshot', async (t) => {
  const f = fixture(t, 'Playlist'),
    gate = deferred();
  f.api.getPlaylistDetail = async () => ({
    status: 1,
    data: [{ id: 'A', listid: 12, listCreateListid: 12, listCreateUserid: 7, count: 1 }],
  });
  f.setMetadata(() => gate.promise);
  await f.run();
  f.playlistStore.playlistContentVersions['12'] = 1;
  gate.resolve([{ ...row(1), coverUrl: 'stale-cover' }]);
  await flush();
  assert.equal(f.covers.length, 1);
  assert.equal(f.covers[0][3](), false);
});

test('playlist speculative pages after the terminal page do not add filtered-song counts or covers', async (t) => {
  const f = fixture(t, 'Playlist');
  f.api.getPlaylistDetail = async () => ({
    status: 1,
    data: [{ id: 'A', listid: 12, listCreateListid: 12, listCreateUserid: 7, count: 301 }],
  });
  f.api.getPlaylistTracksNew = async (_id, p) => ({
    status: 1,
    data: { info: p === 1 ? range(300).map(row) : p === 2 ? [row(300)] : [{ invalid: true }] },
  });
  await f.run();
  assert.equal(f.view.songs.value.length, 301);
  assert.equal(f.view.playlistFilteredInvalidCount.value, 0);
  assert.equal(f.covers.length, 1);
  assert.equal(f.covers[0][2].length, 2);
});

test('playlist account replacement clears private data immediately and reloads once', async (t) => {
  const f = fixture(t, 'Playlist');
  await f.run();
  let reads = 0;
  f.api.getPlaylistDetail = async () => {
    reads++;
    return { status: 1, data: [{ id: 'A', count: 1 }] };
  };
  f.user.info.token = 'two';
  f.user.accountRevision++;
  f.playlistStore.userCollectionsGeneration++;
  assert.equal(f.view.playlist.value, null);
  assert.equal(f.view.songs.value.length, 0);
  await flush();
  await flush();
  assert.equal(reads, 1);
  assert.equal(f.view.songs.value.length, 1);
});

for (const kind of ['Album', 'Artist']) {
  test(`${kind}: request failure cannot replace existing metadata`, async (t) => {
    const f = fixture(t, kind);
    await f.view.fetchData();
    const target = kind === 'Album' ? 'album' : 'artist';
    const meta = f.view[target].value;
    f.api[kind === 'Album' ? 'getAlbumDetail' : 'getArtistDetail'] = async () => {
      throw new Error('network');
    };
    await f.view.fetchData();
    assert.equal(f.view[target].value, meta);
    assert.ok(f.notices.includes(kind === 'Album' ? '专辑详情' : '歌手详情'));
  });
}

for (const name of ['mvs', 'albums']) {
  const apiName = name === 'mvs' ? 'getArtistVideos' : 'getArtistAlbums';
  const fetch = name === 'mvs' ? 'fetchMvs' : 'fetchMoreAlbums';
  const loading = name === 'mvs' ? 'loadingMvs' : 'loadingAlbums';
  const payload = (id) =>
    name === 'mvs' ? { status: 1, data: [{ video_id: id, video_name: id }], total: 1 } : page([id]);
  test(`artist ${name}: resource switch releases old loading and rejects old data/finally`, async (t) => {
    const f = fixture(t, 'Artist'),
      old = deferred(),
      fresh = deferred();
    f.api[apiName] = (id) => (id === 'A' ? old.promise : fresh.promise);
    const first = f.view[fetch]();
    f.go('B');
    await flush();
    assert.equal(f.view[loading].value, false);
    const second = f.view[fetch]();
    old.resolve(payload('old'));
    await first;
    assert.equal(f.view[loading].value, true);
    assert.equal(f.view[name].value.length, 0);
    fresh.resolve(payload('new'));
    await second;
    assert.equal(f.view[name].value[0][name === 'mvs' ? 'videoId' : 'id'], 'new');
  });
  test(`artist ${name}: unmount rejects a late response and blocks new requests`, async (t) => {
    const f = fixture(t, 'Artist'),
      gate = deferred();
    let reads = 0;
    f.api[apiName] = () => {
      reads++;
      return gate.promise;
    };
    const pending = f.view[fetch]();
    f.stop();
    gate.resolve(payload('late'));
    await pending;
    assert.equal(f.view[name].value.length, 0);
    await f.view[fetch]();
    assert.equal(reads, 1);
    assert.deepEqual(f.notices, []);
  });
  test(`artist ${name}: request failure preserves cached content and permits retry`, async (t) => {
    const f = fixture(t, 'Artist');
    f.api[apiName] = async () => payload('kept');
    await f.view[fetch]();
    const items = f.view[name].value;
    if (name === 'albums') f.view.albumHasMore.value = true;
    f.api[apiName] = async () => {
      throw new Error('network');
    };
    await f.view[fetch]();
    assert.equal(f.view[name].value, items);
    assert.equal(f.view[loading].value, false);
    assert.equal(f.notices.length, 1);
  });
}

test('artist MV tag switching loads the new tag immediately and rejects the old tag', async (t) => {
  const f = fixture(t, 'Artist'),
    old = deferred(),
    fresh = deferred();
  const tags = [];
  f.api.getArtistVideos = (_id, _page, _size, tag) => {
    tags.push(tag);
    return tag === 'all' ? old.promise : fresh.promise;
  };
  const first = f.view.fetchMvs();
  f.view.switchMvTag('live');
  old.resolve({ status: 1, data: [{ video_id: 'old' }], total: 1 });
  await first;
  assert.deepEqual(tags, ['all', 'live']);
  assert.equal(f.view.loadingMvs.value, true);
  assert.equal(f.view.mvs.value.length, 0);
  fresh.resolve({ status: 1, data: [{ video_id: 'new' }], total: 1 });
  await flush();
  assert.equal(f.view.mvs.value[0].videoId, 'new');
});

test('artist albums keep the next page available before metadata supplies the count', async (t) => {
  const f = fixture(t, 'Artist');
  f.api.getArtistAlbums = async (_id, p) => page(p === 1 ? range(30) : [30]);
  await f.view.fetchMoreAlbums();
  assert.equal(f.view.albumHasMore.value, true);
  await f.view.fetchMoreAlbums();
  assert.equal(f.view.albums.value.length, 31);
  assert.equal(f.view.albumPage.value, 2);
  assert.equal(f.view.albumHasMore.value, false);
});

for (const kind of ['Album', 'Artist', 'Playlist']) {
  for (const change of ['queue', 'content', 'route']) {
    test(`${kind}: late song pagination does not expand playback after a ${change} change`, async (t) => {
      const f = fixture(t, kind),
        rest = deferred();
      const size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
      if (kind === 'Artist') f.view.artist.value = { id: 'A', songCount: size + 1 };
      f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
      const pending = f.run();
      await flush();
      const playing = f.view.handlePlayAll();
      await flush();
      const queue = f.queues.get(`queue:${kind.toLowerCase()}:A`);
      assert.ok(queue);
      if (change === 'queue') f.playlistStore.activeQueueId = 'manual';
      if (change === 'content') {
        queue.songs = [row('manual')];
        queue.playbackRevision++;
      }
      if (change === 'route') f.id.value = 'B';
      rest.resolve(page([size]));
      await pending;
      await bounded(playing);
      assert.equal(f.queueUpdates.length, 0);
    });
  }
  test(`${kind}: completed pagination expands its unchanged playback queue`, async (t) => {
    const f = fixture(t, kind),
      rest = deferred();
    const size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { id: 'A', songCount: size + 1 };
    f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
    const pending = f.run();
    await flush();
    const playing = f.view.handlePlayAll();
    await flush();
    rest.resolve(page([size]));
    await pending;
    await bounded(playing);
    assert.equal(f.queueUpdates.length, 1);
    assert.equal(f.queueUpdates[0][0].length, size + 1);
  });
}

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: a failed later page retains the initial partial list without marking it complete`, async (t) => {
    const f = fixture(t, kind),
      size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = async (_id, p) =>
      p === 1 ? page(range(size)) : Promise.reject(new Error('network'));
    await f.run();
    await bounded(f.loader().waitForAll());
    assert.equal(f.loader().failed, true);
    assert.equal(f.loader().fullyLoaded, false);
    assert.equal(f.view.songs.value.length, size);
    assert.equal(f.notices.length, 1);
    if (kind === 'Playlist') assert.ok(f.cache.every((entry) => !entry[2]));
  });
  test(`${kind}: playback switched while initial play is pending is not reactivated by expansion`, async (t) => {
    const f = fixture(t, kind),
      play = deferred(),
      rest = deferred(),
      size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
    const loading = f.run();
    await flush();
    f.setPlay(() => play.promise);
    const playing = f.view.handlePlayAll();
    f.playlistStore.activeQueueId = 'manual';
    play.resolve(true);
    rest.resolve(page([size]));
    await loading;
    await bounded(playing);
    assert.equal(f.queueUpdates.length, 0);
  });
}

for (const kind of ['Album', 'Artist']) {
  test(`${kind}: complete songs survive multiple failed refreshes and a later-page refresh failure`, async (t) => {
    const f = fixture(t, kind),
      size = kind === 'Album' ? 30 : 100;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = async (_id, p) => page(p === 1 ? range(size) : p === 2 ? [size] : []);
    await f.run();
    await bounded(f.loader().waitForAll());
    const songs = f.view.songs.value;
    for (let attempt = 0; attempt < 2; attempt++) {
      f.api[f.songApi] = async () => {
        throw new Error('network');
      };
      await f.run();
      await bounded(f.loader().waitForAll());
      assert.equal(f.view.songs.value, songs);
    }
    f.api[f.songApi] = async (_id, p) =>
      p === 1 ? page(range(size)) : Promise.reject(new Error('network'));
    await f.run();
    await bounded(f.loader().waitForAll());
    assert.equal(f.view.songs.value, songs);
    assert.equal(f.loader().failed, true);
  });
}

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: pages completing during initial playback still expand the original queue`, async (t) => {
    const f = fixture(t, kind),
      play = deferred(),
      rest = deferred(),
      size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
    const loading = f.run();
    await flush();
    f.setPlay(() => play.promise);
    const playing = f.view.handlePlayAll();
    rest.resolve(page([size]));
    await loading;
    await bounded(f.loader().waitForAll());
    play.resolve(true);
    await bounded(playing);
    assert.equal(f.queueUpdates.length, 1);
    assert.equal(f.queueUpdates[0][0].length, size + 1);
  });
}

test('artist resource switch after a complete list still publishes the next artist first page immediately', async (t) => {
  const f = fixture(t, 'Artist');
  await f.run();
  const rest = deferred();
  f.api.getArtistSongsV2 = (_id, p) => (p === 1 ? Promise.resolve(page(range(100))) : rest.promise);
  f.go('B');
  await flush();
  await flush();
  assert.equal(f.view.songs.value.length, 100);
  assert.equal(f.view.loadedSongCount.value, 100);
  rest.resolve(page([]));
  await bounded(f.loader().waitForAll());
});

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: background queue expansion uses the search captured when playback started`, async (t) => {
    const f = fixture(t, kind),
      rest = deferred(),
      size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
    const loading = f.run();
    await flush();
    const playing = f.view.handlePlayAll();
    await flush();
    f.view.searchQuery.value = 'song 0';
    rest.resolve(page([size]));
    await loading;
    await bounded(playing);
    assert.equal(f.queueUpdates.length, 1);
    assert.equal(f.queueUpdates[0][0].length, size + 1);
  });
}

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: unsuccessful initial playback does not expand the queue`, async (t) => {
    const f = fixture(t, kind),
      rest = deferred(),
      size = kind === 'Album' ? 30 : kind === 'Artist' ? 100 : 200;
    if (kind === 'Artist') f.view.artist.value = { songCount: size + 1 };
    f.api[f.songApi] = (_id, p) => (p === 1 ? Promise.resolve(page(range(size))) : rest.promise);
    const loading = f.run();
    await flush();
    f.setPlay(async () => false);
    const playing = f.view.handlePlayAll();
    rest.resolve(page([size]));
    await loading;
    await bounded(playing);
    assert.equal(f.queueUpdates.length, 0);
  });
}

// Round 10: exercise comment and collection actions through the compiled detail pages.
const comment = (id, content = `comment ${id}`) => ({ id: String(id), content });
const commentPage = (list, total, hot = []) => ({
  status: 1,
  data: { list, ...(total === undefined ? {} : { total }), hot_list: hot },
});
for (const kind of ['Album', 'Playlist']) {
  const method = `get${kind}Comments`;
  test(`round10: ${kind} late comments cannot replace the next resource or release its loading flag`, async (t) => {
    const f = fixture(t, kind),
      old = deferred(),
      fresh = deferred();
    f.api[method] = (id) => (id === 'A' ? old.promise : fresh.promise);
    const first = f.view.fetchComments(true);
    f.go('B');
    const second = f.view.fetchComments(true);
    old.resolve(commentPage([comment('old')], 1));
    await first;
    assert.deepEqual(f.view.comments.value, []);
    assert.equal(f.view.loadingComments.value, true);
    fresh.resolve(commentPage([comment('new')], 1));
    await second;
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['new'],
    );
    assert.equal(f.view.loadingComments.value, false);
  });
  for (const reject of [false, true]) {
    test(`round10: ${kind} disposed comment ${reject ? 'failure' : 'success'} is ignored`, async (t) => {
      const f = fixture(t, kind),
        task = deferred();
      f.api[method] = () => task.promise;
      const request = f.view.fetchComments(true);
      f.stop();
      if (reject) task.reject(new Error('late failure'));
      else task.resolve(commentPage([comment('late')], 1));
      await request;
      assert.deepEqual(f.view.comments.value, []);
      assert.deepEqual(f.notices, []);
    });
  }
  for (const change of ['revision', 'token', 'userId', 'logout']) {
    test(`round10: ${kind} ${change} invalidates displayed and pending account comments`, async (t) => {
      const f = fixture(t, kind),
        task = deferred();
      f.api[method] = async () => commentPage([comment('shown')], 1);
      await f.view.fetchComments(true);
      f.api[method] = () => task.promise;
      const request = f.view.fetchComments(true);
      if (change === 'revision') f.user.accountRevision++;
      if (change === 'token') f.user.info.token = 'two';
      if (change === 'userId') f.user.info.userid = 8;
      if (change === 'logout') f.user.isLoggedIn = false;
      assert.deepEqual(f.view.comments.value, []);
      task.resolve(commentPage([comment('late')], 1));
      await request;
      assert.deepEqual(f.view.comments.value, []);
      assert.equal(f.view.loadingComments.value, false);
    });
  }
  test(`round10: ${kind} failed next page retains a retryable page`, async (t) => {
    const f = fixture(t, kind),
      calls = [];
    let fail = true;
    f.api[method] = async (_id, page) => {
      calls.push(page);
      if (page === 1)
        return commentPage(
          range(30).map((i) => comment(i)),
          31,
        );
      if (fail) throw new Error('temporary failure');
      return commentPage([comment(30)], 31);
    };
    await f.view.fetchComments(true);
    await f.view.fetchComments();
    assert.equal(f.view.hasMoreComments.value, true);
    assert.equal(f.view.comments.value.length, 30);
    fail = false;
    await f.view.fetchComments();
    assert.deepEqual(calls, [1, 2, 2]);
    assert.equal(f.view.comments.value.length, 31);
    assert.equal(f.view.hasMoreComments.value, false);
  });
  for (const total of [31, undefined]) {
    test(`round10: ${kind} filtered full pages continue using raw pagination, total ${total}`, async (t) => {
      const f = fixture(t, kind),
        calls = [];
      f.api[method] = async (_id, page) => {
        calls.push(page);
        return commentPage(
          page === 1 ? range(30).map((i) => comment(i, '')) : [comment(30)],
          total,
        );
      };
      await f.view.fetchComments(true);
      assert.equal(f.view.comments.value.length, 0);
      assert.equal(f.view.hasMoreComments.value, true);
      await f.view.fetchComments();
      assert.deepEqual(calls, [1, 2]);
      assert.deepEqual(
        f.view.comments.value.map((r) => r.id),
        ['30'],
      );
      assert.equal(f.view.hasMoreComments.value, false);
      if (total) assert.equal(f.view.commentTotal.value, total);
    });
  }
  test(`round10: ${kind} short unknown-total page is terminal`, async (t) => {
    const f = fixture(t, kind);
    f.api[method] = async () => commentPage([comment('only')]);
    await f.view.fetchComments(true);
    assert.equal(f.view.hasMoreComments.value, false);
  });
  test(`round10: ${kind} refresh during a pending request starts a replacement`, async (t) => {
    const f = fixture(t, kind),
      old = deferred();
    let calls = 0;
    f.api[method] = () =>
      ++calls === 1 ? old.promise : Promise.resolve(commentPage([comment('new')], 1));
    const first = f.view.fetchComments(true);
    await f.view.fetchComments(true);
    assert.equal(calls, 2);
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['new'],
    );
    old.resolve(commentPage([comment('old')], 1));
    await first;
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['new'],
    );
  });
  test(`round10: ${kind} comments render while VIP enrichment is pending and stale VIP cannot overwrite the next resource`, async (t) => {
    const f = fixture(t, kind),
      vip = deferred();
    t.after(() => vip.resolve([comment('same', 'old VIP')]));
    f.setVip((rows) => (rows.length ? vip.promise : Promise.resolve(rows)));
    f.api[method] = async () => commentPage([comment('same', 'old')], 1);
    await bounded(f.view.fetchComments(true));
    assert.equal(f.view.loadingComments.value, false);
    assert.equal(f.view.comments.value[0].content, 'old');
    f.go('B');
    f.setVip(async (rows) => rows);
    f.api[method] = async () => commentPage([comment('same', 'new')], 1);
    await f.view.fetchComments(true);
    vip.resolve([comment('same', 'old VIP')]);
    await flush();
    assert.equal(f.view.comments.value[0].content, 'new');
  });
  test(`round10: ${kind} successful VIP enrichment preserves previously loaded pages`, async (t) => {
    const f = fixture(t, kind),
      vip = deferred();
    f.setVip((rows) => (rows.length === 30 ? vip.promise : Promise.resolve(rows)));
    f.api[method] = async (_id, page) =>
      commentPage(page === 1 ? range(30).map((i) => comment(i)) : [comment(30)], 31);
    await bounded(f.view.fetchComments(true));
    await f.view.fetchComments();
    vip.resolve(range(30).map((i) => ({ ...comment(i), badges: ['VIP'] })));
    await flush();
    assert.equal(f.view.comments.value.length, 31);
    assert.deepEqual(f.view.comments.value[0].badges, ['VIP']);
    assert.equal(f.view.comments.value[30].id, '30');
  });
  test(`round10: ${kind} ordinary profile information replacement preserves comments`, async (t) => {
    const f = fixture(t, kind);
    f.api[method] = async () => commentPage([comment('shown')], 1);
    await f.view.fetchComments(true);
    f.user.info = { ...f.user.info, nickname: 'new name' };
    await flush();
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['shown'],
    );
  });
}

for (const kind of ['Album', 'Artist']) {
  const action = kind === 'Album' ? 'toggleFavoriteAlbum' : 'toggleArtistFollow';
  const method = kind === 'Album' ? 'favoriteAlbum' : 'followArtist';
  const prepare = async (f) => {
    await f.view.fetchData();
    await flush();
  };
  for (const change of ['route', 'revision', 'token', 'logout', 'unmount']) {
    test(`round10: ${kind} ${change} prevents late collection changes and feedback`, async (t) => {
      const f = fixture(t, kind),
        task = deferred();
      await prepare(f);
      f.api[method] = () => task.promise;
      const request = f.view[action]();
      if (change === 'route') f.go('B');
      if (change === 'revision') f.user.accountRevision++;
      if (change === 'token') f.user.info.token = 'two';
      if (change === 'logout') f.user.isLoggedIn = false;
      if (change === 'unmount') f.stop();
      task.resolve({ status: 1 });
      await request;
      assert.deepEqual(f.followed, []);
      assert.deepEqual(f.mutations, []);
      assert.deepEqual(f.notices, []);
    });
  }
  test(`round10: ${kind} duplicate collection clicks share one operation`, async (t) => {
    const f = fixture(t, kind),
      task = deferred();
    await prepare(f);
    let calls = 0;
    f.api[method] = () => {
      calls++;
      return task.promise;
    };
    const first = f.view[action]();
    const second = f.view[action]();
    assert.equal(calls, 1);
    task.resolve({ status: 1 });
    await Promise.all([first, second]);
    assert.equal(f.notices.length, 1);
    if (kind === 'Artist') assert.deepEqual(f.followed, [['add', 'A']]);
    else assert.deepEqual(f.mutations, ['reload']);
  });
  test(`round10: ${kind} old request does not release a newer account operation`, async (t) => {
    const f = fixture(t, kind),
      old = deferred(),
      fresh = deferred();
    await prepare(f);
    let calls = 0;
    f.api[method] = () => (++calls === 1 ? old.promise : fresh.promise);
    const first = f.view[action]();
    f.user.accountRevision++;
    const second = f.view[action]();
    assert.equal(calls, 2);
    old.resolve({ status: 1 });
    await first;
    await bounded(f.view[action]());
    assert.equal(calls, 2);
    fresh.resolve({ status: 1 });
    await second;
    assert.equal(f.notices.length, 1);
  });
}

for (const kind of ['Album', 'Playlist']) {
  const method = `get${kind}Comments`;
  test(`round10: ${kind} late VIP only patches identity fields`, async (t) => {
    const f = fixture(t, kind),
      vip = deferred();
    f.setVip((rows) => (rows.length ? vip.promise : Promise.resolve([])));
    f.api[method] = async () =>
      commentPage([{ ...comment('shown'), likeCount: 1, raw: { like_count: 1 } }], 1);
    await bounded(f.view.fetchComments(true));
    f.view.comments.value[0].content = 'edited locally';
    f.view.comments.value[0].likeCount = 2;
    f.view.comments.value[0].raw.like_count = 2;
    vip.resolve([
      {
        ...comment('shown'),
        likeCount: 1,
        raw: { like_count: 1, busi_vip: ['vip'] },
        badges: ['VIP'],
      },
    ]);
    await flush();
    assert.equal(f.view.comments.value[0].content, 'edited locally');
    assert.equal(f.view.comments.value[0].likeCount, 2);
    assert.equal(f.view.comments.value[0].raw.like_count, 2);
    assert.deepEqual(f.view.comments.value[0].badges, ['VIP']);
    assert.deepEqual(f.view.comments.value[0].raw.busi_vip, ['vip']);
  });
  test(`round10: ${kind} rejected VIP does not block visible comments or retries`, async (t) => {
    const f = fixture(t, kind);
    f.setVip(async () => {
      throw new Error('VIP unavailable');
    });
    f.api[method] = async () => commentPage([comment('shown')], 1);
    await f.view.fetchComments(true);
    await flush();
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['shown'],
    );
    assert.equal(f.view.loadingComments.value, false);
    assert.deepEqual(f.notices, []);
  });
  test(`round10: ${kind} account change reloads an active comments tab`, async (t) => {
    const f = fixture(t, kind),
      calls = [];
    await f.view.fetchData();
    f.api[method] = async () => {
      calls.push(f.user.info.userid);
      return commentPage([comment(f.user.info.userid)], 1);
    };
    f.tab.value = 'comments';
    await flush();
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['7'],
    );
    f.user.info = { userid: 8, token: 'two' };
    assert.deepEqual(f.view.comments.value, []);
    await flush();
    assert.deepEqual(
      f.view.comments.value.map((r) => r.id),
      ['8'],
    );
    assert.ok(calls.includes(8));
  });
  test(`round10: ${kind} explicit empty comments clear the previous snapshot and total`, async (t) => {
    const f = fixture(t, kind);
    f.api[method] = async () => commentPage([comment('shown')], 1);
    await f.view.fetchComments(true);
    f.api[method] = async () => commentPage(null, 0);
    await f.view.fetchComments(true);
    assert.deepEqual(f.view.comments.value, []);
    assert.equal(f.view.commentTotal.value, 0);
    assert.equal(f.view.hasMoreComments.value, false);
    assert.deepEqual(f.notices, []);
  });
}

test('round10: Playlist metadata comment identity invalidates the route-ID request immediately', async (t) => {
  const f = fixture(t, 'Playlist'),
    old = deferred();
  f.api.getPlaylistComments = (id) =>
    id === 'A' ? old.promise : Promise.resolve(commentPage([comment('gid')], 1));
  const first = f.view.fetchComments(true);
  f.view.playlist.value = { id: 'A', globalCollectionId: 'collection-id' };
  assert.equal(f.view.loadingComments.value, false);
  await f.view.fetchComments(true);
  old.resolve(commentPage([comment('old')], 1));
  await first;
  assert.deepEqual(
    f.view.comments.value.map((r) => r.id),
    ['gid'],
  );
});

for (const kind of ['Album', 'Artist']) {
  const action = kind === 'Album' ? 'toggleFavoriteAlbum' : 'toggleArtistFollow';
  const method = kind === 'Album' ? 'unfavoriteAlbum' : 'unfollowArtist';
  test(`round10: ${kind} removal captures original target and preserves failure for retry`, async (t) => {
    const f = fixture(t, kind),
      calls = [];
    await f.view.fetchData();
    if (kind === 'Album')
      f.playlistStore.userPlaylists = [{ source: 2, id: 'A', listid: 'list-A' }];
    else f.user.isArtistFollowed = () => true;
    let success = false;
    f.api[method] = async (id) => {
      calls.push(id);
      return { status: success ? 1 : 0 };
    };
    await f.view[action]();
    assert.deepEqual(f.followed, []);
    assert.deepEqual(f.mutations, []);
    success = true;
    await f.view[action]();
    assert.deepEqual(calls, kind === 'Album' ? ['list-A', 'list-A'] : ['A', 'A']);
    if (kind === 'Artist') assert.deepEqual(f.followed, [['remove', 'A']]);
    else assert.deepEqual(f.mutations, ['reload']);
    assert.deepEqual(
      f.notices.map((n) => n[0]),
      ['actionFailed', 'actionCompleted'],
    );
  });
  test(`round10: ${kind} stale collection rejection is silent`, async (t) => {
    const f = fixture(t, kind),
      task = deferred();
    await f.view.fetchData();
    f.api[kind === 'Album' ? 'favoriteAlbum' : 'followArtist'] = () => task.promise;
    const request = f.view[action]();
    f.user.accountRevision++;
    task.reject(new Error('old account failure'));
    await request;
    assert.deepEqual(f.notices, []);
  });
}

test('round10: Album account switch during collection reload suppresses stale feedback', async (t) => {
  const f = fixture(t, 'Album'),
    reload = deferred();
  await f.view.fetchData();
  f.playlistStore.fetchUserPlaylists = () => reload.promise;
  const request = f.view.toggleFavoriteAlbum();
  await flush();
  f.user.accountRevision++;
  reload.resolve();
  await request;
  assert.deepEqual(f.notices, []);
});

const prepareBlacklistArtist = async (t) => {
  const f = fixture(t, 'Artist');
  f.view.artist.value = { id: 'A', singerid: 7, name: 'original singer' };
  await flush();
  return f;
};
const blacklistInvalidations = {
  revision: (f) => f.user.accountRevision++,
  token: (f) => {
    f.user.info.token = 'two';
  },
  logout: (f) => {
    f.user.isLoggedIn = false;
  },
  route: (f) => {
    f.id.value = 'B';
  },
  singer: (f) => {
    f.view.artist.value = { singerid: 8, name: 'new singer' };
  },
  unmount: (f) => f.stop(),
};
for (const [name, invalidate] of Object.entries(blacklistInvalidations)) {
  for (const loaded of [true, false]) {
    test(`round12: Artist blacklist ${name} during load ignores ${loaded ? 'success' : 'failure'}`, async (t) => {
      const f = await prepareBlacklistArtist(t);
      const read = deferred();
      f.blacklist.state = 'unknown';
      f.blacklist.ensureFullyLoaded = () => read.promise;
      const operation = f.view.toggleArtistBlacklist();
      assert.equal(f.view.togglingBlacklist.value, true);
      invalidate(f);
      f.blacklist.state = 'absent';
      read.resolve(loaded);
      await bounded(operation);
      assert.deepEqual(f.blacklistWrites, []);
      assert.deepEqual(f.notices, []);
    });
  }
  test(`round12: Artist blacklist ${name} during write ignores old feedback`, async (t) => {
    const f = await prepareBlacklistArtist(t);
    const write = deferred();
    f.blacklist.addSinger = (target) => {
      f.blacklistWrites.push(['add', target]);
      return write.promise;
    };
    const operation = f.view.toggleArtistBlacklist();
    assert.equal(f.blacklistWrites.length, 1);
    invalidate(f);
    write.resolve(true);
    await bounded(operation);
    assert.deepEqual(f.notices, []);
  });
}
test('round12: Artist old write cannot release new session busy state', async (t) => {
  const f = await prepareBlacklistArtist(t);
  const first = deferred(),
    second = deferred();
  f.blacklist.addSinger = (target) => {
    f.blacklistWrites.push(['add', target]);
    return f.blacklistWrites.length === 1 ? first.promise : second.promise;
  };
  const old = f.view.toggleArtistBlacklist();
  f.user.accountRevision++;
  const current = f.view.toggleArtistBlacklist();
  assert.equal(f.blacklistWrites.length, 2);
  first.resolve(false);
  await bounded(old);
  assert.equal(f.view.togglingBlacklist.value, true);
  await bounded(f.view.toggleArtistBlacklist());
  assert.equal(f.blacklistWrites.length, 2);
  second.resolve(true);
  await bounded(current);
  assert.equal(f.view.togglingBlacklist.value, false);
  assert.deepEqual(f.notices, [['actionCompleted', '已屏蔽歌手']]);
});
test('round12: Artist captures name before list load and deduplicates submission', async (t) => {
  const f = await prepareBlacklistArtist(t);
  const read = deferred();
  f.blacklist.state = 'unknown';
  f.blacklist.ensureFullyLoaded = () => read.promise;
  const operation = f.view.toggleArtistBlacklist();
  await bounded(f.view.toggleArtistBlacklist());
  f.view.artist.value = { id: 'A', singerid: 7, name: 'refreshed singer' };
  f.blacklist.state = 'absent';
  read.resolve(true);
  await bounded(operation);
  assert.deepEqual(f.blacklistWrites, [['add', { singerId: '7', name: 'original singer' }]]);
  assert.equal(f.view.togglingBlacklist.value, false);
});
test('round12: Artist current remove uses the loaded row', async (t) => {
  const f = await prepareBlacklistArtist(t);
  const entry = { label: 'singer', key: '7', name: 'original singer' };
  f.blacklist.singer.entries = [entry];
  f.blacklist.state = 'present';
  await f.view.toggleArtistBlacklist();
  assert.equal(f.blacklistWrites[0][0], 'remove');
  assert.equal(vue.toRaw(f.blacklistWrites[0][1]), entry);
  assert.deepEqual(f.notices, [['actionCompleted', '已取消屏蔽']]);
});
test('round12: Artist failed load preserves retry and reports current error', async (t) => {
  const f = await prepareBlacklistArtist(t);
  f.blacklist.state = 'unknown';
  f.blacklist.singer.error = 'read failed';
  f.blacklist.ensureFullyLoaded = async () => false;
  await f.view.toggleArtistBlacklist();
  assert.deepEqual(f.notices, [['warning', 'read failed']]);
  assert.deepEqual(f.blacklistWrites, []);
  assert.equal(f.view.togglingBlacklist.value, false);
  f.blacklist.state = 'absent';
  await f.view.toggleArtistBlacklist();
  assert.equal(f.blacklistWrites.length, 1);
});
test('round12: Artist does not infer absence from an unresolved status', async (t) => {
  const f = await prepareBlacklistArtist(t);
  f.blacklist.state = 'unknown';
  await f.view.toggleArtistBlacklist();
  assert.deepEqual(f.blacklistWrites, []);
  assert.equal(f.notices[0][0], 'warning');
  assert.equal(f.view.togglingBlacklist.value, false);
});
test('round12: Artist does not add when a present row is missing', async (t) => {
  const f = await prepareBlacklistArtist(t);
  f.blacklist.state = 'present';
  await f.view.toggleArtistBlacklist();
  assert.deepEqual(f.blacklistWrites, []);
  assert.deepEqual(f.notices, []);
});

for (const kind of ['Album', 'Artist', 'Playlist']) {
  test(`${kind}: empty object response retains original empty-page behavior`, async (t) => {
    const f = fixture(t, kind);
    f.api[f.songApi] = async () => ({ status: 1, data: {} });
    await f.run();
    await bounded(f.loader().waitForAll());
    assert.deepEqual(f.view.songs.value, []);
    assert.equal(f.loader().failed, false);
    assert.equal(f.loader().fullyLoaded, true);
    assert.deepEqual(f.notices, []);
  });
}

for (const kind of ['Album', 'Artist', 'Playlist']) {
  for (const payload of [
    { status: 1, error_code: 0, errcode: 0, errmsg: '', data: [{}] },
    { status: 1, data: [] },
    { status: 1, data: null },
  ]) {
    test(`${kind}: successful empty detail ${JSON.stringify(payload.data)} stays unavailable without an assertion`, async (t) => {
      const f = fixture(t, kind);
      f.api[`get${kind}Detail`] = async () => payload;
      await f.view.fetchData();
      assert.equal(f.view[kind.toLowerCase()].value, null);
      if (f.loader()) await bounded(f.loader().waitForAll());
      assert.equal(f.view.loading.value, false);
      assert.deepEqual(f.notices, []);
      assert.deepEqual(f.errors, []);
    });
  }
}

// Render the production template and actual error component. Other components
// are slot wrappers so this checks the page branch without Electron/DOM globals.
async function renderDetailState(kind, view) {
  const filename = `src/renderer/views/details/${kind}Detail.vue`;
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: `detail-state-${kind}`,
  });
  assert.deepEqual(template.errors, []);
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(template.code, { format: 'cjs' }).code,
  )(
    (id) => {
      assert.equal(id, 'vue');
      return vue;
    },
    module,
    module.exports,
  );
  const wrapper = vue.defineComponent({
    setup(_, { slots }) {
      return () => vue.h('div', slots.default?.());
    },
  });
  const errorSfc = parse(
    readFileSync('src/renderer/components/music/DetailPageError.vue', 'utf8'),
  ).descriptor;
  const errorModule = { exports: {} };
  const errorCode = transformSync(
    compileScript(errorSfc, { id: 'detail-error-state', inlineTemplate: true }).content,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const Button = vue.defineComponent({
    setup(_, { attrs, slots }) {
      return () => vue.h('button', attrs, slots.default?.());
    },
  });
  new Function('require', 'module', 'exports', errorCode)(
    (id) => {
      if (id === 'vue') return vue;
      if (id === '@/components/ui/Button.vue') return Button;
      if (id === '@iconify/vue') return { Icon: { render: () => null } };
      if (id === '@/icons') return {};
      throw new Error(`Unexpected dependency ${id}`);
    },
    errorModule,
    errorModule.exports,
  );
  const app = vue.createSSRApp({ setup: () => ({ ...view }), render: module.exports.render });
  const components = new Set();
  const visit = (node) => {
    if (node.type === 1 && /^[A-Z]/.test(node.tag)) components.add(node.tag);
    node.children?.forEach(visit);
  };
  visit(descriptor.template.ast);
  for (const name of components)
    app.component(name, name === 'DetailPageError' ? errorModule.exports.default : wrapper);
  return renderToString(app);
}

for (const kind of ['Album', 'Artist']) {
  test(`${kind}: a previously cached zero-ID record cannot render an empty detail page`, async (t) => {
    const f = fixture(t, kind);
    f.view[kind.toLowerCase()].value = { id: 0, name: '' };
    f.view.loading.value = false;
    const html = await renderDetailState(kind, f.view);
    assert.ok(html.includes('重新加载'));
    assert.ok(!html.includes('0 首歌曲'));
  });
}

for (const [kind, label] of [
  ['Album', '专辑'],
  ['Artist', '歌手'],
  ['Playlist', '歌单'],
]) {
  test(`${kind}: empty detail renders retry state without playback actions, then retry restores metadata`, async (t) => {
    const f = fixture(t, kind);
    f.api[`get${kind}Detail`] = async () => ({ status: 1, data: [{}] });
    await f.view.fetchData();
    const html = await renderDetailState(kind, f.view);
    assert.ok(html.includes(`暂时无法加载${label}`));
    assert.ok(html.includes('重新加载'));
    assert.ok(html.includes('role="status"'));
    assert.ok(!html.includes('0 首歌曲'));
    assert.ok(!html.includes('收藏'));
    assert.deepEqual(f.errors, []);
    f.api[`get${kind}Detail`] = async () =>
      kind === 'Playlist' ? { status: 1, data: [{ id: 'A', name: 'available' }] } : detail('A');
    await f.view.fetchData();
    assert.equal(f.view[kind.toLowerCase()].value.id, 'A');
  });

  test(`${kind}: empty refresh preserves an existing usable detail snapshot`, async (t) => {
    const f = fixture(t, kind);
    await f.view.fetchData();
    const metadata = f.view[kind.toLowerCase()].value;
    f.api[`get${kind}Detail`] = async () => ({ status: 1, data: [{}] });
    await f.view.fetchData();
    assert.equal(f.view[kind.toLowerCase()].value, metadata);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.notices, []);
  });
}
