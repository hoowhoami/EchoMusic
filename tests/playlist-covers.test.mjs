import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as vue from 'vue';
import * as object from '../src/shared/object.ts';
import * as source from '../src/renderer/utils/playlistTrackSource.ts';
import * as tags from '../src/renderer/utils/playlistTags.ts';
import * as order from '../src/renderer/utils/playlistOrder.ts';

function compile(path, dependencies) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const cover = compile('../src/renderer/utils/cover.ts', {
  '@/plugins/coverFallback': {},
  './themedCover': {},
});
const shared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': cover,
  '../../../shared/object': object,
});
const song = compile('../src/renderer/utils/mappers/song.ts', { './shared': shared });
const helpers = compile('../src/renderer/utils/playlistCover.ts', {
  '../../shared/object': object,
  './mappers/song': song,
  './playlistTrackSource': source,
});
const maps = compile('../src/renderer/utils/mappers/playlist.ts', {
  './shared': shared,
  './song': song,
  '../song': {},
  '../playlistTags': tags,
  '../commentVip': compile('../src/renderer/utils/commentVip.ts', {
    '../../shared/object': object,
  }),
});

test('playlist tags display names for both user and public metadata responses', () => {
  for (const identity of [{ listid: 12, list_create_userid: 7 }, { specialid: 12 }]) {
    assert.equal(
      maps.mapPlaylistMeta({
        ...identity,
        tags: [{ name: '流行' }, { tag_name: '粤语' }, { name: '流行' }, { tag_id: 9 }],
      }).tags,
      '流行,粤语',
    );
    assert.equal(
      maps.mapPlaylistMeta({ ...identity, tags: ' 流行， 粤语,流行 ' }).tags,
      '流行,粤语',
    );
  }
});
const { buildPlaylistCoverEntry } = helpers;
const playlist = { id: 12, listid: 12, listCreateUserid: 7, source: 1, type: 0, pic: 'server.jpg' };
const track = (time, url, sort) => ({
  collecttime: time,
  cover: url,
  sort,
  name: 'Song',
  fileid: time,
});
const page = (rows, count = rows.length, listVer = 9) => ({
  status: 1,
  data: { info: rows, count, list_ver: listVer },
});
function createStore(storage) {
  const mod = compile('../src/renderer/stores/playlistCovers.ts', {
    pinia,
    vue,
    '@/utils/playlistCover': helpers,
    '../../shared/object': object,
    '@/utils/logger': { warn() {} },
  });
  globalThis.window = { electron: { storage } };
  return mod.usePlaylistCoversStore(pinia.createPinia());
}

test('favorites refresh updates the shared cover from the same complete song pages after reordering', async () => {
  const covers = createStore({ getKv: async () => ({}), setKv: async () => {} });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const loader = compile('../src/renderer/utils/PagedSongLoader.ts', { '@/utils/logger': logger });
  let version = 9;
  let fail = false;
  const requests = [];
  const rows = Array.from({ length: 301 }, (_, index) => ({
    ...track(1000 - index, `https://img.test/${index}.jpg`, index),
    hash: `hash-${index}`,
  }));
  const { favoritesActions } = compile('../src/renderer/stores/playlist/favoritesActions.ts', {
    '@/api/playlist': {
      getPlaylistTracksNew: async (listid, number, size) => {
        assert.equal(listid, 2);
        assert.equal(size, 300);
        requests.push(number);
        if (fail) throw new Error('Network error');
        // 真实 new 接口：并发预取的越界页返回 info:null，不是空数组。
        return page(
          number > 2 ? null : rows.slice((number - 1) * size, number * size),
          rows.length,
          version,
        );
      },
    },
    '@/utils/mappers': {
      parsePlaylistTracks: (response) => ({
        songs: (response.data.info ?? []).map(song.mapPlaylistSong),
        filteredCount: 0,
      }),
    },
    '@/utils/PagedSongLoader': loader,
    '@/utils/song': {},
    '@/utils/playlistOrder': order,
    '@/utils/logger': logger,
    '@/stores/user': { useUserStore: () => ({ info: { userid: 7 } }) },
    '@/stores/playlistCovers': { usePlaylistCoversStore: () => covers },
    './constants': { FAVORITES_PAGE_SIZE: 300 },
    './helpers': { dedupeSongs: (songs) => songs },
  });
  const liked = { ...playlist, id: 2, listid: 2, name: '我喜欢' };
  const store = {
    favorites: [],
    favoritesLoading: false,
    favoritesLoaded: false,
    userCollectionsGeneration: 1,
    likedPlaylist: liked,
    likedPlaylistListId: 2,
  };
  await favoritesActions.fetchLikedPlaylistSongs.call(store);
  assert.equal(covers.coverFor(liked, 7), 'https://img.test/0.jpg');
  const initialPages = requests.splice(0);
  assert.equal(initialPages.filter((number) => number === 1).length, 1);
  rows[0].sort = 300;
  rows[300].sort = 0;
  version++;
  await favoritesActions.fetchLikedPlaylistSongs.call(store, true);
  assert.deepEqual(
    requests,
    initialPages,
    'Cover update must not request another copy of the pages',
  );
  assert.equal(covers.entries['7:2'].listVer, 10);
  assert.equal(covers.coverFor(liked, 7), 'https://img.test/300.jpg');
  assert.equal(store.favorites[0].coverUrl, 'https://img.test/300.jpg');
  fail = true;
  await favoritesActions.fetchLikedPlaylistSongs.call(store, true);
  assert.equal(covers.coverFor(liked, 7), 'https://img.test/300.jpg');
});

