import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
const require = createRequire(import.meta.url);
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const evaluate = (source, deps = {}, globals = {}) => {
  const mod = { exports: {} };
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => {
      if (name in deps) return deps[name];
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, `missing dependency: ${name}`);
      return deps[name];
    },
    mod,
    mod.exports,
    ...Object.values(globals),
  );
  return mod.exports;
};
const mappers = Object.fromEntries(
  ['mapSearchSong', 'mapAlbumMeta', 'mapArtistMeta', 'mapPlaylistMeta'].map((key) => [
    key,
    (row) => row,
  ]),
);
const helpers = evaluate(read('../src/renderer/views/search/searchHelpers.ts'), {
  '@/utils/mappers': mappers,
});
const scripts = Object.fromEntries(
  ['Search', 'TitleBar'].map((name) => {
    const path =
      name === 'Search'
        ? '../src/renderer/views/Search.vue'
        : '../src/renderer/layouts/TitleBar.vue';
    const { descriptor } = parse(read(path));
    return [name, compileScript(descriptor, { id: `search-${name}` }).content];
  }),
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await vue.nextTick();
  await new Promise((r) => setImmediate(r));
};
const row = (id) => ({ id: String(id), name: String(id), MvID: String(id), MvName: String(id) });
const page = (ids, total = 100) => ({ status: 1, data: { lists: ids.map(row), total } });
const hot = (keyword) => ({
  status: 1,
  data: { list: [{ name: 'hot', keywords: [{ keyword }] }] },
});
const ads = (keyword) => ({ data: { ads: [{ main_title: keyword, sub_title: 'subtitle' }] } });
function fixture(t, name = 'Search') {
  const hooks = {
    onMounted: [],
    onActivated: [],
    onDeactivated: [],
    onBeforeUnmount: [],
    onUnmounted: [],
  };
  const hookVue = {
    ...vue,
    ...Object.fromEntries(Object.keys(hooks).map((key) => [key, (fn) => hooks[key].push(fn)])),
  };
  const route = vue.reactive({
    name: 'search',
    query: { q: '' },
    fullPath: '/search',
    matched: [],
    path: '/search',
  });
  const active = vue.ref(true),
    tab = vue.ref('song'),
    scroll = vue.ref(null),
    observers = [],
    calls = [],
    history = [],
    defaults = [],
    hotReads = [];
  const setting = vue.reactive({
    searchDefaultEnabled: true,
    addToSearchHistory: (q) => history.push(q),
    searchHistory: [],
  });
  let respond = () => page([]),
    respondHot = () => hot('current'),
    respondDefault = () => ads('current');
  const timers = new Map();
  const window = {
    history: { state: {} },
    electron: { platform: 'darwin', ipcRenderer: { on() {}, off() {} } },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => {
      const key = timers.size + 1;
      timers.set(key, fn);
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
  };
  const document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  class Observer {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.nodes = [];
      this.disconnects = 0;
      observers.push(this);
    }
    observe(node) {
      this.nodes.push(node);
    }
    disconnect() {
      this.disconnects++;
      this.nodes = [];
    }
    fire(target = this.nodes[0]) {
      this.callback([{ isIntersecting: true, target }]);
    }
  }
  const deps = {
    vue: hookVue,
    './windowDrag': { isWindowDragTarget: () => false },
    'reka-ui': {},
    'vue-router': { useRoute: () => route, useRouter: () => ({ push() {}, replace() {} }) },
    '@/api/search': {
      search: async (...args) => {
        calls.push(args);
        return respond(...args);
      },
      getSearchHot: async () => {
        hotReads.push(true);
        return respondHot();
      },
      getSearchDefault: async () => {
        defaults.push(true);
        return respondDefault();
      },
      getSearchSuggest: async () => ({ data: [] }),
    },

    '@/stores/setting': { useSettingStore: () => setting },
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/player': { usePlayerStore: () => ({}) },
    '@/composables/usePageScroll': { useScrollContainer: () => scroll },
    '@/composables/useRouteTabs': {
      useRouteTabs: () => ({
        state: { tab },
        select: ({ tab: value }) => {
          tab.value = value;
        },
        isActive: active,
      }),
    },
    '@/utils/playback': { replaceQueueAndPlay: async () => {} },
    '@/utils/songList': { sortSongs: (songs) => songs, filterSongsByQuery: (songs) => songs },
    './search/searchHelpers': helpers,
    '@/views/search/searchHelpers': helpers,
    '@/utils/logger': { logger: { info() {} } },
    './useTitlebarSort': { useTitlebarSort() {} },
    '@vueuse/core': { useResizeObserver() {} },
    '@/plugins/titlebar': {
      createTitlebarApi: () => ({ register() {} }),
      titlebarItems: vue.ref([]),
    },
    '@/plugins/taskPanel': { taskPanelEntries: vue.ref([]), taskPanelOpen: vue.ref(false) },
    '@/icons': {},
  };
  const mod = evaluate(scripts[name], deps, {
    window,
    document,
    IntersectionObserver: Observer,
    HTMLElement: class {},
  });
  const scope = vue.effectScope();
  const view = scope.run(() => mod.default.setup({}, { expose() {} }));
  let disposed = false;
  const stop = () => {
    if (disposed) return;
    disposed = true;
    hooks.onBeforeUnmount.forEach((fn) => fn());
    scope.stop();
    hooks.onUnmounted.forEach((fn) => fn());
  };
  t.after(stop);
  const results = (type) =>
    view[
      {
        song: 'songResults',
        special: 'playlistResults',
        album: 'albumResults',
        author: 'artistResults',
        lyric: 'lyricResults',
        mv: 'mvResults',
      }[type]
    ].value;
  return {
    view,
    route,
    active,
    tab,
    scroll,
    observers,
    calls,
    history,
    setting,
    defaults,
    hotReads,
    timers,
    stop,
    results,
    respond: (fn) => {
      respond = fn;
    },
    hot: (fn) => {
      respondHot = fn;
    },
    default: (fn) => {
      respondDefault = fn;
    },
    mount: () => Promise.all(hooks.onMounted.map((fn) => fn())),
    activate: () => {
      active.value = true;
      hooks.onActivated.forEach((fn) => fn());
    },
    deactivate: () => {
      active.value = false;
      hooks.onDeactivated.forEach((fn) => fn());
    },
  };
}

