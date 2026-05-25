<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { YzsKeepAlive } from 'yzs-keep-alive-v3';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import Button from '@/components/ui/Button.vue';
import { iconPanelLeft } from '@/icons';
import SettingsDialog from '@/components/app/SettingsDialog.vue';

const route = useRoute();
const settingStore = useSettingStore();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));

const isSidebarCollapsed = ref(false);

const checkScreenWidth = () => {
  isSidebarCollapsed.value = window.innerWidth < 700;
};

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

    <button
      v-if="isSidebarCollapsed"
      class="sidebar-toggle-btn absolute left-4 top-1/2 -translate-y-1/2 z-50
             w-8 h-8 rounded-full bg-bg-card border border-border-light shadow-lg
             flex items-center justify-center
             hover:bg-primary/10 hover:text-primary hover:shadow-xl hover:scale-105
             active:scale-95
             transition-all duration-200 group"
      @click="toggleSidebar"
      title="展开侧边栏"
    >
      <Icon
        :icon="iconPanelLeft"
        width="16"
        height="16"
        class="text-text-secondary group-hover:text-primary transition-colors"
      />
    </button>

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
