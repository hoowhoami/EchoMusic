<script setup lang="ts">
import { computed, ref } from 'vue';
import { iconMinus, iconSquare, iconX, iconFullscreen } from '@/icons';
import Button from '@/components/ui/Button.vue';

const isMac = computed(() => window.electron.platform === 'darwin');
const headerRef = ref<HTMLElement | null>(null);

const handleControl = (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
  window.electron.windowControl(action);
};
</script>

<template>
  <header ref="headerRef" class="overlay-header">
    <!-- 拖动层 -->
    <div class="drag-region"></div>

    <div v-if="!isMac" class="overlay-header-controls no-drag relative z-10">
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('minimize')"
        class="overlay-control-btn"
        title="最小化"
      >
        <Icon :icon="iconMinus" width="14" height="14" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('fullscreen')"
        class="overlay-control-btn"
        title="全屏"
      >
        <Icon :icon="iconFullscreen" width="14" height="14" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('maximize')"
        class="overlay-control-btn"
        title="最大化"
      >
        <Icon :icon="iconSquare" width="13" height="13" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('close')"
        class="overlay-control-btn overlay-control-btn--close"
        title="关闭"
      >
        <Icon :icon="iconX" width="14" height="14" />
      </Button>
    </div>
  </header>
</template>

<style scoped>
.overlay-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
  z-index: 50;
  user-select: none;
  cursor: default;
}

.overlay-header-controls {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  display: flex;
  align-items: center;
}

.overlay-control-btn {
  width: 48px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  opacity: 0.6;
  transition: all 0.2s;
  background: transparent;
}

:global(.dark) .overlay-control-btn {
  color: white;
}

.overlay-control-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.05);
}

:global(.dark) .overlay-control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.overlay-control-btn--close:hover {
  background: #ff3b30;
  color: white;
  opacity: 1;
}
</style>
