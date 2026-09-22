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
        vue: { ...vue, onMounted: () => {}, onUnmounted: () => {} },
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
    assert.deepEqual(s.calls.at(-1), { keyword: 'love', type: tab, page: 1 });
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
