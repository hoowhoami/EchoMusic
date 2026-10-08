import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import { renderToString } from 'vue/server-renderer';
import * as vueRouter from 'vue-router';
const require = createRequire(import.meta.url);
const read = (path) => readFileSync(`src/renderer/${path}`, 'utf8');
const evaluate = (source, deps = {}, globals = {}) => {
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    ...Object.keys(globals),
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )(
    (key) => {
      assert.ok(key in deps, `missing dependency ${key}`);
      return deps[key];
    },
    mod,
    mod.exports,
    ...Object.values(globals),
  );
  return mod.exports;
};
const bundle = (path) => {
  const source = buildSync({
    entryPoints: [`src/renderer/${path}`],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, mod, mod.exports);
  return mod.exports;
};
const layout = evaluate(read('layouts/sidebarLayout.ts'));
const resources = bundle('layouts/sidebarShortcutResources.ts');
const order = bundle('utils/playlistOrder.ts');
const registry = {
  pluginShortcuts: vue.ref([]),
  pluginPages: vue.ref([]),
  pluginSidebarItems: vue.ref([]),
};
const entries = evaluate(read('layouts/sidebarShortcutEntries.ts'), {
  '@/icons': {},
  '@/plugins/registry': registry,
  './sidebarLayout': layout,
  './sidebarShortcutResources': resources,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const pluginEntry = (options = {}) => ({
  key: JSON.stringify(['plugin', 'card']),
  pluginId: 'plugin',
  title: '插件首页',
  ...options,
});
const baseLayout = (shortcutKeys) => ({ ...layout.emptySidebarLayout(), shortcutKeys });

test('default cards are removable and minimum fallback does not reinsert both required cards', () => {
  assert.deepEqual(layout.normalizeShortcutKeys(['ranking']), ['ranking']);
  assert.deepEqual(layout.normalizeShortcutKeys(['explore', 'explore']), ['explore']);
  assert.deepEqual(layout.normalizeShortcutKeys([]), ['home']);
  assert.deepEqual(layout.normalizeShortcutKeys(undefined), ['home', 'explore']);
});

test('home follows first card for builtins, resources and plugin actions without skipping it', async () => {
  assert.equal(
    entries.resolveSidebarHomeEntry(baseLayout(['ranking', 'home'])).path,
    '/main/ranking',
  );
  const artist = { kind: 'artist', id: '12/34', title: '艺人' };
  assert.equal(
    entries.resolveSidebarHomeEntry({
      ...baseLayout([resources.resourceShortcutKey(artist)]),
      shortcutResources: [artist],
    }).path,
    '/main/artist/12%2F34',
  );
  let calls = 0;
  registry.pluginShortcuts.value = [
    pluginEntry({
      onClick: () => {
        calls++;
      },
    }),
  ];
  const action = entries.resolveSidebarHomeEntry(baseLayout([pluginEntry().key, 'home']));
  assert.equal(action.key, pluginEntry().key);
  assert.equal(action.path, undefined);
  await action.onClick();
  assert.equal(calls, 1);
  registry.pluginShortcuts.value = [];
});

test('missing plugins retain saved keys while the visible sidebar has at least one card', () => {
  const saved = ['unavailable-plugin'];
  const visible = entries.resolveSidebarShortcutEntries(saved, entries.getSidebarFunctionEntries());
  assert.deepEqual(
    visible.map((entry) => entry.key),
    ['home'],
  );
  assert.deepEqual(saved, ['unavailable-plugin']);
});

test('homepage waits for restored settings and plugin registration before choosing first entry', async () => {
  const hydration = deferred(),
    pluginReady = deferred();
  const settings = vue.reactive({ sidebarLayout: baseLayout(undefined) });
  let waits = 0;
  const api = evaluate(
    read('utils/sidebarHome.ts').replace(
      "await import('@/plugins/runtime')",
      'await Promise.resolve(runtime)',
    ),
    {
      '@/stores/setting': { useSettingStore: () => settings },
      '@/stores/sqlitePersist': { waitForSqlitePersistHydration: () => hydration.promise },
      '@/layouts/sidebarLayout': layout,
      '@/layouts/sidebarShortcutEntries': entries,
      '@/layouts/sidebarShortcutResources': resources,
    },
    {
      runtime: {
        waitForPluginRuntimeReady: () => {
          waits++;
          return pluginReady.promise;
        },
      },
    },
  );
  const opening = api.getSidebarHomeEntry();
  settings.sidebarLayout = baseLayout([pluginEntry().key, 'home']);
  hydration.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(waits, 1);
  registry.pluginShortcuts.value = [pluginEntry({ pageId: 'page' })];
  registry.pluginPages.value = [{ pluginId: 'plugin', id: 'page' }];
  pluginReady.resolve();
  const home = await opening;
  assert.equal(home.path, '/main/plugin/plugin/page');
  registry.pluginShortcuts.value = [];
  registry.pluginPages.value = [];
});

const passthrough = (props, { slots }) =>
  vue.h('div', props, [slots.trigger?.(), slots.default?.()]);
function component(path, deps, hookVue = vue, inlineTemplate = true) {
  const source = compileScript(parse(read(path)).descriptor, { id: path, inlineTemplate }).content;
  return evaluate(
    source,
    new Proxy(
      {
        vue: hookVue,
        'vue-router': {
          useRouter: () => ({ push() {}, replace() {} }),
          useRoute: () =>
            vue.reactive({ name: 'home', path: '/main/home', params: {}, fullPath: '/main/home' }),
        },
        ...deps,
      },
      {
        has: () => true,
        get: (target, key) =>
          key in target
            ? target[key]
            : key.endsWith('.vue')
              ? passthrough
              : key === '@/icons'
                ? {}
                : key === '@iconify/vue'
                  ? { Icon: passthrough }
                  : {},
      },
    ),
  ).default;
}

test('removing either default card leaves one and last visible card cannot be removed through picker or grid', async () => {
  const settings = vue.reactive({ sidebarLayout: baseLayout(['home', 'explore']) });
  const comp = component(
    'layouts/SidebarShortcuts.vue',
    {
      '@/stores/setting': { useSettingStore: () => settings },
      '@/stores/toast': { useToastStore: () => ({ warning() {} }) },
      '@/stores/historyStore': { useHistoryStore: () => ({ entries: [] }) },
      '@/stores/playlist': { usePlaylistStore: () => ({ userPlaylists: [], playbackQueues: [] }) },
      '@/stores/playlistCovers': {
        usePlaylistCoversStore: () => ({ hydrate() {}, coverFor() {} }),
      },
      '@/stores/user': { useUserStore: () => ({}) },
      './sidebarShortcutEntries': entries,
      './sidebarLayout': layout,
      './sidebarShortcutResources': resources,
      sortablejs: { default: { create() {} } },
    },
    {
      ...vue,
      onMounted() {},
      onBeforeUnmount() {},
      watch: (source, callback, options) =>
        vue.watch(
          source,
          callback,
          options?.immediate ? { ...options, immediate: false } : options,
        ),
    },
  );
  // Render the real grid and picker controls with component dependencies stubbed.
  let html = await renderToString(vue.createSSRApp(comp).component('Icon', passthrough));
  assert.match(html, /移除为您推荐卡片/);
  assert.match(html, /移除探索发现卡片/);
  settings.sidebarLayout.shortcutKeys = ['explore'];
  html = await renderToString(vue.createSSRApp(comp).component('Icon', passthrough));
  assert.doesNotMatch(html, /shortcut-remove/);
  assert.match(html, /探索发现（首页）/);
  assert.match(html, /disabled[^>]*aria-label="至少保留一张卡片：探索发现"/);
  assert.doesNotMatch(html, /必留/);
});

test('card handlers reject deleting the last visible card and keep first-card ordering when moved', (t) => {
  const settings = vue.reactive({ sidebarLayout: baseLayout(['home', 'explore']) });
  const comp = component(
    'layouts/SidebarShortcuts.vue',
    {
      '@/stores/setting': { useSettingStore: () => settings },
      '@/stores/toast': { useToastStore: () => ({ warning() {} }) },
      '@/stores/historyStore': { useHistoryStore: () => ({ entries: [] }) },
      '@/stores/playlist': { usePlaylistStore: () => ({ userPlaylists: [], playbackQueues: [] }) },
      '@/stores/playlistCovers': {
        usePlaylistCoversStore: () => ({ hydrate() {}, coverFor() {} }),
      },
      '@/stores/user': { useUserStore: () => ({}) },
      './sidebarShortcutEntries': entries,
      './sidebarLayout': layout,
      './sidebarShortcutResources': resources,
      sortablejs: {},
    },
    { ...vue, onMounted() {}, onBeforeUnmount() {} },
    false,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const api = scope.run(() => comp.setup({}, { expose() {} }));
  api.remove(api.visible.value[0], false);
  assert.deepEqual(settings.sidebarLayout.shortcutKeys, ['explore']);
  api.remove(api.visible.value[0], false);
  api.toggle(api.visible.value[0]);
  assert.deepEqual(settings.sidebarLayout.shortcutKeys, ['explore']);
  api.toggle(entries.builtinSidebarShortcuts.find((e) => e.key === 'ranking'));
  api.move('ranking', -1);
  assert.deepEqual(settings.sidebarLayout.shortcutKeys, ['ranking', 'explore']);
  assert.equal(entries.resolveSidebarHomeEntry(settings.sidebarLayout).path, '/main/ranking');
  settings.sidebarLayout.shortcutKeys = ['unavailable', 'ranking'];
  api.remove(api.visible.value[0], false);
  assert.deepEqual(settings.sidebarLayout.shortcutKeys, ['unavailable', 'ranking']);
});

test('action-card homepage executes that first card on entry and keeps failures retryable', async (t) => {
  const settings = vue.reactive({ sidebarLayout: baseLayout([pluginEntry().key, 'home']) });
  const mounted = [],
    messages = [];
  let calls = 0;
  registry.pluginShortcuts.value = [
    pluginEntry({
      onClick: () => {
        calls++;
        throw new Error('action failed');
      },
    }),
  ];
  const comp = component(
    'views/SidebarHome.vue',
    {
      '@/stores/setting': { useSettingStore: () => settings },
      '@/stores/toast': { useToastStore: () => ({ warning: (m) => messages.push(m) }) },
      '@/layouts/sidebarShortcutEntries': entries,
    },
    { ...vue, onMounted: (fn) => mounted.push(fn) },
    false,
  );
  const scope = vue.effectScope();
  t.after(() => {
    scope.stop();
    registry.pluginShortcuts.value = [];
  });
  const api = scope.run(() => comp.setup({}, { expose() {} }));
  assert.equal(api.entry.value.key, pluginEntry().key);
  mounted[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(api.busy.value, false);
  assert.deepEqual(messages, ['action failed']);
  await api.openHome();
  assert.equal(calls, 2);
});

for (const collapsed of [false, true])
  test(`playlist root hides the complete ${collapsed ? 'collapsed' : 'expanded'} area and editor stays reachable`, async () => {
    const settings = vue.reactive({
      sidebarLayout: layout.emptySidebarLayout(),
      sidebarSectionCollapsed: {},
    });
    const user = vue.reactive({ isLoggedIn: true, info: { userid: 1 }, accountRevision: 1 });
    const playlists = vue.reactive({
      userPlaylists: [
        {
          id: 1,
          listid: 1,
          name: '默认收藏',
          listCreateUserid: 1,
          source: 1,
          type: 0,
          isDefault: true,
        },
        { id: 2, listid: 2, name: '自建测试歌单', listCreateUserid: 1, source: 1 },
        { id: 3, listid: 3, name: '收藏测试歌单', listCreateUserid: 2, source: 1 },
      ],
    });
    const comp = component(
      'layouts/Sidebar.vue',
      {
        '@/stores/setting': { useSettingStore: () => settings },
        '@/stores/user': { useUserStore: () => user },
        '@/stores/playlist': { usePlaylistStore: () => playlists },
        '@/stores/playlistCovers': {
          usePlaylistCoversStore: () => ({ hydrate() {}, coverFor: () => '' }),
        },
        '@/stores/toast': { useToastStore: () => ({}) },
        '@/stores/importTask': { useImportTaskStore: () => ({}) },
        '@/plugins/registry': registry,
        './sidebarLayout': layout,
        '@/utils/playlistOrder': order,
      },
      { ...vue, onMounted() {} },
    );
    const render = () =>
      renderToString(vue.createSSRApp(comp, { collapsed }).component('Icon', passthrough));
    let html = await render();
    assert.match(html, /自建歌单/);
    assert.match(html, /收藏歌单/);
    assert.match(html, /自建测试歌单/);
    settings.sidebarLayout = layout.setSidebarSectionHidden(
      settings.sidebarLayout,
      layout.SIDEBAR_PLAYLIST_SECTION_ID,
      true,
    );
    html = await render();
    assert.doesNotMatch(
      html,
      /sidebar-playlist-header|sidebar-rail-playlists|自建测试歌单|收藏测试歌单|登录同步云端歌单/,
    );
    assert.match(html, /sidebar-(layout-toolbar|rail-bottom)/);
    settings.sidebarLayout = layout.setSidebarSectionHidden(
      settings.sidebarLayout,
      layout.SIDEBAR_PLAYLIST_SECTION_ID,
      false,
    );
    assert.match(await render(), /自建测试歌单/);
  });

test('home navigation redirects to current first page while actions keep their home host', async () => {
  let first = { path: '/main/ranking' };
  const source = read('router/index.ts')
    .replace(/import\('[^']+\.vue'\)/g, 'Promise.resolve({default:{}})')
    .replace("await import('@/utils/sidebarHome')", 'await Promise.resolve(home)');
  const api = evaluate(
    source,
    {
      'vue-router': { ...vueRouter, createWebHashHistory: vueRouter.createMemoryHistory },
      '@/composables/useSettingsDialog': {
        openSettingsDialog() {},
        settingsDialogOpen: vue.ref(false),
      },
    },
    { home: { getSidebarHomeEntry: async () => first } },
  );
  await api.default.push('/main');
  assert.equal(api.default.currentRoute.value.path, '/main/ranking');
  first = { onClick() {} };
  await api.default.push('/main');
  assert.equal(api.default.currentRoute.value.name, 'sidebar-home');
  first = { path: '/main/explore' };
  await api.default.push('/main/history');
  await api.default.push('/main');
  assert.equal(api.default.currentRoute.value.path, '/main/explore');
});
