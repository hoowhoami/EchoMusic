<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import BackToTop from '@/components/ui/BackToTop.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Button from '@/components/ui/Button.vue';
import { iconPanelLeft } from '@/icons';

const route = useRoute();
const settingStore = useSettingStore();
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));

const isSidebarCollapsed = ref(false);

const checkScreenWidth = () => {
  if (window.innerWidth < 700) {
    isSidebarCollapsed.value = true;
  } else {
    isSidebarCollapsed.value = false;
  }
};

// 始终 keepAlive 的路由
const alwaysKeepAlive = ['personal-fm', 'recognize-page'];

// 根据设置动态计算 keepAlive 列表
const keepAliveRouteNames = computed(() => {
  if (!settingStore.keepAliveEnabled) return alwaysKeepAlive;
  return [...new Set([...alwaysKeepAlive, ...settingStore.keepAliveRoutes])];
});

const keepAliveMax = computed(() =>
  settingStore.keepAliveEnabled
    ? Math.max(alwaysKeepAlive.length, Math.min(settingStore.keepAliveMax, 30))
    : alwaysKeepAlive.length,
);

// ── 滚动位置：每次路由变化归零 ──
watch(
  () => route.fullPath,
  () => {
    nextTick(() => {
      scrollbarRef.value?.setScrollTop(0);
    });
  },
);

const toggleSidebar = () => {
  isSidebarCollapsed.value = !isSidebarCollapsed.value;
};

onMounted(() => {
  checkScreenWidth();
  window.addEventListener('resize', checkScreenWidth);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkScreenWidth);
});
</script>

<template>
  <div
    class="main-layout h-screen w-screen flex overflow-hidden bg-bg-main text-text-main transition-colors duration-300"
  >
    <div
      class="sidebar-wrapper shrink-0 transition-all duration-300 ease-in-out relative"
      :class="isSidebarCollapsed ? 'w-0' : 'w-[220px]'"
    >
      <Sidebar class="absolute inset-0" :class="{ invisible: isSidebarCollapsed }" />
    </div>

    <Button
      v-if="isSidebarCollapsed"
      variant="unstyled"
      size="none"
      class="sidebar-toggle-btn absolute left-4 top-1/2 -translate-y-1/2 z-50 w-8 h-8 rounded-full bg-bg-card border border-border-light shadow-lg hover:bg-primary/10 hover:text-primary transition-all duration-200 group"
      @click="toggleSidebar"
      title="展开侧边栏"
    >
      <Icon
        :icon="iconPanelLeft"
        width="16"
        height="16"
        class="text-text-secondary group-hover:text-primary transition-colors"
      />
    </Button>

    <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar :is-sidebar-collapsed="isSidebarCollapsed" @toggle-sidebar="toggleSidebar" />
        <Scrollbar
          ref="scrollbarRef"
          class="view-port-scroll flex-1 min-h-0 min-w-0"
          :content-props="{ class: 'view-port' }"
        >
          <div>
            <router-view v-slot="{ Component }">
              <KeepAlive :include="keepAliveRouteNames" :max="keepAliveMax">
                <component :is="Component" :key="routeViewKey" />
              </KeepAlive>
            </router-view>
          </div>
        </Scrollbar>
      </main>

      <PlayerBar />
      <BackToTop target-selector=".view-port" />
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  user-select: none;
}

.sidebar-wrapper {
  overflow: hidden;
}

.sidebar-toggle-btn {
  animation: sidebar-toggle-fade-in 0.3s ease-out;
}

@keyframes sidebar-toggle-fade-in {
  from {
    opacity: 0;
    transform: translate(-10px, -50%);
  }
  to {
    opacity: 1;
    transform: translate(0, -50%);
  }
}
</style>