for (const type of helpers.TAB_SEARCH_TYPES) {
  test(`round13: ${type} old pagination failure cannot end a newer keyword`, async (t) => {
    const f = fixture(t);
    f.tab.value = type;
    await flush();
    f.respond(() => page([1]));
    await f.view.runSearch('old');
    const old = deferred();
    f.respond(() => old.promise);
    const request = f.view.loadMoreActiveResults();
    f.respond(() => page([2]));
    await f.view.runSearch('new');
    old.reject(new Error('old failure'));
    await request;
    assert.equal(f.view.paginationState[type].hasMore, true);
    assert.equal(f.view.paginationState[type].page, 1);
    assert.equal(f.view.paginationState[type].error, '');
    assert.equal(f.results(type).length, 1);
    assert.equal(f.view.currentSearchKeyword.value, 'new');
  });
  test(`round13: ${type} page failure keeps results and retries the same page`, async (t) => {
    const f = fixture(t);
    f.tab.value = type;
    await flush();
    f.respond(() => page([1]));
    await f.view.runSearch('keyword');
    const before = f.results(type).slice();
    f.respond(() => Promise.reject(new Error('network')));
    await f.view.loadMoreActiveResults();
    assert.deepEqual(f.results(type), before);
    assert.equal(f.view.paginationState[type].page, 1);
    assert.equal(f.view.paginationState[type].hasMore, true);
    assert.ok(f.view.paginationState[type].error);
    f.respond(() => page([2], 2));
    await f.view.loadMoreActiveResults();
    assert.equal(f.calls.at(-1)[2], 2);
    assert.equal(f.results(type).length, 2);
    assert.equal(f.view.paginationState[type].error, '');
    assert.equal(f.view.paginationState[type].hasMore, false);
  });
}
for (const result of ['success', 'failure']) {
  test(`round13: unmounted search ignores pending ${result}`, async (t) => {
    const f = fixture(t),
      pending = deferred();
    f.respond(() => pending.promise);
    const task = f.view.runSearch('keyword');
    f.stop();
    if (result === 'success') pending.resolve(page([1]));
    else pending.reject(new Error('late'));
    await task;
    assert.deepEqual(f.view.songResults.value, []);
    assert.equal(f.view.searchErrors.song, undefined);
    assert.equal(f.view.paginationState.song.loaded, false);
    assert.equal(f.view.paginationState.song.loading, false);
    assert.equal(f.view.isLoading.value, false);
  });
  test(`round13: inactive search ignores pending ${result} and reloads on activation`, async (t) => {
    const f = fixture(t),
      pending = deferred();
    f.route.query.q = 'keyword';
    f.respond(() => pending.promise);
    await flush();
    f.deactivate();
    if (result === 'success') pending.resolve(page([1]));
    else pending.reject(new Error('late'));
    await flush();
    assert.deepEqual(f.view.songResults.value, []);
    assert.equal(f.view.paginationState.song.loaded, false);
    assert.equal(f.view.searchErrors.song, undefined);
    f.respond(() => page([2], 1));
    f.activate();
    await flush();
    assert.equal(f.view.songResults.value[0]?.id, '2');
    assert.equal(f.calls.length, 2);
  });
}
test('round13: empty page ends pagination despite stale total', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1], 100));
  await f.view.runSearch('keyword');
  f.respond(() => page([], 100));
  await f.view.loadMoreActiveResults();
  assert.equal(f.view.paginationState.song.hasMore, false);
  const count = f.calls.length;
  await f.view.loadMoreActiveResults();
  assert.equal(f.calls.length, count);
});
test('round13: failed refresh preserves previous results and loaded categories', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1], 1));
  await f.view.runSearch('keyword');
  await f.view.loadSearchResults('album');
  f.respond(() => Promise.reject(new Error('failure')));
  await f.view.loadSearchResults('song');
  assert.equal(f.view.songResults.value[0]?.id, '1');
  assert.equal(f.view.albumResults.value[0]?.id, '1');
  assert.equal(f.view.paginationState.album.loaded, true);
  f.respond(() => page([2], 1));
  await f.view.loadSearchResults('song');
  assert.equal(f.view.songResults.value[0]?.id, '2');
  assert.equal(f.history.length, 1);
});
test('round13: concurrent pagination is coalesced and a failed page does not auto retry', async (t) => {
  const f = fixture(t);
  f.scroll.value = { addEventListener() {}, removeEventListener() {}, scrollTop: 0 };
  await flush();
  f.respond(() => page([1]));
  await f.view.runSearch('keyword');
  f.view.loadMoreSentinelRef.value = {};
  await flush();
  const more = deferred();
  f.respond(() => more.promise);
  const task = f.view.loadMoreActiveResults();
  await f.view.loadMoreActiveResults();
  assert.equal(f.calls.length, 2);
  more.reject(new Error('failure'));
  await task;
  f.observers.at(-1).fire();
  await flush();
  assert.equal(f.calls.length, 2);
});
test('round13: hot search does not delay scroll attachment and unmount cancels delayed attachment', async (t) => {
  const f = fixture(t),
    pending = deferred(),
    listeners = new Set();
  f.hot(() => pending.promise);
  f.scroll.value = {
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    scrollTop: 0,
  };
  const mount = f.mount();
  await flush();
  assert.equal(listeners.size, 1);
  assert.ok(f.observers.length);
  f.stop();
  pending.resolve(hot('late'));
  await mount;
  await flush();
  assert.equal(listeners.size, 0);
  assert.deepEqual(f.view.hotSearchCategories.value, []);
  assert.equal(f.view.isLoadingHot.value, false);
  assert.ok(f.observers.every((o) => !o.nodes.length));
});
test('round13: attachment waiting for nextTick cannot resurrect an unmounted observer', async (t) => {
  const f = fixture(t);
  f.scroll.value = {
    addEventListener: () => assert.fail('late listener'),
    removeEventListener() {},
    scrollTop: 0,
  };
  const task = f.view.attachScrollTarget();
  f.stop();
  await task;
  assert.equal(f.observers.length, 0);
});
test('round13: deactivation and root replacement disconnect observers and ignore queued callbacks', async (t) => {
  const f = fixture(t),
    listeners = new Set();
  const root = () => ({
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    scrollTop: 0,
  });
  f.scroll.value = root();
  await flush();
  f.respond(() => page([1]));
  await f.view.runSearch('keyword');
  const old = f.observers.at(-1);
  f.scroll.value = root();
  await flush();
  const count = f.calls.length;
  old.fire();
  await flush();
  assert.equal(f.calls.length, count);
  f.deactivate();
  assert.equal(listeners.size, 0);
  f.observers.at(-1).fire();
  await flush();
  assert.equal(f.calls.length, count);
  f.activate();
  await flush();
  assert.equal(listeners.size, 1);
});
test('round13: newer hot result wins and failures keep the successful snapshot', async (t) => {
  const f = fixture(t),
    old = deferred();
  f.hot(() => old.promise);
  const task = f.view.loadHotSearches();
  f.hot(() => hot('new'));
  await f.view.loadHotSearches();
  old.resolve(hot('old'));
  await task;
  assert.equal(f.view.hotSearchCategories.value[0].keywords[0].keyword, 'new');
  f.hot(() => Promise.reject(new Error('failure')));
  await f.view.loadHotSearches();
  assert.equal(f.view.hotSearchCategories.value[0].keywords[0].keyword, 'new');
});
for (const invalidation of ['disable', 'disable-reenable', 'unmount']) {
  test(`round13: TitleBar ${invalidation} rejects a late default search word`, async (t) => {
    const f = fixture(t, 'TitleBar'),
      old = deferred();
    f.default(() => old.promise);
    const task = f.view.fetchDefaultSearch();
    if (invalidation === 'unmount') f.stop();
    else f.setting.searchDefaultEnabled = false;
    if (invalidation === 'disable-reenable') {
      f.default(() => ads('new'));
      f.setting.searchDefaultEnabled = true;
      await flush();
    }
    old.resolve(ads('old'));
    await task;
    await flush();
    assert.equal(f.view.defaultKeyword.value, invalidation === 'disable-reenable' ? 'new' : '');
  });
}
test('round13: latest TitleBar default result wins, explicit empty ads clears the previous word', async (t) => {
  const f = fixture(t, 'TitleBar'),
    old = deferred();
  f.default(() => old.promise);
  const task = f.view.fetchDefaultSearch();
  f.default(() => ads('new'));
  await f.view.fetchDefaultSearch();
  old.resolve(ads('old'));
  await task;
  await flush();
  assert.equal(f.view.defaultKeyword.value, 'new');
  f.default(() => ({ data: { ads: [] } }));
  await f.view.fetchDefaultSearch();
  await flush();
  assert.equal(f.view.defaultKeyword.value, '');
  assert.deepEqual(f.view.defaultAds.value, []);
});
test('round13: TitleBar failed default request keeps its snapshot and disabled requests do not start', async (t) => {
  const f = fixture(t, 'TitleBar');
  await f.view.fetchDefaultSearch();
  await flush();
  f.default(() => Promise.reject(new Error('failure')));
  await f.view.fetchDefaultSearch();
  await flush();
  assert.equal(f.view.defaultKeyword.value, 'current');
  f.setting.searchDefaultEnabled = false;
  const count = f.defaults.length;
  await f.view.fetchDefaultSearch();
  assert.equal(f.defaults.length, count);
});
test('round13: TitleBar hot search after unmount does not write state', async (t) => {
  const f = fixture(t, 'TitleBar'),
    pending = deferred();
  f.hot(() => pending.promise);
  const task = f.view.loadHotSearches();
  f.stop();
  pending.resolve(hot('late'));
  await task;
  assert.deepEqual(f.view.hotSearchCategories.value, []);
  assert.equal(f.view.isLoadingHot.value, false);
});
test('round13: valid search contracts include aliases, null, no total, and integer string totals', () => {
  assert.deepEqual(helpers.extractSearchLists({ data: { lists: null } }), []);
  assert.deepEqual(helpers.extractSearchLists({ list: [row(1)] }), [row(1)]);
  assert.equal(helpers.extractSearchTotal({ data: { lists: [] } }), null);
  assert.equal(helpers.extractSearchTotal({ data: { total: '100' } }), 100);
});

