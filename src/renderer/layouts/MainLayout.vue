<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import BackToTop from '@/components/ui/BackToTop.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';

const route = useRoute();
const settingStore = useSettingStore();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));

// 始终 keepAlive 的路由
const alwaysKeepAlive = ['personal-fm'];

// 根据设置动态计算 keepAlive 列表
const keepAliveRouteNames = computed(() => {
  if (!settingStore.keepAliveEnabled) return alwaysKeepAlive;
  return [...new Set([...alwaysKeepAlive, ...settingStore.keepAliveRoutes])];
});

const keepAliveMax = computed(() =>
  settingStore.keepAliveEnabled ? settingStore.keepAliveMax : alwaysKeepAlive.length,
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
        <Scrollbar
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
</style>
