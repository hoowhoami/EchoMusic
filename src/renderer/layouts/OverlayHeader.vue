<script setup lang="ts">
import WindowControls from './WindowControls.vue';
import { computed, ref } from 'vue';

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
</script>

<template>
  <header ref="headerRef" class="native-titlebar overlay-header">
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

    <WindowControls
      class="overlay-header-controls"
      :show-mini-player="props.showMiniPlayerControl"
    />
  </header>
</template>

<style scoped>
.overlay-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: max(46px, calc(35px / var(--window-zoom-factor, 1)));
  z-index: 50;
  user-select: none;
  cursor: default;
}

.overlay-header .overlay-header-controls {
  position: absolute;
  top: 0;
  right: var(--window-controls-inset, 0px);
  height: 100%;
  display: flex;
  align-items: center;
}

.overlay-header-left {
  position: absolute;
  top: 0;
  left: calc(16px + var(--window-controls-left-inset, 0px));
  height: 100%;
  display: flex;
  align-items: center;
  padding-bottom: 4px;
}

.overlay-header-left.mac-offset {
  left: max(16px, var(--window-controls-left-inset, 0px));
}
</style>
