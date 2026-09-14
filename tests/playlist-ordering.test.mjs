import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { toRecord } from '../src/shared/object.ts';
import {
  orderByPlaylistPosition,
  orderByCollectTime,
} from '../src/renderer/utils/playlistOrder.ts';

const code = transformSync(
  readFileSync(new URL('../src/renderer/services/playlistOrdering.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const setup = (api) => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name === '@/api/playlist') return api;
      if (name === '../../shared/object') return { toRecord };
      if (name === '@/utils/playlistOrder') return { orderByCollectTime };
      throw new Error(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
};
const trackTarget = {
  kind: 'tracks',
  listid: 12,
  queryId: 'collection_3_123_12_0',
  title: '我喜欢',
};
const page = (rows, count = rows.length, version = 7, key = 'list_ver') => ({
  status: 1,
  data: { info: rows, count, [key]: version },
});
const ids = (snapshot) => snapshot.items.filter((item) => !item.hidden).map((item) => item.id);

test('new endpoint uses listid for every page and version preflight before saving', async () => {
  const rows = Array.from({ length: 306 }, (_, index) => ({
    fileid: 2386 + index,
    name: `Song ${index}`,
    collecttime: index,
  }));
  let version = 1277;
  const reads = [];
  const writes = [];
  const api = setup({
    getPlaylistTracksNew: async (queryId, pageNumber, pageSize) => {
      reads.push([queryId, pageNumber, pageSize]);
      return {
        error_code: 0,
        errmsg: '',
        data: {
          count: rows.length,
          list_ver: version,
          info: rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        },
      };
    },
    savePlaylistTrackOrder: async (...args) => {
      writes.push(args);
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistOrder(trackTarget);
  assert.equal(snapshot.version, 1277);
  assert.deepEqual(
    ids(snapshot),
    rows.map((row) => String(row.fileid)),
  );
  const draft = ids(snapshot).reverse();
  await api.persistPlaylistOrder(snapshot, draft);
  assert.deepEqual(reads, [
    [trackTarget.listid, 1, 300],
    [trackTarget.listid, 2, 300],
    [trackTarget.listid, 1, 1],
  ]);
  assert.deepEqual(writes, [[12, 1277, draft.map((id, index) => `${id}|${index}`).join(',')]]);
  version++;
  await assert.rejects(api.persistPlaylistOrder(snapshot, draft), /其他位置更新/);
  assert.equal(writes.length, 1);
});

test('legacy nested metadata does not hide failed responses or missing versions', () => {
  const api = setup({});
  const data = { list_info: { list_ver: 1277 }, songs: [], count: 0 };
  assert.equal(api.readOrderPage({ status: 1, data }, 'tracks').version, 1277);
  assert.throws(
    () => api.readOrderPage({ status: 0, error_code: 0, data }, 'tracks'),
    /读取排序失败/,
  );
  assert.throws(() => api.readOrderPage({ error_code: 20010, data }, 'tracks'), /读取排序失败/);
  assert.throws(
    () => api.readOrderPage({ error_code: 0, data: { songs: [], list_info: {} } }, 'tracks'),
    /无法读取列表版本/,
  );
});

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const compile = (path, dependencies) => {
  const mod = { exports: {} };
  const compiled = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', compiled)(
    (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
};

test('favorites sort by position and forced refresh ignores the previous response', async () => {
  const loader = compile('../src/renderer/utils/PagedSongLoader.ts', {
    '@/utils/logger': silentLogger,
  });
  let finishOld;
  const oldResponse = new Promise((resolve) => {
    finishOld = resolve;
  });
  let requests = 0;
  const coverUpdates = [];
  const fresh = [
    { id: 2, playlistSort: 1, collectTime: 1 },
    { id: 1, playlistSort: 0, collectTime: 2 },
  ];
  const { favoritesActions } = compile('../src/renderer/stores/playlist/favoritesActions.ts', {
    '@/api/playlist': {
      getPlaylistTracksNew: (listid) => {
        assert.equal(listid, 12);
        return ++requests === 1 ? oldResponse : Promise.resolve(fresh);
      },
    },
    '@/utils/mappers': { parsePlaylistTracks: (songs) => ({ songs, filteredCount: 0 }) },
    '@/utils/PagedSongLoader': loader,
    '@/stores/user': { useUserStore: () => ({ info: { userid: 7 } }) },
    '@/stores/playlistCovers': {
      usePlaylistCoversStore: () => ({
        updateFromPages: async (_playlist, userId, pages, isCurrent) => {
          assert.equal(userId, 7);
          assert.equal(isCurrent(), true);
          coverUpdates.push(pages);
        },
      }),
    },
    '@/utils/song': {},
    '@/utils/playlistOrder': { orderByPlaylistPosition, orderByCollectTime },
    '@/utils/logger': silentLogger,
    './constants': { FAVORITES_PAGE_SIZE: 300 },
    './helpers': { dedupeSongs: (songs) => songs },
  });
  const store = {
    favorites: [],
    favoritesLoading: false,
    favoritesLoaded: false,
    userCollectionsGeneration: 1,
    likedPlaylist: { id: '12' },
    likedPlaylistQueryId: '12',
    likedPlaylistListId: 12,
  };
  const oldLoad = favoritesActions.fetchLikedPlaylistSongs.call(store);
  await favoritesActions.fetchLikedPlaylistSongs.call(store, true);
  assert.equal(requests, 2);
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    [1, 2],
  );
  finishOld([{ id: 99, playlistSort: 0 }]);
  await oldLoad;
  assert.deepEqual(coverUpdates, [[fresh]], 'Aborted pages must not update the cover');
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    [1, 2],
  );
  assert.equal(store.favoritesLoaded, true);
  assert.equal(store.favoritesLoading, false);
  assert.deepEqual(
    (await favoritesActions.waitForFavoritesLoaded.call(store)).map((song) => song.id),
    [1, 2],
  );
  // 热重载保留了 loading 状态，但对应的分页加载器已经结束。
  store.favoritesLoading = true;
  store.favoritesLoaded = false;
  await favoritesActions.fetchLikedPlaylistSongs.call(store);
  assert.equal(
    store.favoritesLoading,
    false,
    'A completed loader must not keep the skeleton active',
  );
  assert.equal(store.favoritesLoaded, true);
});

test('1060 tracks sort globally across all four pages by sort rather than collecttime', async () => {
  const rows = Array.from({ length: 1060 }, (_, i) => ({
    fileid: i + 1,
    sort: 1059 - i,
    collecttime: 1060 - i,
    name: `Song ${i}.flac`,
    hash: i % 5 ? 'shared-hash' : '',
    mixsongid: 50,
  }));
  const calls = [];
  const api = setup({
    getPlaylistTracksNew: async (queryId, p, size) => {
      assert.equal(queryId, trackTarget.listid);
      assert.equal(size, 300);
      calls.push([queryId, p, size]);
      return page(rows.slice((p - 1) * size, p * size), rows.length);
    },
  });
  const snapshot = await api.loadPlaylistOrder(trackTarget);
  assert.equal(calls.length, 4);
  assert.equal(snapshot.items.length, 1060);
  assert.equal(snapshot.items[0].id, '1060');
  assert.equal(snapshot.items.at(-1).id, '1');
  assert.equal(snapshot.items[0].title, 'Song 1059');
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    rows
      .slice()
      .reverse()
      .map((row) => String(row.fileid)),
  );
  assert.equal(api.buildPlaylistOrderPayload(snapshot, ids(snapshot)).split(',').length, 1060);
});

test('short and empty playlists load once; exact-page total does not request an extra page', async () => {
  for (const count of [0, 33, 300]) {
    let calls = 0;
    const api = setup({
      getPlaylistTracksNew: async () => {
        calls++;
        return page(Array.from({ length: count }, (_, i) => ({ fileid: i + 1 })));
      },
    });
    assert.equal((await api.loadPlaylistOrder(trackTarget)).items.length, count);
    assert.equal(calls, 1);
  }
});

test('incomplete pages, missing versions, duplicate IDs and version drift refuse editable snapshots', async () => {
  const cases = [
    async () => page([{ fileid: 1 }], 10),
    async () => ({ status: 1, data: { info: [{ fileid: 1 }] } }),
    async () => page([{ fileid: 1 }, { fileid: 1 }]),
    async () => page([{ mixsongid: 123 }]),
    async (_id, p) =>
      page(
        Array.from({ length: p === 1 ? 300 : 1 }, (_, i) => ({ fileid: (p - 1) * 300 + i + 1 })),
        301,
        p,
      ),
  ];
  for (const getPlaylistTracksNew of cases) {
    await assert.rejects(setup({ getPlaylistTracksNew }).loadPlaylistOrder(trackTarget));
  }
});

test('list sorting numbers categories separately, preserving pinned and album positions', async () => {
  const rows = [
    { listid: 1, type: 0, sort: 0, source: 1 },
    { listid: 2, type: 0, sort: 1, source: 1 },
    { listid: 3, type: 0, sort: 2, source: 1 },
    { listid: 4, type: 1, sort: 0, source: 1 },
    { listid: 5, type: 1, sort: 1, source: 2 },
    { listid: 6, type: 1, sort: 2, source: 1 },
  ];
  const api = setup({ getUserPlaylists: async () => page(rows, rows.length, 9, 'total_ver') });
  const created = await api.loadPlaylistOrder({ kind: 'playlists', type: 0, fixedIds: ['1'] });
  assert.deepEqual(ids(created), ['2', '3']);
  assert.equal(api.buildPlaylistOrderPayload(created, ['3', '2']), '1|0|0,3|0|1,2|0|2');
  const favorites = await api.loadPlaylistOrder({ kind: 'playlists', type: 1, fixedIds: ['1'] });
  assert.deepEqual(ids(favorites), ['4', '6']);
  assert.equal(api.buildPlaylistOrderPayload(favorites, ['6', '4']), '6|1|0,5|1|1,4|1|2');
});

test('save uses real fileids and observed version; malformed orders never reach write API', async () => {
  const writes = [];
  const api = setup({
    getPlaylistTracksNew: async (_id, _p, size) =>
      page(
        [
          { fileid: 81, mixsongid: 9, name: 'Song A' },
          { fileid: 95, mixsongid: 9, name: 'Song B' },
        ].slice(0, size),
        2,
        12,
      ),
    savePlaylistTrackOrder: async (...args) => {
      writes.push(args);
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistOrder(trackTarget);
  for (const invalid of [['81'], ['81', '81'], ['81', '999']]) {
    await assert.rejects(api.persistPlaylistOrder(snapshot, invalid));
  }
  assert.equal(writes.length, 0);
  await api.persistPlaylistOrder(snapshot, ['95', '81']);
  assert.deepEqual(writes, [[12, 12, '95|0,81|1']]);
  assert.deepEqual(ids(snapshot), ['81', '95']);
});

test('list save forwards total_ver; save failures retain snapshot and draft for retry', async () => {
  let fail = true;
  const writes = [];
  const api = setup({
    getUserPlaylists: async (_p, size) =>
      page(
        [
          { listid: 10, type: 0 },
          { listid: 11, type: 0 },
        ].slice(0, size),
        2,
        19,
        'total_ver',
      ),
    savePlaylistOrder: async (...args) => {
      writes.push(args);
      return { status: fail ? 0 : 1 };
    },
  });
  const snapshot = await api.loadPlaylistOrder({ kind: 'playlists', type: 0, fixedIds: [] });
  const draft = ['11', '10'];
  await assert.rejects(api.persistPlaylistOrder(snapshot, draft), /保存排序失败/);
  assert.deepEqual(ids(snapshot), ['10', '11']);
  assert.deepEqual(draft, ['11', '10']);
  fail = false;
  await api.persistPlaylistOrder(snapshot, draft);
  assert.deepEqual(writes, [
    [19, '11|0|0,10|0|1'],
    [19, '11|0|0,10|0|1'],
  ]);
});

test('stale versions and account change during preflight cannot write', async () => {
  let version = 1;
  let current = true;
  let duringPreflight = false;
  let writes = 0;
  const api = setup({
    getPlaylistTracksNew: async () => {
      if (duringPreflight) current = false;
      return page(
        [
          { fileid: 1, name: 'Song A' },
          { fileid: 2, name: 'Song B' },
        ],
        2,
        version,
      );
    },
    savePlaylistTrackOrder: async () => {
      writes++;
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistOrder(trackTarget);
  version++;
  await assert.rejects(api.persistPlaylistOrder(snapshot, ['2', '1']), /其他位置更新/);
  version--;
  duringPreflight = true;
  await assert.rejects(
    api.persistPlaylistOrder(snapshot, ['2', '1'], () => current),
    /账号或页面/,
  );
  assert.equal(writes, 0);
});

test('unknown tracks are hidden while their slots and total count survive saving', async () => {
  const rows = [
    { fileid: 1, name: 'Song A', hash: '' },
    { fileid: 2 },
    { fileid: 3, name: ' 未知歌曲.mp3 ' },
    { fileid: 4, name: '歌手 - 未知歌曲' },
    { fileid: 5, name: '未命名' },
    { fileid: 6, name: '   ' },
    { fileid: 7, name: '', filename: 'Song B.flac' },
    { fileid: 8, name: '未知的歌' },
  ];
  const writes = [];
  const api = setup({
    getPlaylistTracksNew: async (_id, _page, size) => page(rows.slice(0, size), rows.length),
    savePlaylistTrackOrder: async (...args) => {
      writes.push(args);
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistOrder(trackTarget);
  assert.deepEqual(ids(snapshot), ['1', '7', '8']);
  assert.equal(snapshot.items.length, 8);
  await api.persistPlaylistOrder(snapshot, ['8', '7', '1']);
  assert.deepEqual(writes, [[12, 7, '8|0,2|1,3|2,4|3,5|4,6|5,7|6,1|7']]);
});

test('collecttime sorting repairs mixed page order without mutating source data', () => {
  const correct = Array.from({ length: 1060 }, (_, i) => ({ id: i, collecttime: 1060 - i }));
  const mixed = [...correct.slice(0, 10), ...correct.slice(10).reverse()];
  assert.deepEqual(
    orderByCollectTime(mixed, (item) => item.collecttime),
    correct,
  );
  assert.equal(mixed[10].id, 1059);
  const plain = [{ id: 4 }, { id: 1 }];
  assert.deepEqual(
    orderByCollectTime(plain, (item) => item.collecttime),
    plain,
  );
});

test('collecttime keeps ties stable and places missing or invalid timestamps last', () => {
  const rows = [
    { id: 'missing' },
    { id: 'old', time: '100' },
    { id: 'new', time: 300 },
    { id: 'same', time: '300' },
    { id: 'zero', time: 0 },
    { id: 'bad', time: 'bad' },
    { id: 'negative', time: -1 },
    { id: 'infinite', time: Infinity },
  ];
  assert.deepEqual(
    orderByCollectTime(rows, (row) => row.time).map((row) => row.id),
    ['new', 'same', 'old', 'missing', 'zero', 'bad', 'negative', 'infinite'],
  );
});

test('favorites publish the first page while remaining pages load, without marking it complete', async () => {
  const requestedPages = [];
  let failRemaining = false;
  let coverUpdates = 0;
  const loader = compile('../src/renderer/utils/PagedSongLoader.ts', {
    '@/utils/logger': silentLogger,
  });
  let finishSecond;
  const secondPage = new Promise((resolve) => {
    finishSecond = resolve;
  });
  let secondRequested;
  const pageStarted = new Promise((resolve) => {
    secondRequested = resolve;
  });
  const { favoritesActions } = compile('../src/renderer/stores/playlist/favoritesActions.ts', {
    '@/api/playlist': {
      getPlaylistTracksNew: async (_id, page, size) => {
        requestedPages.push(page);
        assert.equal(size, 300);
        if (page === 1)
          return Array.from({ length: 300 }, (_, i) => ({
            id: i + 1,
            playlistSort: 300 - i,
            collectTime: i + 1,
          }));
        if (page === 2) {
          if (failRemaining) throw new Error('Second page failed');
          secondRequested();
          return secondPage;
        }
        return [];
      },
    },
    '@/utils/mappers': { parsePlaylistTracks: (songs) => ({ songs, filteredCount: 0 }) },
    '@/utils/PagedSongLoader': loader,
    '@/stores/user': { useUserStore: () => ({ info: { userid: 7 } }) },
    '@/stores/playlistCovers': {
      usePlaylistCoversStore: () => ({
        updateFromPages: async () => {
          coverUpdates++;
        },
      }),
    },
    '@/utils/song': {},
    '@/utils/playlistOrder': { orderByPlaylistPosition, orderByCollectTime },
    '@/utils/logger': silentLogger,
    './constants': { FAVORITES_PAGE_SIZE: 300 },
    './helpers': { dedupeSongs: (songs) => songs },
  });
  const store = {
    favorites: [],
    favoritesLoading: false,
    favoritesLoaded: false,
    userCollectionsGeneration: 1,
    likedPlaylist: { id: '12' },
    likedPlaylistListId: 12,
    likedPlaylistQueryId: '12',
  };
  let finished = false;
  const result = favoritesActions.fetchLikedPlaylistSongs.call(store).then(() => {
    finished = true;
  });
  await pageStarted;
  assert.equal(finished, false);
  assert.equal(store.favoritesLoading, true);
  assert.equal(store.favoritesLoaded, false);
  assert.equal(coverUpdates, 0, 'A partial list cannot update the cover');
  assert.equal(store.favorites.length, 300);
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    Array.from({ length: 300 }, (_, i) => 300 - i),
  );
  const joined = favoritesActions.fetchLikedPlaylistSongs.call(store);
  assert.equal(requestedPages.filter((page) => page === 1).length, 1);
  finishSecond([{ id: 301, playlistSort: 0, collectTime: 301 }]);
  await result;
  await joined;
  assert.equal(store.favoritesLoading, false);
  assert.equal(store.favoritesLoaded, true);
  assert.equal(coverUpdates, 1);
  assert.deepEqual(
    store.favorites.map((song) => song.id),
    Array.from({ length: 301 }, (_, i) => 301 - i),
  );
  failRemaining = true;
  store.favorites = [];
  store.favoritesLoaded = false;
  await favoritesActions.fetchLikedPlaylistSongs.call(store, true);
  assert.equal(store.favorites.length, 300, 'Later failures retain the songs already displayed');
  assert.equal(store.favoritesLoaded, false);
  assert.equal(store.favoritesLoading, false);
  assert.equal(coverUpdates, 1, 'Failed pagination cannot update the cover');
});
