<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import {
  iconFullscreen,
  iconPictureInPicture,
  iconMinus,
  iconSquare,
  iconCopy,
  iconX,
} from '@/icons';
import { Icon } from '@iconify/vue';
import { useSettingStore } from '@/stores/setting';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { WindowFrameState } from '../../shared/windowFrame';
withDefaults(defineProps<{ showMiniPlayer?: boolean }>(), { showMiniPlayer: false });
const settings = useSettingStore();
const openMiniPlayer = () => {
  void window.electron.miniPlayer.show();
};
const toggleFullscreen = () => window.electron.windowControl('fullscreen');
const isMac = window.electron.platform === 'darwin';
const maximized = ref(false);
const nativeFullscreen = ref(false);
const htmlFullscreen = ref(false);
const isFullscreen = computed(() => nativeFullscreen.value || htmlFullscreen.value);
let fullscreenReceived = false;
const onFullscreen = (value: unknown) => {
  if (disposed || typeof value !== 'boolean') return;
  fullscreenReceived = true;
  nativeFullscreen.value = value;
};
const onHtmlFullscreen = () => {
  htmlFullscreen.value = Boolean(document.fullscreenElement);
};
const control = (action: 'minimize' | 'maximize' | 'close') =>
  window.electron.windowControl(action);
let disposed = false;
let stateReceived = false;
const onFrameState = (state: unknown) => {
  if (
    disposed ||
    !state ||
    typeof state !== 'object' ||
    !('maximized' in state) ||
    typeof state.maximized !== 'boolean'
  )
    return;
  stateReceived = true;
  maximized.value = state.maximized;
  // The fullscreen controller publishes authoritative early events, including
  // Windows emulated fullscreen. A later frame snapshot must not undo them.
  if (!fullscreenReceived && 'fullscreen' in state && typeof state.fullscreen === 'boolean')
    nativeFullscreen.value = state.fullscreen;
};
onMounted(() => {
  if (isMac) return;
  const ipc = window.electron.ipcRenderer;
  ipc.on('window:frame-state-changed', onFrameState);
  ipc.on('window:fullscreen-changed', onFullscreen);
  onHtmlFullscreen();
  document.addEventListener('fullscreenchange', onHtmlFullscreen);
  void ipc
    .invoke('window:frame-state')
    .then((state: WindowFrameState | null) => {
      if (!stateReceived) onFrameState(state);
    })
    .catch(() => {});
});
onUnmounted(() => {
  disposed = true;
  if (!isMac) {
    window.electron.ipcRenderer.off('window:frame-state-changed', onFrameState);
    window.electron.ipcRenderer.off('window:fullscreen-changed', onFullscreen);
    document.removeEventListener('fullscreenchange', onHtmlFullscreen);
  }
});
</script>

<template>
  <div class="window-actions no-drag" :class="{ 'is-fullscreen': isFullscreen }">
    <Button
      v-if="showMiniPlayer"
      variant="unstyled"
      size="none"
      class="titlebar-icon-action window-action"
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
      class="titlebar-icon-action window-action"
      :tooltip="isFullscreen ? '退出全屏 (F11)' : '全屏 (F11)'"
      aria-label="切换全屏"
      @click="toggleFullscreen"
    >
      <Icon :icon="iconFullscreen" width="14" height="14" />
    </Button>
    <!-- Render no-drag controls after the titlebar's drag regions. -->
    <div
      v-if="!isMac && !isFullscreen"
      class="window-caption-controls no-drag"
      role="group"
      aria-label="窗口控制"
    >
      <Button
        variant="unstyled"
        size="none"
        class="titlebar-icon-action window-caption-button"
        tooltip="最小化"
        tooltip-side="bottom"
        aria-label="最小化窗口"
        @click="control('minimize')"
      >
        <Icon :icon="iconMinus" width="15" height="15" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        class="titlebar-icon-action window-caption-button"
        :tooltip="maximized ? '还原' : '最大化'"
        tooltip-side="bottom"
        :aria-label="maximized ? '还原窗口' : '最大化窗口'"
        @click="control('maximize')"
      >
        <Icon :icon="maximized ? iconCopy : iconSquare" width="14" height="14" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        class="titlebar-icon-action window-caption-button window-caption-close"
        tooltip="关闭"
        tooltip-side="bottom"
        aria-label="关闭窗口"
        @click="control('close')"
      >
        <Icon :icon="iconX" width="16" height="16" />
      </Button>
    </div>
  </div>
</template>

<style scoped>
.window-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  position: relative;
  z-index: 10;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
.window-action {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与标题栏其他按钮共用前景角色；播放页使用自身的窗口按钮颜色。 */
  background: transparent;
}
.window-caption-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}
.window-caption-button {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-control);
  background: transparent;
  -webkit-app-region: no-drag;
}
@container main-titlebar (max-width: 400px) {
  /* At extreme zoom, caption controls take priority over optional tools. */
  .window-actions:not(.is-fullscreen) .window-action {
    display: none;
  }
}
</style>
