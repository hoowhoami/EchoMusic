<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaQuery, useResizeObserver } from '@vueuse/core';
import { useSettingStore } from '@/stores/setting';
import { usePageEntryMotion } from '@/composables/usePageEntryMotion';
import { pageTransitionState } from '@/plugins/runtime/theme';
import { getRouteViewCacheQuery, updateRouteViewCacheKey } from '@/utils/routeViewCache';
import RouteKeepAlive, { type RouteKeepAliveController } from '@/components/app/RouteKeepAlive';
import Sidebar from './Sidebar.vue';
import ThemeBackground from '@/theme/ThemeBackground.vue';
import ThemeContent from '@/theme/ThemeContent.vue';
import { useThemeStore } from '@/stores/theme';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import { provideWindowAppearance } from '@/theme/useWindowAppearance';

provideWindowAppearance();

const gradientRef = ref<HTMLElement | null>(null);
// Track the resolved size, including plugin overrides in px/%/vh, for sticky slices.
useResizeObserver(gradientRef, (entries) => {
  const entry = entries[0];
  if (!entry) return;
  (gradientRef.value?.closest('.main-layout') as HTMLElement | null)?.style.setProperty(
    '--accent-gradient-rendered-height',
    `${entry.contentRect.height}px`,
  );
});

const route = useRoute();
const router = useRouter();
const settingStore = useSettingStore();
const themeStore = useThemeStore();
const playerPanel = ref<HTMLElement | null>(null);
useResizeObserver(playerPanel, ([entry]) => {
  if (entry && playerPanel.value)
    (playerPanel.value.closest('.main-layout') as HTMLElement | null)?.style.setProperty(
      '--skin-player-height',
      `${entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height}px`,
    );
});
const keepAliveRef = ref<RouteKeepAliveController | null>(null);
const routeCacheRevisions = new Map<string, string>();
const canonicalRouteKey = computed(() => {
  const query = getRouteViewCacheQuery(route);
  return router.resolve({ path: route.path, query, hash: route.hash }).fullPath;
});
const routeRefreshToken = computed(() => {
  const value = route.query._t;
  const token = Array.isArray(value) ? value[0] : value;
  return token == null ? '' : String(token);
});
const routeViewKey = ref(canonicalRouteKey.value);

watch(
  [canonicalRouteKey, routeRefreshToken],
  ([canonicalKey, refreshToken]) => {
    const update = updateRouteViewCacheKey(canonicalKey, refreshToken, routeCacheRevisions);
    if (update.staleKey) keepAliveRef.value?.clearCacheByKey(update.staleKey);
    routeViewKey.value = update.key;
  },
  { immediate: true, flush: 'sync' },
);
const pageTransitionAppear = computed(
  () => pageTransitionState.enabled && pageTransitionState.appear,
);
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
const {
  host: pageMotionHost,
  entering: isPageRouteEntering,
  className: pageRouteEnterClass,
  replay: replayPageRouteAnimation,
} = usePageEntryMotion({
  enabled: () => pageTransitionState.enabled,
  reducedMotion: prefersReducedMotion,
  name: () => pageTransitionState.name,
});
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 700;
const isNarrowViewport = ref(false);
const narrowViewportExpanded = ref(false);

const isSidebarCollapsed = computed(() => {
  if (isNarrowViewport.value && !narrowViewportExpanded.value) return true;
  return settingStore.sidebarCollapsed;
});

const checkScreenWidth = () => {
  const nextIsNarrow = window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  if (nextIsNarrow !== isNarrowViewport.value) {
    narrowViewportExpanded.value = false;
  }
  isNarrowViewport.value = nextIsNarrow;
};

const toggleSidebar = () => {
  if (isNarrowViewport.value && !narrowViewportExpanded.value) {
    narrowViewportExpanded.value = true;
    settingStore.sidebarCollapsed = false;
    return;
  }

  narrowViewportExpanded.value = false;
  settingStore.sidebarCollapsed = !settingStore.sidebarCollapsed;
};

const handleShortcutToggleSidebar = (event: Event) => {
  event.preventDefault();
  toggleSidebar();
};

onMounted(() => {
  checkScreenWidth();
  window.addEventListener('resize', checkScreenWidth);
  window.addEventListener('echo:toggle-sidebar', handleShortcutToggleSidebar);
  if (pageTransitionAppear.value) replayPageRouteAnimation();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkScreenWidth);
  window.removeEventListener('echo:toggle-sidebar', handleShortcutToggleSidebar);
});

const excludeFromCache = [
  'sidebar-home-page',
  'login-page',
  'loading-page',
  'error-page',
  'song-detail-page',
  'mv-detail',
  'share-resolve-page',
  // 搜索由当前路由驱动，避免旧关键词缓存实例继续监听并发起请求。
  'search-page',
  'plugin-share-resolve-page',
  // 分享链接会为一起听路由附加 roomId/roomType。按 fullPath 缓存会同时保留普通页和
  // 分享页两个实例，其路由 watcher 会各自打开一个 Teleport Dialog，造成双层遮罩卡死。
  'listen-together',
  'profile',
  'settings-page',
  'theme-center',
  // 注意：歌词页（lyric-page）不在此列表。它由 App.vue 以 v-if 挂载在 KeepAlive 之外，
  // 本就不受这里的缓存影响；逐字歌词的逐帧刷新改由 LyricScroller 按窗口可见性自行开关。
];

