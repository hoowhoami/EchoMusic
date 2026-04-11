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
    class="overlay-header fixed top-0 left-0 right-0 z-[9999] h-10 select-none"
    style="pointer-events: none; -webkit-app-region: drag"
  >
    <!-- 1. macOS 顶部红绿灯占位 (40px) -->
    <div
      v-if="isMac"
      class="h-full w-full"
      style="pointer-events: auto; -webkit-app-region: drag"
    ></div>

    <!-- 2. Windows/Linux 窗口控制行 -->
    <template v-if="!isMac">
      <div
        class="absolute inset-y-0 left-0 right-[132px]"
        style="pointer-events: auto; -webkit-app-region: drag"
      ></div>
      <div
        class="window-controls absolute top-0 right-0 flex items-center h-full"
        style="pointer-events: auto; -webkit-app-region: no-drag"
      >
        <Button
          variant="unstyled"
          size="none"
          @click="handleControl('minimize')"
          class="w-[46px] h-full flex items-center justify-center text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-white/10"
          title="最小化"
        >
          <Icon :icon="iconMinus" width="14" height="14" />
        </Button>
        <Button
          variant="unstyled"
          size="none"
          @click="handleControl('maximize')"
          class="w-[46px] h-full flex items-center justify-center text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-white/10"
          title="最大化"
        >
          <Icon :icon="iconSquare" width="13" height="13" />
        </Button>
        <Button
          variant="unstyled"
          size="none"
          @click="handleControl('close')"
          class="w-[46px] h-full flex items-center justify-center text-white opacity-60 hover:opacity-100 transition-all duration-200 bg-transparent hover:bg-[#ff3b30] hover:text-white"
          title="关闭"
        >
          <Icon :icon="iconX" width="14" height="14" />
        </Button>
      </div>
    </template>
  </header>
</template>

<style scoped>
/* Removed @apply to avoid Tailwind v4 compilation issues in SFC style blocks */
</style>
