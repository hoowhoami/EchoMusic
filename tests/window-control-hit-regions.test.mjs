import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as vue from 'vue';
import { renderToString } from '@vue/server-renderer';

function loadComponent(file, dependencies, platform) {
  const descriptor = parse(readFileSync(`src/renderer/layouts/${file}`, 'utf8')).descriptor;
  const script = compileScript(descriptor, { id: file, inlineTemplate: true });
  const code = transformSync(script.content, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      const dependency = dependencies[name];
      return 'default' in dependency ? { __esModule: true, ...dependency } : dependency;
    },
    module,
    module.exports,
    { electron: { platform, windowControl() {} }, history: { state: {} } },
  );
  return module.exports.default;
}

const slot = {
  inheritAttrs: false,
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.(),
};
const empty = { render: () => null };

for (const platform of ['win32', 'linux']) {
  for (const collapsed of [false, true]) {
    test(`${platform}: ${collapsed ? 'collapsed' : 'expanded'} layout keeps inset caption controls outside native drag regions`, async () => {
      const button = {
        inheritAttrs: false,
        setup:
          (_, { slots, attrs }) =>
          () =>
            vue.h('button', attrs, slots.default?.()),
      };
      const windowControls = loadComponent(
        'WindowControls.vue',
        {
          vue,
          '@iconify/vue': { Icon: empty },
          '@/icons': { iconX: {}, iconMinus: {} },
          '@/components/ui/Button.vue': { default: button },
          '@/stores/setting': { useSettingStore: () => ({ showFullscreenButton: false }) },
        },
        platform,
      );
      const titlebar = loadComponent(
        'TitleBar.vue',
        {
          vue,
          './windowDrag': { isWindowDragTarget() {} },
          '@/utils/logger': { logger: {} },
          './WindowControls.vue': { default: windowControls },
          './TitleBarMoreMenu.vue': { default: empty },
          './TitlebarActionButton.vue': { default: empty },
          './useTitlebarSort': { useTitlebarSort() {} },
          '@vueuse/core': { useResizeObserver() {} },
          '@/plugins/titlebar': {
            createTitlebarApi: () => ({}),
            titlebarItems: vue.ref([]),
            resolveTitlebarLayout: () => [],
            partitionTitlebarActions: () => ({ toolbar: [] }),
          },
          'vue-router': {
            useRoute: () => ({
              path: '/main/home',
              fullPath: '/main/home',
              query: {},
              matched: [],
            }),
            useRouter: () => ({}),
          },
          'reka-ui': {
            PopoverRoot: slot,
            PopoverAnchor: slot,
            PopoverPortal: empty,
            PopoverContent: empty,
          },
          '@/views/search/components/SearchDiscovery.vue': { default: empty },
          '@/views/search/searchHelpers': {},
          '@/api/search': {},
          '@/stores/setting': { useSettingStore: () => ({}) },
          '@/plugins/taskPanel': { taskPanelEntries: vue.ref([]), taskPanelOpen: vue.ref(false) },
          '@/components/ui/Button.vue': { default: button },
          '@/components/ui/RefreshIcon.vue': { default: empty },
          '@/components/ui/Dialog.vue': { default: empty },
          '@/icons': {},
        },
        platform,
      );
      // Preserve the real Sidebar's overlapping top drag rectangle while isolating
      // account/network/player initialization from this native hit-region regression.
      const sidebar = { render: () => vue.h('div', { class: 'drag-region sidebar-test-drag' }) };
      const layout = loadComponent(
        'MainLayout.vue',
        {
          vue,
          'vue-router': {
            useRoute: () => ({ path: '/main/home', query: {}, hash: '', fullPath: '/main/home' }),
            useRouter: () => ({ resolve: () => ({ fullPath: '/main/home' }) }),
          },
          '@vueuse/core': { useResizeObserver() {}, useMediaQuery: () => vue.ref(false) },
          '@/stores/setting': {
            useSettingStore: () => ({ sidebarCollapsed: collapsed, keepAliveEnabled: false }),
          },
          '@/composables/usePageEntryMotion': {
            usePageEntryMotion: () => ({
              host: vue.ref(null),
              entering: vue.ref(false),
              className: vue.ref(''),
              replay() {},
            }),
          },
          '@/plugins/runtime/theme': { pageTransitionState: { enabled: false } },
          '@/utils/routeViewCache': {
            getRouteViewCacheQuery: () => ({}),
            updateRouteViewCacheKey: (key) => ({ key }),
          },
          '@/components/app/RouteKeepAlive': { default: slot },
          './Sidebar.vue': { default: sidebar },
          './TitleBar.vue': { default: titlebar },
          './PlayerBar.vue': { default: empty },
          '@/theme/ThemeBackground.vue': { default: slot },
          '@/theme/ThemeContent.vue': { default: empty },
          '@/theme/useWindowAppearance': { provideWindowAppearance() {} },
          '@/stores/theme': {
            useThemeStore: () => ({ effectiveThemeKey: 'echo', currentTheme: { revision: 1 } }),
          },
        },
        platform,
      );
      const app = vue.createSSRApp(layout);
      app.component('Icon', empty);
      app.component('router-view', {
        setup:
          (_, { slots }) =>
          () =>
            slots.default?.({ Component: empty }),
      });
      const html = await renderToString(app);
      const sidebarWidth = collapsed ? 80 : 230;
      const regions = [...html.matchAll(/<[^>]*class="([^"]*)"[^>]*>/g)].flatMap((match) => {
        const classes = match[1].split(/\s+/);
        if (classes.includes('layout-window-drag-strip'))
          return [{ draggable: true, x: 0, y: 0, width: 1100, height: 8 }];
        if (classes.includes('sidebar-test-drag'))
          return [{ draggable: true, x: 0, y: 0, width: sidebarWidth, height: 46 }];
        if (
          classes.includes('title-bar') ||
          (classes.includes('drag-region') && !classes.includes('sidebar-test-drag'))
        )
          return [
            { draggable: true, x: sidebarWidth, y: 8, width: 1092 - sidebarWidth, height: 46 },
          ];
        if (classes.includes('titlebar-drag-space'))
          return [{ draggable: true, x: sidebarWidth + 450, y: 8, width: 100, height: 46 }];
        if (classes.includes('window-caption-controls'))
          return [{ draggable: false, x: 980, y: 16, width: 100, height: 30 }];
        return [];
      });
      assert.equal(
        regions.length,
        6,
        'actual layout renders sidebar, titlebar drag regions and caption controls',
      );
      assert.equal(html.includes('traffic-lights'), false, 'no left traffic lights remain');
      // Electron's DraggableRegionsToSkRegion applies union/difference in document
      // order, independently of CSS z-index. A later drag rect can fill a no-drag hole.
      const draggableAt = (x, y) =>
        regions.reduce(
          (state, region) =>
            x >= region.x &&
            x < region.x + region.width &&
            y >= region.y &&
            y < region.y + region.height
              ? region.draggable
              : state,
          false,
        );
      for (const x of [996, 1030, 1064])
        assert.equal(draggableAt(x, 30), false, `button at ${x}px`);
      assert.equal(draggableAt(1086, 30), true, 'right inset remains draggable');
      assert.equal(draggableAt(1030, 12), true, 'top inset remains draggable');
      assert.equal(draggableAt(500, 4), true, 'top window strip remains draggable');
    });
  }
}
