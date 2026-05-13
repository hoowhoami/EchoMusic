<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { YzsKeepAlive } from 'yzs-keep-alive-v3';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';

const route = useRoute();
const settingStore = useSettingStore();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));

// 不需要缓存的页面
const excludeFromCache = [
  'login-page',
  'loading-page',
  'error-page',
  'lyric-page',
  'comment-page',
  'mv-detail',
  'profile',
  'settings-page',
];

const keepAliveMax = computed(() =>
  settingStore.keepAliveEnabled ? Math.min(settingStore.keepAliveMax, 30) : 0,
);
</script>

<template>
  <div
    class="main-layout h-screen w-screen flex overflow-hidden bg-bg-main text-text-main transition-colors duration-300"
  >
    <Sidebar class="w-[220px] shrink-0" />

    <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar />
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
  </div>
</template>

<style scoped>
.main-layout {
  user-select: none;
}
</style>
