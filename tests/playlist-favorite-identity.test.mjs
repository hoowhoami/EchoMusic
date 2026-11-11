import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import { userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

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
  '../../../shared/embeddedMetadata': embeddedTags,
  vue,
  '@/utils/song': songUtils,
  './constants': constants,
});
const { matchesFavoriteEntry } = helpers;

const user = vue.reactive({
  isLoggedIn: true,
  accountRevision: 0,
  info: { userid: 7, token: 'first' },
});
const scope = compile('../src/renderer/stores/playlist/accountScope.ts', {
  '@/utils/watchUserSession': userSessionWatch,
  '@/utils/userSession': compile('../src/renderer/utils/userSession.ts'),
  '@/stores/user': { useUserStore: () => user },
});

const setup = (overrides = {}) => {
  const calls = { deletePlaylist: [] };
  const api = {
    addPlaylist: async () => ({ status: 1, data: { listid: 99 } }),
    deletePlaylist: async (listId) => {
      calls.deletePlaylist.push(listId);
      return { status: 1 };
    },
    getUserPlaylists: async () => ({ status: 1, data: { info: [] } }),
    ...overrides,
  };
  const { userActions } = compile('../src/renderer/stores/playlist/userActions.ts', {
    '@/api/playlist': api,
    '@/utils/logger': logger,
    './helpers': helpers,
    './accountScope': scope,
    '@/utils/mappers': { mapPlaylistMeta: (value) => value },
  });
  const store = {
    userCollectionsGeneration: 0,
    fetchUserPlaylists: async () => {},
    userPlaylists: [],
  };
  return { store, calls, userActions };
};

// ---------------------------------------------------------------------------
// matchesFavoriteEntry：收藏身份匹配规则
// ---------------------------------------------------------------------------

test('matchesFavoriteEntry: same gid matches via either gid field', () => {
  const entry = {
    globalCollectionId: 'collection_3_8_40_0', // 收藏后重写到收藏者命名空间
    listCreateGid: 'collection_3_2187780004_153_0', // 原创建者 gid
    listid: 40,
    listCreateListid: 153,
    listCreateUserid: 2187780004,
  };
  // 展示侧（详情页）只带原创建者 gid 时靠 listCreateGid 命中
  assert.equal(
    matchesFavoriteEntry(entry, {
      globalCollectionId: 'collection_3_2187780004_153_0',
      listCreateGid: 'collection_3_2187780004_153_0',
    }),
    true,
  );
  // 展示侧只带用户库 gid 时靠 globalCollectionId 命中
  assert.equal(
    matchesFavoriteEntry(entry, {
      globalCollectionId: 'collection_3_8_40_0',
      listCreateGid: 'collection_3_8_40_0',
    }),
    true,
  );
});

test('matchesFavoriteEntry: identical listids with different gids never match (探索页撞号回归)', () => {
  // 「200首经典老歌」详情：listid=153；用户库「宿命感影视OST」：listCreateListid=153。
  // 旧逻辑按裸 listid 撞号误判，导致探索页误报已收藏、取消收藏误删其他歌单。
  const explore = {
    globalCollectionId: 'collection_3_950020348_153_0',
    listCreateGid: 'collection_3_950020348_153_0',
    listid: 153,
    listCreateListid: 153,
    listCreateUserid: 950020348,
  };
  const favored = {
    globalCollectionId: 'collection_3_7_40_0',
    listCreateGid: 'collection_3_2187780004_153_0',
    listid: 40,
    listCreateListid: 153,
    listCreateUserid: 2187780004,
  };
  assert.equal(matchesFavoriteEntry(favored, explore), false);
});

test('matchesFavoriteEntry: falls back to creator userid+listid composite when both sides lack gids', () => {
  const entry = { listid: 40, listCreateListid: 153, listCreateUserid: 2187780004 };
  assert.equal(
    matchesFavoriteEntry(entry, { listCreateListid: 153, listCreateUserid: 2187780004 }),
    true,
  );
  // 同组合键但 gid 不同：显式 gid 是更精确的身份，不一致时不放行
  assert.equal(
    matchesFavoriteEntry(
      {
        listCreateListid: 153,
        listCreateUserid: 2187780004,
        globalCollectionId: 'collection_3_1_1_0',
      },
      {
        listCreateListid: 153,
        listCreateUserid: 2187780004,
        globalCollectionId: 'collection_3_2_2_0',
      },
    ),
    false,
  );
  // 组合键创建者不同：即使用了同一个 153 也不匹配
  assert.equal(
    matchesFavoriteEntry(entry, { listCreateListid: 153, listCreateUserid: 950020348 }),
    false,
  );
  // 双方均无任何全局身份（只剩裸 id/listid）：不匹配
  assert.equal(matchesFavoriteEntry({ id: 13, listid: 13 }, { id: 13, listid: 13 }), false);
});

// ---------------------------------------------------------------------------
// unfavoritePlaylist：gid / 组合键两条路径都能取消收藏，撞号不误删
// ---------------------------------------------------------------------------

test('unfavoritePlaylist: cancels via gid match and deletes the entry listid', async () => {
  const { store, calls, userActions } = setup();
  store.userPlaylists = [
    {
      id: '40',
      listid: 40,
      listCreateUserid: 2187780004,
      listCreateListid: 153,
      listCreateGid: 'collection_3_2187780004_153_0',
      globalCollectionId: 'collection_3_7_40_0',
    },
  ];
  const ok = await userActions.unfavoritePlaylist.call(
    store,
    {
      globalCollectionId: 'collection_3_2187780004_153_0',
      listCreateGid: 'collection_3_2187780004_153_0',
      listid: 153,
      listCreateListid: 153,
      listCreateUserid: 950020348,
    },
    7,
  );
  assert.equal(ok, true);
  assert.deepEqual(calls.deletePlaylist, [40]);
});

test('unfavoritePlaylist: same listid with different gid finds no target and deletes nothing', async () => {
  const { store, calls, userActions } = setup();
  store.userPlaylists = [
    {
      id: '40',
      listid: 40,
      listCreateUserid: 2187780004,
      listCreateListid: 153,
      globalCollectionId: 'collection_3_7_40_0',
    },
  ];
  const ok = await userActions.unfavoritePlaylist.call(
    store,
    {
      globalCollectionId: 'collection_3_950020348_153_0',
      listCreateGid: 'collection_3_950020348_153_0',
      listid: 153,
      listCreateListid: 153,
      listCreateUserid: 950020348,
    },
    7,
  );
  assert.equal(ok, false);
  assert.deepEqual(calls.deletePlaylist, []);
});

test('unfavoritePlaylist: cancels via creator composite fallback when gids are absent', async () => {
  const { store, calls, userActions } = setup();
  store.userPlaylists = [
    { id: '40', listid: 40, listCreateUserid: 2187780004, listCreateListid: 153 },
  ];
  const ok = await userActions.unfavoritePlaylist.call(
    store,
    {
      listid: 153,
      listCreateListid: 153,
      listCreateUserid: 2187780004,
    },
    7,
  );
  assert.equal(ok, true);
  assert.deepEqual(calls.deletePlaylist, [40]);
});