const renderScript = (path) => {
  const { descriptor } = parse(read(path));
  const compiled = compileScript(descriptor, { id: 'search-render' });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: path,
    id: 'search-render',
    compilerOptions: { bindingMetadata: compiled.bindings },
  });
  assert.deepEqual(template.errors, []);
  return { script: compiled.content, render: evaluate(template.code, { vue }).render };
};
const tree = (node) => {
  const children = Array.isArray(node?.children)
    ? node.children
    : (node?.children?.default?.() ?? []);
  return [node, ...children.flatMap(tree)];
};
test('round13: actual search retry button reloads its category without resetting other results', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1], 1));
  await f.view.runSearch('keyword');
  await f.view.loadSearchResults('album');
  f.respond(() => Promise.reject(new Error('failure')));
  await f.view.loadSearchResults('song');
  const { render } = renderScript('../src/renderer/views/Search.vue');
  const vnode = render({}, [], {}, vue.proxyRefs(f.view), {}, {});
  const button = tree(vnode).find((node) =>
    node?.children?.default?.().some((child) => child?.children === '重新搜索'),
  );
  assert.ok(button, 'retry button must render');
  const retry = deferred();
  f.respond(() => retry.promise);
  const operation = button.props.onClick();
  assert.equal(f.view.isLoading.value, true);
  assert.equal(f.view.albumResults.value[0]?.id, '1');
  retry.resolve(page([2], 1));
  await operation;
  assert.equal(f.view.songResults.value[0]?.id, '2');
  assert.equal(f.view.albumResults.value[0]?.id, '1');
  assert.equal(f.history.length, 1);
});
test('round13: actual pagination retry control emits retry and never shows an end message on failure', async (t) => {
  const path = '../src/renderer/views/search/components/SearchLoadMoreStatus.vue';
  const { script, render } = renderScript(path);
  const Button = vue.defineComponent({
    emits: ['click'],
    setup:
      (_, { emit, slots }) =>
      () =>
        vue.h('button', { onClick: () => emit('click') }, slots.default?.()),
  });
  const component = evaluate(script, {
    vue,
    '@/components/ui/Button.vue': Button,
  }).default;
  component.render = render;
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, children: [], props: {} }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      node.text = text;
      node.children = [];
    },
    patchProp: (node, key, _, value) => {
      node.props[key] = value;
    },
    insert: (node, parent) => {
      node.parent = parent;
      parent.children.push(node);
    },
    remove: (node) => {
      if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node);
    },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
  });
  const state = vue.reactive({
    ...helpers.createSearchPaginationState(),
    hasMore: true,
    error: '加载更多失败，请重试',
  });
  let retries = 0;
  const app = renderer.createApp({
    render: () =>
      vue.h(component, {
        activePagination: state,
        hasItems: true,
        setSentinelRef() {},
        onRetry: () => retries++,
      }),
  });
  const root = { children: [] };
  app.mount(root);
  t.after(() => app.unmount());
  const nodes = tree(root);
  const button = nodes.find((node) => node?.tag === 'button');
  assert.ok(button);
  button.props.onClick();
  assert.equal(retries, 1);
  assert.ok(nodes.some((node) => node?.text === state.error));
  assert.equal(
    nodes.some((node) => node?.text === '没有更多结果了'),
    false,
  );
  state.error = '';
  state.hasMore = false;
  await vue.nextTick();
  assert.ok(tree(root).some((node) => node?.text?.includes('没有更多结果了')));
});
test('round13: old page success cannot append or unlock new pagination', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1]));
  await f.view.runSearch('old');
  const old = deferred();
  f.respond(() => old.promise);
  const first = f.view.loadMoreActiveResults();
  f.respond(() => page([2]));
  await f.view.runSearch('new');
  const current = deferred();
  f.respond(() => current.promise);
  const second = f.view.loadMoreActiveResults();
  old.resolve(page([9]));
  await first;
  assert.deepEqual(
    f.view.songResults.value.map((song) => song.id),
    ['2'],
  );
  assert.equal(f.view.paginationState.song.loadingMore, true);
  await f.view.loadMoreActiveResults();
  assert.equal(f.calls.length, 4);
  current.resolve(page([3], 2));
  await second;
  assert.deepEqual(
    f.view.songResults.value.map((song) => song.id),
    ['2', '3'],
  );
});
test('round13: inactive page failure preserves pagination and retries on return', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1]));
  await f.view.runSearch('keyword');
  const pending = deferred();
  f.respond(() => pending.promise);
  const task = f.view.loadMoreActiveResults();
  f.deactivate();
  pending.reject(new Error('late'));
  await task;
  assert.equal(f.view.paginationState.song.hasMore, true);
  assert.equal(f.view.paginationState.song.loadingMore, false);
  assert.equal(f.view.paginationState.song.error, '');
  f.active.value = true;
  f.respond(() => page([2], 2));
  await f.view.loadMoreActiveResults();
  assert.equal(f.calls.at(-1)[2], 2);
});
test('round13: rejected later page keeps its snapshot and page number for retry', async (t) => {
  const f = fixture(t);
  f.respond(() => page([1]));
  await f.view.runSearch('keyword');
  f.respond(() => Promise.reject(new Error('network')));
  await f.view.loadMoreActiveResults();
  assert.equal(f.view.paginationState.song.page, 1);
  assert.deepEqual(
    f.view.songResults.value.map((song) => song.id),
    ['1'],
  );
  assert.ok(f.view.paginationState.song.error);
  f.respond(() => page([2], 2));
  await f.view.loadMoreActiveResults();
  assert.equal(f.calls.at(-1)[2], 2);
});
test('round13: tab requests remain independent and revisiting loaded tabs reuses results', async (t) => {
  const f = fixture(t);
  const song = deferred();
  f.respond(() => song.promise);
  f.route.query.q = 'keyword';
  const operation = f.view.runSearch('keyword');
  f.respond(() => page([2], 1));
  f.tab.value = 'album';
  await flush();
  assert.equal(f.view.albumResults.value[0]?.id, '2');
  song.resolve(page([1], 1));
  await operation;
  f.tab.value = 'song';
  await flush();
  assert.equal(f.view.songResults.value[0]?.id, '1');
  assert.equal(f.calls.length, 2);
});
test('round13: search without totals uses raw page length and accepts an explicit null last page', async (t) => {
  const f = fixture(t);
  f.respond(() => ({ data: { lists: Array.from({ length: 30 }, (_, i) => row(i)) } }));
  await f.view.runSearch('keyword');
  assert.equal(f.view.paginationState.song.hasMore, true);
  f.respond(() => ({ data: { lists: null } }));
  await f.view.loadMoreActiveResults();
  assert.equal(f.view.paginationState.song.hasMore, false);
  assert.equal(f.view.songResults.value.length, 30);
});