const keepAliveMax = computed(() =>
  settingStore.keepAliveEnabled ? Math.min(settingStore.keepAliveMax, 30) : 0,
);

watch(routeViewKey, () => {
  replayPageRouteAnimation();
});
</script>

<template>
  <div
    class="main-layout relative h-screen w-screen flex overflow-hidden text-text-main transition-colors duration-300"
    :style="{ '--layout-sidebar-width': isSidebarCollapsed ? '80px' : '230px' }"
  >
    <div class="layout-window-drag-strip window-drag-area" aria-hidden="true" />
    <!-- Compose all decorative layers together; transparency never wraps business content. -->
    <div class="layout-skin" aria-hidden="true">
      <ThemeBackground />
      <div class="layout-surface-effects">
        <div class="skin-sidebar-decoration">
          <ThemeContent
            :key="themeStore.effectiveThemeKey + themeStore.currentTheme.revision"
            layer="sidebar"
          />
        </div>
        <div class="skin-workspace">
          <div class="skin-main-panel" />
          <div class="skin-player-panel">
            <div class="player-theme-decoration">
              <ThemeContent
                :key="themeStore.effectiveThemeKey + themeStore.currentTheme.revision"
                layer="player"
              />
            </div>
          </div>
        </div>
      </div>
      <!-- Tint the finished skin/material once, below all business content.
           Panel colors and image backgrounds must not attenuate cover atmosphere. -->
      <div ref="gradientRef" class="layout-accent-gradient frame-atmosphere" />
    </div>

    <div
      class="sidebar-wrapper shrink-0 relative"
      :style="{ width: isSidebarCollapsed ? '80px' : '230px' }"
    >
      <Sidebar id="main-sidebar" class="absolute inset-0" :collapsed="isSidebarCollapsed" />
    </div>

    <div class="main-workspace flex-1 flex flex-col min-w-0 min-h-0 relative">
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar :is-sidebar-collapsed="isSidebarCollapsed" />
        <!-- Animate the stable viewport, including pages with multiple root nodes.
             Keep cache identity and page mounting independent from motion. -->
        <div
          ref="pageMotionHost"
          class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden"
          :class="{ [pageRouteEnterClass]: isPageRouteEntering }"
        >
          <router-view v-slot="{ Component }">
            <RouteKeepAlive
              v-if="keepAliveMax > 0"
              ref="keepAliveRef"
              :exclude="excludeFromCache"
              :max="keepAliveMax"
            >
              <component :is="Component" :key="routeViewKey" />
            </RouteKeepAlive>
            <component v-else :is="Component" :key="routeViewKey" />
          </router-view>
        </div>
      </main>

      <div ref="playerPanel" class="main-player-panel">
        <PlayerBar />
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  user-select: none;
  isolation: isolate;
  --layout-edge-inset: 8px;
  --layout-top-inset: 8px;
  --layout-panel-radius: var(--radius-shell);
  --layout-panel-gap: 10px;
}
.layout-window-drag-strip {
  position: absolute;
  inset: 0 0 auto;
  height: var(--layout-top-inset);
  -webkit-app-region: drag;
  z-index: 201;
}
.sidebar-wrapper {
  transition: width var(--motion-duration-panel) var(--motion-ease-enter);
}
.main-workspace {
  gap: var(--layout-panel-gap);
  padding: var(--layout-top-inset) var(--layout-edge-inset) var(--layout-edge-inset) 0;
}
.main-content {
  isolation: isolate;
  border-radius: var(--layout-panel-radius);
  position: relative;
}
.main-player-panel {
  position: relative;
  isolation: isolate;
  flex-shrink: 0;
  border-radius: var(--layout-panel-radius);
  overflow: hidden;
}
.layout-skin {
  position: absolute;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  isolation: isolate;
}
.skin-workspace {
  position: absolute;
  left: var(--layout-sidebar-width);
  top: var(--layout-top-inset);
  right: var(--layout-edge-inset);
  bottom: var(--layout-edge-inset);
  display: grid;
  grid-template-rows: minmax(0, 1fr) var(--skin-player-height, 88px);
  gap: var(--layout-panel-gap);
  transition: left var(--motion-duration-panel) var(--motion-ease-enter);
}
.layout-surface-effects {
  position: absolute;
  inset: 0;
  isolation: isolate;
}
.skin-main-panel,
.skin-player-panel {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: var(--layout-panel-radius);
}
.skin-main-panel {
  background: var(--bg-main);
  backdrop-filter: var(--surface-backdrop-filter);
}
.skin-player-panel {
  background: var(--bg-player);
  backdrop-filter: var(--surface-player-backdrop-filter);
}
.skin-sidebar-decoration {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--layout-sidebar-width);
  overflow: hidden;
  transition: width var(--motion-duration-panel) var(--motion-ease-enter);
}
.frame-atmosphere {
  /* The final decorative pass shares one viewport gradient across every panel. */
  z-index: auto;
}
.player-theme-decoration {
  z-index: -1;
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
@media (max-width: 700px) {
  .main-layout {
    --layout-edge-inset: 4px;
    --layout-top-inset: 4px;
    --layout-panel-radius: var(--radius-shell);
    --layout-panel-gap: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-wrapper,
  .skin-workspace,
  .skin-sidebar-decoration {
    transition: none;
  }
}
</style>
