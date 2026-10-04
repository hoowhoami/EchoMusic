<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useResizeObserver } from '@vueuse/core';
import { useSettingStore } from '@/stores/setting';
import { pageTransitionState } from '@/plugins/runtime/theme';
import { getRouteViewCacheQuery, updateRouteViewCacheKey } from '@/utils/routeViewCache';
import { YzsKeepAlive } from 'yzs-keep-alive-v3';
import Sidebar from './Sidebar.vue';
import ThemeBackground from '@/theme/ThemeBackground.vue';
import ThemeContent from '@/theme/ThemeContent.vue';
import { useThemeStore } from '@/stores/theme';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import TrafficLights from './TrafficLights.vue';
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
type KeepAliveController = {
  clearCacheByKey: (key: string) => void;
};

const keepAliveRef = ref<KeepAliveController | null>(null);
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
    if (update.staleKey) {
      keepAliveRef.value?.clearCacheByKey(update.staleKey);
    }
    routeViewKey.value = update.key;
  },
  { immediate: true, flush: 'sync' },
);
const pageTransitionAppear = computed(
  () => pageTransitionState.enabled && pageTransitionState.appear,
);
const pageRouteEnterClass = computed(
  () => `${pageTransitionState.name || 'page'}-route-enter-active`,
);
const isPageRouteEntering = ref(false);
let pageRouteAnimationFrame: number | null = null;
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

const stopPageRouteAnimation = () => {
  if (pageRouteAnimationFrame !== null) {
    window.cancelAnimationFrame(pageRouteAnimationFrame);
    pageRouteAnimationFrame = null;
  }
};

// 动画结束/中断后移除 page-route-enter-active：该 class 携带 will-change 与 animation fill=both 的
// 残留 transform，会把整页常驻提升为 GPU 合成层，在高 DPI（2K 缩放）下导致整页发虚。
const handlePageRouteAnimationEnd = (event: AnimationEvent) => {
  // 仅响应页面根元素自身的进入动画，忽略子元素冒泡上来的其它动画
  if (event.target !== event.currentTarget) return;
  if (event.animationName !== 'page-route-enter') return;
  isPageRouteEntering.value = false;
};

const replayPageRouteAnimation = () => {
  stopPageRouteAnimation();
  isPageRouteEntering.value = false;
  if (!pageTransitionState.enabled) return;
  // prefers-reduced-motion 下 CSS 已把 animation 置为 none：加了 class 也不会播放动画、
  // animationend 不会触发，反而让 will-change 常驻。此时直接跳过，无需进入动画。
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  pageRouteAnimationFrame = window.requestAnimationFrame(() => {
    isPageRouteEntering.value = true;
    pageRouteAnimationFrame = null;
  });
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
  stopPageRouteAnimation();
});

const excludeFromCache = [
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

watch(
  () => pageTransitionState.enabled,
  (enabled) => {
    if (!enabled) {
      stopPageRouteAnimation();
      isPageRouteEntering.value = false;
    }
  },
);
</script>

<template>
  <div
    class="main-layout relative h-screen w-screen flex overflow-hidden text-text-main transition-colors duration-300"
    :style="{ '--layout-sidebar-width': isSidebarCollapsed ? '80px' : '230px' }"
  >
    <div class="layout-window-drag-strip window-drag-area" aria-hidden="true" />
    <TrafficLights />
    <!-- Compose all decorative layers together; transparency never wraps business content. -->
    <div class="layout-skin" aria-hidden="true">
      <ThemeBackground>
        <div ref="gradientRef" class="layout-accent-gradient frame-atmosphere" />
      </ThemeBackground>
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
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          <router-view v-slot="{ Component }">
            <YzsKeepAlive
              v-if="keepAliveMax > 0"
              ref="keepAliveRef"
              :exclude="excludeFromCache"
              :max="keepAliveMax"
            >
              <component
                :is="Component"
                :key="routeViewKey"
                :class="{ [pageRouteEnterClass]: isPageRouteEntering }"
                @animationend="handlePageRouteAnimationEnd"
                @animationcancel="handlePageRouteAnimationEnd"
              />
            </YzsKeepAlive>
            <component
              v-else
              :is="Component"
              :key="routeViewKey"
              :class="{ [pageRouteEnterClass]: isPageRouteEntering }"
              @animationend="handlePageRouteAnimationEnd"
              @animationcancel="handlePageRouteAnimationEnd"
            />
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
  --layout-panel-radius: 10px;
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
  transition: width 0.24s cubic-bezier(0.22, 1, 0.36, 1);
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
  transition: left 0.24s cubic-bezier(0.22, 1, 0.36, 1);
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
  transition: width 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.frame-atmosphere {
  /* Tint the base once; images, theme artwork and panels remain above it. */
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
    --layout-panel-radius: 8px;
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
