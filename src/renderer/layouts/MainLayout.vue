<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { YzsKeepAlive } from 'yzs-keep-alive-v3';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import SettingsDialog from '@/components/app/SettingsDialog.vue';

const route = useRoute();
const settingStore = useSettingStore();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));

const isSidebarCollapsed = computed(() => {
  if (!settingStore.sidebarCollapseEnabled) return false;
  return settingStore.sidebarCollapsed;
});

const checkScreenWidth = () => {
  if (settingStore.sidebarCollapseEnabled) {
    settingStore.sidebarCollapsed = window.innerWidth < 700;
  }
};

const toggleSidebar = () => {
  if (settingStore.sidebarCollapseEnabled) {
    settingStore.sidebarCollapsed = !settingStore.sidebarCollapsed;
  }
};

onMounted(() => {
  checkScreenWidth();
  window.addEventListener('resize', checkScreenWidth);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkScreenWidth);
});

const excludeFromCache = [
  'login-page',
  'loading-page',
  'error-page',
  'lyric-page',
  'comment-page',
  'mv-detail',
  'profile',
];

const keepAliveMax = computed(() =>
  settingStore.keepAliveEnabled ? Math.min(settingStore.keepAliveMax, 30) : 0,
);
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

    <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar :is-sidebar-collapsed="isSidebarCollapsed" @toggle-sidebar="toggleSidebar" />
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          <router-view v-slot="{ Component }">
            <YzsKeepAlive v-if="keepAliveMax > 0" :exclude="excludeFromCache" :max="keepAliveMax">
              <component :is="Component" :key="routeViewKey" />
            </YzsKeepAlive>
            <component v-else :is="Component" />
          </router-view>
        </div>
      </main>

      <PlayerBar />
    </div>

    <SettingsDialog />
  </div>
</template>

<style scoped>
.main-layout {
  user-select: none;
}

.sidebar-wrapper {
  overflow: hidden;
}
</style>
