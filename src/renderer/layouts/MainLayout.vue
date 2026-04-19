<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import Sidebar from './Sidebar.vue';
import TitleBar from './TitleBar.vue';
import PlayerBar from './PlayerBar.vue';
import BackToTop from '@/components/ui/BackToTop.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';

const route = useRoute();
const routeViewKey = computed(() => String(route.query._t ?? route.fullPath));
const keepAliveRouteNames = ['personal-fm'];

// 路由切换时重置滚动位置
watch(
  () => route.fullPath,
  () => {
    const viewport = document.querySelector('.view-port');
    if (viewport) viewport.scrollTop = 0;
  },
);
</script>

<template>
  <div
    class="main-layout h-screen w-screen flex overflow-hidden bg-bg-main text-text-main transition-colors duration-300"
  >
    <!-- 1. 左侧侧边栏 (固定宽度) -->
    <Sidebar class="w-[220px] shrink-0" />

    <!-- 2. 右侧容器 (内容 + 播放器) -->
    <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <!-- 2.1 主体内容区域 -->
      <main class="main-content flex-1 flex flex-col min-h-0 overflow-hidden">
        <TitleBar />
        <!-- 滚动容器 -->
        <Scrollbar
          class="view-port-scroll flex-1 min-h-0 min-w-0"
          :content-props="{ class: 'view-port' }"
        >
          <div>
            <router-view v-slot="{ Component }">
              <KeepAlive :include="keepAliveRouteNames">
                <component :is="Component" :key="routeViewKey" />
              </KeepAlive>
            </router-view>
          </div>
        </Scrollbar>
      </main>

      <!-- 2.2 底部悬浮播放控制栏 (相对于右侧容器居中) -->
      <PlayerBar />

      <!-- 2.3 返回顶部 -->
      <BackToTop target-selector=".view-port" />
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  /* 确保整体容器占满屏幕且不溢出 */
  user-select: none;
}
</style>
