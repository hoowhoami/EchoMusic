<script setup lang="ts">
import { computed } from 'vue';
import { iconMinus, iconSquare, iconX } from '@/icons';
import Button from '@/components/ui/Button.vue';

const isMac = computed(() => window.electron.platform === 'darwin');

const handleControl = (action: 'minimize' | 'maximize' | 'close') => {
  window.electron.windowControl(action);
};
</script>

<template>
  <header
    class="overlay-header fixed top-0 left-0 right-0 z-[2000] h-10 pointer-events-none select-none"
  >
    <!-- 1. macOS 顶部红绿灯占位 (40px) -->
    <div v-if="isMac" class="h-full w-full drag pointer-events-auto"></div>

    <!-- 2. Windows/Linux 窗口控制行 -->
    <template v-if="!isMac">
      <div class="absolute inset-y-0 left-0 right-[132px] drag pointer-events-auto"></div>
      <div class="window-controls absolute top-0 right-0 flex items-center h-full no-drag pointer-events-auto">
        <Button variant="unstyled" size="none" 
          @click="handleControl('minimize')" 
          class="w-11 h-full flex items-center justify-center text-text-main dark:text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-black/[0.05] dark:hover:bg-white/[0.1]" 
          title="最小化"
        >
          <Icon :icon="iconMinus" width="10" height="10" />
        </Button>
        <Button variant="unstyled" size="none" 
          @click="handleControl('maximize')" 
          class="w-11 h-full flex items-center justify-center text-text-main dark:text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-black/[0.05] dark:hover:bg-white/[0.1]" 
          title="最大化"
        >
          <Icon :icon="iconSquare" width="9" height="9" />
        </Button>
        <Button variant="unstyled" size="none" 
          @click="handleControl('close')" 
          class="w-11 h-full flex items-center justify-center text-text-main dark:text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-red-500 hover:text-white" 
          title="关闭"
        >
          <Icon :icon="iconX" width="10" height="10" />
        </Button>
      </div>
    </template>
  </header>
</template>

<style scoped>
/* Removed @apply to avoid Tailwind v4 compilation issues in SFC style blocks */
</style>
