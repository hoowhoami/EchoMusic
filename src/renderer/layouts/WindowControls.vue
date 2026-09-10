<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import { iconFullscreen, iconPictureInPicture } from '@/icons';
import { useSettingStore } from '@/stores/setting';
withDefaults(defineProps<{ showMiniPlayer?: boolean }>(), { showMiniPlayer: false });
const settings = useSettingStore();
const openMiniPlayer = () => {
  void window.electron.miniPlayer.show();
};
const toggleFullscreen = () => window.electron.windowControl('fullscreen');
const isMac = window.electron.platform === 'darwin';
</script>

<template>
  <div class="window-actions no-drag">
    <Button
      v-if="showMiniPlayer"
      variant="unstyled"
      size="none"
      class="window-action"
      tooltip="mini 模式"
      aria-label="打开 mini 播放器"
      @click="openMiniPlayer"
    >
      <Icon :icon="iconPictureInPicture" width="16" height="16" />
    </Button>
    <Button
      v-if="!isMac && settings.showFullscreenButton"
      variant="unstyled"
      size="none"
      class="window-action"
      tooltip="全屏 (F11)"
      aria-label="切换全屏"
      @click="toggleFullscreen"
    >
      <Icon :icon="iconFullscreen" width="14" height="14" />
    </Button>
  </div>
</template>

<style scoped>
.window-actions {
  display: flex;
  align-items: center;
  height: 100%;
  position: relative;
  z-index: 10;
}
.window-action {
  width: 40px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--window-action-color, var(--color-text-main));
  background: transparent;
  transition: color 0.2s;
}
.window-action:hover {
  color: var(--window-action-hover-color, var(--color-text-main));
}
</style>
