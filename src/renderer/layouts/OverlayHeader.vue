<script setup lang="ts">
import { computed, ref } from 'vue';
import { iconMinus, iconSquare, iconX, iconFullscreen, iconPictureInPicture } from '@/icons';
import Button from '@/components/ui/Button.vue';
import { useSettingStore } from '@/stores/setting';

const props = withDefaults(
  defineProps<{
    showMiniPlayerControl?: boolean;
  }>(),
  {
    showMiniPlayerControl: false,
  },
);
const isMac = computed(() => window.electron.platform === 'darwin');
const headerRef = ref<HTMLElement | null>(null);
const settingStore = useSettingStore();

const handleControl = (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
  window.electron.windowControl(action);
};

const openMiniPlayer = () => {
  void window.electron?.miniPlayer?.show();
};
</script>

<template>
  <header ref="headerRef" class="overlay-header">
    <!-- 拖动层 -->
    <div class="drag-region"></div>

    <!-- 左侧插槽（macOS 避开红绿灯） -->
    <div
      v-if="$slots.left"
      class="overlay-header-left no-drag relative z-10"
      :class="{ 'mac-offset': isMac }"
    >
      <slot name="left" />
    </div>

    <div
      v-if="props.showMiniPlayerControl || !isMac"
      class="overlay-header-controls no-drag relative z-10"
    >
      <Button
        v-if="props.showMiniPlayerControl"
        variant="unstyled"
        size="none"
        @click="openMiniPlayer"
        class="overlay-control-btn overlay-control-btn--mini"
        title="mini 模式"
      >
        <Icon :icon="iconPictureInPicture" width="16" height="16" />
      </Button>
      <Button
        v-if="!isMac"
        variant="unstyled"
        size="none"
        @click="handleControl('minimize')"
        class="overlay-control-btn"
        title="最小化"
      >
        <Icon :icon="iconMinus" width="14" height="14" />
      </Button>
      <Button
        v-if="!isMac && settingStore.showFullscreenButton"
        variant="unstyled"
        size="none"
        @click="handleControl('fullscreen')"
        class="overlay-control-btn"
        title="全屏"
      >
        <Icon :icon="iconFullscreen" width="14" height="14" />
      </Button>
      <Button
        v-if="!isMac"
        variant="unstyled"
        size="none"
        @click="handleControl('maximize')"
        class="overlay-control-btn"
        title="最大化"
      >
        <Icon :icon="iconSquare" width="13" height="13" />
      </Button>
      <Button
        v-if="!isMac"
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

.overlay-header-left {
  position: absolute;
  top: 0;
  left: 16px;
  height: 100%;
  display: flex;
  align-items: center;
  padding-bottom: 4px;
}

.overlay-header-left.mac-offset {
  left: 70px;
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
  background: var(--control-hover-bg);
}

.overlay-control-btn--close:hover {
  background: #ff3b30;
  color: white;
  opacity: 1;
}

.overlay-control-btn--mini {
  width: 40px;
}

.overlay-control-btn--mini:hover,
:global(.dark) .overlay-control-btn--mini:hover {
  background: transparent;
  color: var(--color-primary);
  opacity: 1;
}
</style>