test('chooses the first cover by global sort across raw pages, regardless of collection time', () => {
  const pages = [
    page([track(20, '', 0), track(19, 'http://img.test/old.jpg', 99)], 3),
    page([track(10, 'http://img.test/{size}/new.jpg', 1)], 3),
  ];
  const original = JSON.stringify(pages);
  assert.deepEqual(buildPlaylistCoverEntry(pages), {
    listVer: 9,
    coverUrl: 'https://img.test/400/new.jpg',
  });
  assert.equal(JSON.stringify(pages), original);
});

test('ties retain page order; missing positions fall back to the first cover', () => {
  assert.equal(
    buildPlaylistCoverEntry([
      page([
        track(undefined, 'https://img.test/fallback'),
        track(3, 'https://img.test/first', 1),
        track(3, 'https://img.test/second', 1),
      ]),
    ]).coverUrl,
    'https://img.test/first',
  );
  assert.equal(
    buildPlaylistCoverEntry([page([track(undefined, 'https://img.test/fallback')])]).coverUrl,
    'https://img.test/fallback',
  );
});

test('a new list version refreshes the cover after sorting, with collection times unchanged', async () => {
  const store = createStore({ getKv: async () => ({}), setKv: async () => {} });
  await store.updateFromPages(
    playlist,
    7,
    [page([track(20, 'https://img.test/newest', 0), track(10, 'https://img.test/moved', 1)])],
    () => true,
  );
  assert.equal(store.coverFor(playlist, 7), 'https://img.test/newest');
  await store.updateFromPages(
    playlist,
    7,
    [
      page(
        [track(20, 'https://img.test/newest', 1), track(10, 'https://img.test/moved', 0)],
        2,
        10,
      ),
    ],
    () => true,
  );
  assert.equal(store.coverFor(playlist, 7), 'https://img.test/moved');
  assert.equal(store.entries['7:12'].listVer, 10);
});

test('legacy collection-time cache is recalculated once even if the version is unchanged', async () => {
  const writes = [];
  const store = createStore({
    getKv: async () => ({ '7:12': { listVer: 9, coverUrl: 'https://img.test/newest' } }),
    setKv: async (_key, value) => writes.push(value),
  });
  const pages = [
    page([track(20, 'https://img.test/newest', 1), track(10, 'https://img.test/first', 0)]),
  ];
  await store.updateFromPages(playlist, 7, pages, () => true);
  assert.equal(store.coverFor(playlist, 7), 'https://img.test/first');
  await store.updateFromPages(playlist, 7, pages, () => true);
  assert.equal(writes.length, 1);
});

test('empty or coverless complete lists clear stale covers; incomplete and changed responses cannot publish', () => {
  assert.deepEqual(buildPlaylistCoverEntry([page([])]), { listVer: 9, coverUrl: '' });
  assert.deepEqual(buildPlaylistCoverEntry([page(null, 0)]), { listVer: 9, coverUrl: '' });
  assert.equal(buildPlaylistCoverEntry([page(null, 1)]), null);
  assert.deepEqual(buildPlaylistCoverEntry([page([track(1, '')])]), { listVer: 9, coverUrl: '' });
  assert.equal(buildPlaylistCoverEntry([page([track(1, 'https://img.test/a')], 2)]), null);
  assert.equal(buildPlaylistCoverEntry([page([], 0, null)]), null);
  assert.equal(
    buildPlaylistCoverEntry([{ status: 0, data: { info: [], count: 0, list_ver: 9 } }]),
    null,
  );
  assert.equal(
    buildPlaylistCoverEntry([page([track(1, '')], 2), page([track(2, '')], 2, 10)]),
    null,
  );
  assert.equal(buildPlaylistCoverEntry([page([track(1, '')], 2), page([track(2, '')], 3)]), null);
});

