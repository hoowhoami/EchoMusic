import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const vue = require('vue');
const { createRouter, createMemoryHistory } = require('vue-router');
const evaluate = (source, mocks) => {
  const mod = { exports: {} };
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  new Function('require', 'module', 'exports', 'defineOptions', code)(
    (name) => mocks[name] ?? {},
    mod,
    mod.exports,
    () => {},
  );
  return mod.exports;
};
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const helpers = evaluate(read('../src/renderer/views/search/searchHelpers.ts'), {});
const cache = evaluate(read('../src/renderer/utils/routeViewCache.ts'), {});
const { getRouteViewCacheQuery } = cache;
const script = read('../src/renderer/views/Search.vue').match(
  /<script setup lang="ts">([\s\S]*?)<\/script>/,
)[1];
const flush = async () => {
  for (let i = 0; i < 8; i++) await vue.nextTick();
};
const navigateHistory = (router, direction) =>
  new Promise((resolve) => {
    const remove = router.afterEach(() => {
      remove();
      resolve();
    });
    router.go(direction);
  });
const setup = async (query = { q: 'love' }) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: {} },
      { path: '/search', name: 'search', component: {}, meta: { tabQueryKeys: ['tab'] } },
      { path: '/detail/:id', name: 'detail', component: {} },
    ],
  });
  await router.push('/');
  await router.push({ name: 'search', query });
  const route = new Proxy({}, { get: (_, key) => router.currentRoute.value[key] });
  const calls = [];
  const { useRouteTabs } = evaluate(read('../src/renderer/composables/useRouteTabs.ts'), {
    vue: { ...vue, onActivated: () => {}, onDeactivated: () => {}, onBeforeUnmount: () => {} },
    'vue-router': { useRoute: () => route, useRouter: () => router },
    '@/utils/routeViewCache': cache,
  });
  const mount = () => {
    const scope = vue.effectScope();
    const state = scope.run(() =>
      evaluate(script + '\nexport { activeTabIndex, selectSearchTab, paginationState };', {
        vue: {
          ...vue,
          onMounted: () => {},
          onUnmounted: () => {},
          onBeforeUnmount: () => {},
          onActivated: () => {},
          onDeactivated: () => {},
        },
        'vue-router': { useRoute: () => route, useRouter: () => router },

        '@/api/search': {
          search: async (keyword, type, page) => {
            calls.push({ keyword, type, page });
            return { data: { lists: [], total: 0 } };
          },
        },
        '@/stores/setting': { useSettingStore: () => ({ addToSearchHistory() {} }) },
        '@/stores/playlist': { usePlaylistStore: () => ({}) },
        '@/stores/player': { usePlayerStore: () => ({}) },
        '@/stores/user': { useUserStore: () => ({ info: { userid: '' } }) },
        '@/stores/toast': {
          useToastStore: () => ({ info() {}, success() {}, warning() {}, error() {} }),
        },
        // 续播卡与搜索页新增的依赖：测试只关心 tab 状态机，这里给最小实现
        '@/stores/player/resume': {
          RESUME_SCOPE_LABEL: {
            audiobook: '有声',
            album: '专辑',
            artist: '歌手',
            playlist: '歌单',
          },
          resumeRecordForScope: () => undefined,
        },
        '@/utils/format': { formatDuration: () => '00:00' },
        '@/utils/playlistRoute': { resolvePlaylistRoute: () => ({ id: '', type: null }) },
        '@/utils/playback': { replaceQueueAndPlay: async () => true },
        '@/utils/songList': {
          filterSongsByQuery: (list) => list,
          sortSongs: (list) => list,
        },
        '@/composables/useTabDoubleClickTop': {
          useTabDoubleClickTop: () => ({ onTabPointerDown() {}, onTabDoubleClick() {} }),
        },
        '@/composables/usePageScroll': { useScrollContainer: () => vue.ref(null) },
        './search/searchHelpers': helpers,
        '@/composables/useRouteTabs': { useRouteTabs },
      }),
    );
    return { ...state, stop: () => scope.stop() };
  };
  return { router, route, calls, mount };
};

for (const [index, tab] of helpers.TAB_SEARCH_TYPES.entries()) {
  test(`${tab}: detail back restores the selected category after search is unmounted`, async () => {
    const s = await setup();
    let view = s.mount();
    await flush();
    await view.selectSearchTab(index);
    await flush();
    assert.equal(view.activeTabIndex.value, index);
    const cacheQuery = getRouteViewCacheQuery(s.route);
    assert.deepEqual(cacheQuery, { q: 'love' });
    await s.router.push({ name: 'detail', params: { id: tab } });
    view.stop();
    await navigateHistory(s.router, -1);
    view = s.mount();
    await flush();
    assert.equal(view.activeTabIndex.value, index);
    // 有声在接口层是 album + category=2，按 resolveSearchRequest 的映射校验
    assert.deepEqual(s.calls.at(-1), {
      keyword: 'love',
      type: helpers.resolveSearchRequest(tab).type,
      page: 1,
    });
    view.stop();
    // Tab switching replaces the search entry instead of inserting extra history entries.
    await navigateHistory(s.router, -1);
    assert.equal(s.route.name, 'home');
    await navigateHistory(s.router, 1);
    view = s.mount();
    await flush();
    assert.equal(view.activeTabIndex.value, index);
    view.stop();
  });
}

test('switching categories reuses loaded pages and a new keyword without tab starts with songs', async () => {
  const s = await setup();
  let view = s.mount();
  await flush();
  await view.selectSearchTab(1);
  await flush();
  await view.selectSearchTab(0);
  await flush();
  await view.selectSearchTab(1);
  await flush();
  assert.deepEqual(
    s.calls.map((call) => call.type),
    ['song', 'special'],
  );
  view.stop();
  await s.router.push({ name: 'search', query: { q: 'new' } });
  view = s.mount();
  await flush();
  assert.equal(view.activeTabIndex.value, 0);
  assert.deepEqual(s.calls.at(-1), { keyword: 'new', type: 'song', page: 1 });
  assert.equal(s.calls.length, 3);
  view.stop();
});

for (const tab of ['unknown', ['special', 'mv'], null]) {
  test(`invalid category ${JSON.stringify(tab)} falls back to songs`, async () => {
    const s = await setup({ q: 'love', tab });
    const view = s.mount();
    await flush();
    assert.equal(view.activeTabIndex.value, 0);
    assert.equal(s.calls[0].type, 'song');
    view.stop();
  });
}

test('search category is excluded from view identity, other route tabs and refresh stay independent', () => {
  const query = { q: 'love', tab: 'mv', _t: '123' };
  assert.deepEqual(getRouteViewCacheQuery({ meta: { tabQueryKeys: ['tab'] }, query }), {
    q: 'love',
  });
  assert.deepEqual(getRouteViewCacheQuery({ meta: {}, query }), { q: 'love', tab: 'mv' });
  assert.deepEqual(query, { q: 'love', tab: 'mv', _t: '123' });
});
