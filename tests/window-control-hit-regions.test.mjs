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
    { electron: { platform, windowControl() {} } },
  );
  return module.exports.default;
}

const slot = {
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.(),
};
const empty = { render: () => null };

for (const platform of ['win32', 'linux']) {
  for (const collapsed of [false, true]) {
    test(`${platform}: ${collapsed ? 'collapsed' : 'expanded'} layout keeps traffic lights outside native drag regions`, async () => {
      const trafficLights = loadComponent(
        'TrafficLights.vue',
        {
          vue,
          '@iconify/vue': { Icon: empty },
          '@/icons': { iconX: {}, iconMinus: {} },
          '@iconify/icons-tabler/arrows-diagonal': { default: {} },
          '@/components/ui/Tooltip.vue': {
            default: {
              inheritAttrs: false,
              setup:
                (_, { slots }) =>
                () =>
                  slots.trigger?.(),
            },
          },
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
          'yzs-keep-alive-v3': { YzsKeepAlive: slot },
          './Sidebar.vue': { default: sidebar },
          './TitleBar.vue': { default: empty },
          './PlayerBar.vue': { default: empty },
          './TrafficLights.vue': { default: trafficLights },
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
        if (classes.includes('traffic-lights'))
          return [{ draggable: false, x: 10, y: 10, width: 60, height: 20 }];
        return [];
      });
      assert.equal(regions.length, 3, 'actual layout renders drag strip, sidebar and controls');
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
      for (const x of [20, 40, 60]) assert.equal(draggableAt(x, 20), false, `button at ${x}px`);
      assert.equal(draggableAt(75, 20), true, 'adjacent titlebar remains draggable');
      assert.equal(draggableAt(500, 4), true, 'top window strip remains draggable');
    });
  }
}