test('round13: repeated mount and activation attachment reuse one observer for the same root', async (t) => {
  const f = fixture(t),
    listeners = new Set();
  f.scroll.value = {
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    scrollTop: 0,
  };
  await Promise.all([f.view.attachScrollTarget(), f.view.attachScrollTarget()]);
  await flush();
  assert.equal(f.observers.length, 1);
  assert.equal(listeners.size, 1);
  f.activate();
  await flush();
  assert.equal(f.observers.length, 1);
});
test('round13: a queued intersection for a replaced sentinel cannot load the current tab', async (t) => {
  const f = fixture(t),
    old = vue.markRaw({}),
    current = vue.markRaw({});
  f.scroll.value = { addEventListener() {}, removeEventListener() {}, scrollTop: 0 };
  f.view.loadMoreSentinelRef.value = old;
  await flush();
  f.respond(() => page([1]));
  await f.view.runSearch('keyword');
  f.view.loadMoreSentinelRef.value = current;
  await flush();
  const observer = f.observers.at(-1),
    count = f.calls.length;
  observer.fire(old);
  await flush();
  assert.equal(f.calls.length, count);
  f.respond(() => page([2], 2));
  observer.fire(current);
  await flush();
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.view.songResults.value.length, 2);
});

test('search keeps its original empty-result and nullable-alias parsing', () => {
  for (const data of [{}, { lists: {} }, { lists: null }, { lists: [] }]) {
    assert.deepEqual(helpers.extractSearchLists({ status: 1, data }), []);
  }
  assert.deepEqual(helpers.extractSearchLists({ data: { lists: null, list: [row(1)] } }), [row(1)]);
  assert.equal(helpers.extractSearchTotal({ data: { total: 'unknown' } }), null);
});