test('metadata mapper retains custom cover flags and versions', () => {
  const result = maps.mapPlaylistMeta({
    listid: 12,
    list_create_userid: 7,
    list_ver: 19,
    is_custom_pic: 1,
  });
  assert.equal(result.listVer, 19);
  assert.equal(result.hasCustomCover, true);
  assert.equal(
    maps.mapPlaylistMeta({ specialid: 12, list_ver: 20, is_custom_pic: 0 }).hasCustomCover,
    false,
  );
});

test('cache restores across restart, survives list refresh, skips same version, and changes only after valid completion', async () => {
  let saved = { '7:12': { listVer: 8, coverUrl: 'https://img.test/cached' } };
  const writes = [];
  const storage = {
    getKv: async () => saved,
    setKv: async (_key, value) => {
      writes.push(value);
      saved = value;
    },
  };
  const store = createStore(storage);
  await store.hydrate();
  assert.equal(store.coverFor({ ...playlist, listVer: 9 }, 7), 'https://img.test/cached');
  await store.updateFromPages(playlist, 7, [page([], 5, 8)], () => true);
  await store.updateFromPages(playlist, 7, [page([], 5, 9)], () => true);
  assert.equal(writes.length, 0);
  await store.updateFromPages(playlist, 7, [page([track(9, 'https://img.test/new')])], () => true);
  assert.equal(
    store.coverFor({ ...playlist, pic: 'outdated-server.jpg' }, 7),
    'https://img.test/new',
  );
  assert.equal(writes.length, 1);
  const restarted = createStore(storage);
  await restarted.hydrate();
  assert.equal(restarted.coverFor(playlist, 7), 'https://img.test/new');
  await restarted.updateFromPages(playlist, 7, [page([], 0, 10)], () => true);
  assert.equal(restarted.coverFor(playlist, 7), '');
});

test('custom covers, other accounts, collected playlists and albums bypass the automatic cache', async () => {
  const store = createStore({
    getKv: async () => ({ '7:12': { listVer: 9, coverUrl: 'auto' } }),
    setKv: async () => assert.fail('Unexpected write'),
  });
  await store.hydrate();
  for (const meta of [
    { ...playlist, hasCustomCover: true },
    { ...playlist, type: 1 },
    { ...playlist, source: 2 },
  ]) {
    assert.equal(store.coverFor(meta, 7), 'server.jpg');
    await store.updateFromPages(meta, 7, [page([])], () => true);
  }
  assert.equal(store.coverFor(playlist, 8), 'server.jpg');
  assert.equal(store.coverFor(playlist, undefined), 'server.jpg');
});

test('account or page change while hydration is pending prevents cache writes', async () => {
  let release;
  const store = createStore({
    getKv: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    setKv: async () => assert.fail('Stale result was saved'),
  });
  let current = true;
  const pending = store.updateFromPages(
    playlist,
    7,
    [page([track(2, 'https://img.test/new')])],
    () => current,
  );
  current = false;
  release({});
  await pending;
  assert.equal(store.coverFor(playlist, 7), 'server.jpg');
});

test('manual cover persists and is not replaced by later automatic selection', async () => {
  let saved = {};
  const storage = {
    getKv: async () => saved,
    setKv: async (_key, value) => {
      saved = value;
    },
  };
  const store = createStore(storage);
  await store.setManualCover({ ...playlist, pic: 'https://img.test/manual' }, 7, () => true);
  await store.updateFromPages(
    playlist,
    7,
    [page([track(99, 'https://img.test/auto')], 1, 20)],
    () => true,
  );
  assert.equal(store.coverFor(playlist, 7), 'https://img.test/manual');
  const restarted = createStore(storage);
  await restarted.hydrate();
  assert.equal(restarted.coverFor(playlist, 7), 'https://img.test/manual');
  assert.equal(restarted.coverFor(playlist, 8), 'server.jpg');
});

test('serial cache writes retain updates from different playlists', async () => {
  let saved;
  const store = createStore({
    getKv: async () => ({}),
    setKv: async (_key, value) => {
      saved = value;
    },
  });
  await Promise.all([
    store.updateFromPages(playlist, 7, [page([track(1, 'https://img.test/a')])], () => true),
    store.updateFromPages(
      { ...playlist, id: 13, listid: 13 },
      7,
      [page([track(1, 'https://img.test/b')])],
      () => true,
    ),
  ]);
  assert.deepEqual(Object.keys(saved).sort(), ['7:12', '7:13']);
});
