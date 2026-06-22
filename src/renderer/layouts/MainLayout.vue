<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { pageTransitionState } from '@/plugins/runtime';
import { YzsKeepAlive } from 'yzs-keep-alive-v3';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';

const route = useRoute();
const settingStore = useSettingStore();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));
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
  if (!settingStore.sidebarCollapseEnabled) return false;
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
  if (!settingStore.sidebarCollapseEnabled) return;

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

const replayPageRouteAnimation = () => {
  stopPageRouteAnimation();
  isPageRouteEntering.value = false;
  if (!pageTransitionState.enabled) return;

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
  'lyric-page',
  'song-detail-page',
  'mv-detail',
  'profile',
  'settings-page',
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
    class="main-layout relative h-screen w-screen flex overflow-hidden bg-bg-main text-text-main transition-colors duration-300"
  >
    <!-- 主题色顶部渐变氛围层（横跨侧栏与内容，盖住中缝避免出现分隔白线） -->
    <div class="layout-accent-gradient"></div>

    <div
      class="sidebar-wrapper shrink-0 relative"
      :style="{ width: isSidebarCollapsed ? '80px' : '230px' }"
    >
      <Sidebar class="absolute inset-0" :collapsed="isSidebarCollapsed" />
    </div>

    <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar :is-sidebar-collapsed="isSidebarCollapsed" @toggle-sidebar="toggleSidebar" />
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          <router-view v-slot="{ Component }">
            <YzsKeepAlive v-if="keepAliveMax > 0" :exclude="excludeFromCache" :max="keepAliveMax">
              <component
                :is="Component"
                :key="routeViewKey"
                :class="{ [pageRouteEnterClass]: isPageRouteEntering }"
              />
            </YzsKeepAlive>
            <component
              v-else
              :is="Component"
              :key="routeViewKey"
              :class="{ [pageRouteEnterClass]: isPageRouteEntering }"
            />
          </router-view>
        </div>
      </main>

      <PlayerBar />
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  user-select: none;
}

.sidebar-wrapper {
  overflow: hidden;
  transition: width 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
</style>
