<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import type { StyleValue } from 'vue';
import { useVModel } from '@vueuse/core';

interface Props {
  open?: boolean;
  side?: 'right' | 'bottom';
  overlayClass?: string;
  panelClass?: string;
  overlayStyle?: StyleValue;
  panelStyle?: StyleValue;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  side: 'right',
  overlayClass: '',
  panelClass: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });

const overlayClass = computed(() => ['drawer-overlay', props.overlayClass]);
const panelClass = computed(() => ['drawer-panel', `drawer-${props.side}`, props.panelClass]);

const close = () => {
  open.value = false;
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation();
    close();
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      :class="overlayClass"
      :data-state="open ? 'open' : 'closed'"
      :style="overlayStyle"
      @click="close"
    />
    <div
      :class="panelClass"
      :data-state="open ? 'open' : 'closed'"
      :style="panelStyle"
      role="dialog"
      :aria-hidden="!open"
      :inert="!open || undefined"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
@reference "@/style.css";

:global(.drawer-overlay) {
  position: fixed;
  inset: 0;
  background: var(--surface-scrim-bg);
  /* Drawer 属于非模态辅助层；模态 Dialog（从 1600 起）始终保持在其上方。 */
  z-index: 1400;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.2s ease,
    visibility 0s linear 0.2s;
}

:global(.drawer-overlay[data-state='open']) {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

:global(.drawer-panel) {
  /*
   * 抽屉的安全区：
   * - 上方避开标题栏 / 窗口控制按钮（高度与 TitleBar / OverlayHeader 保持一致）；
   * - 下方避开播放器（--drawer-bottom-offset 由 PlayerBar 按实际高度发布，已含 8px 余量）。
   * 上下边距刻意不对称：整体略向下沉，让面板离标题栏更远一些。
   * 各具体抽屉的 top / bottom 请统一引用这两个变量，不要再写死 12px。
   */
  --drawer-top-gap: 28px;
  --drawer-bottom-gap: 0px;
  --drawer-titlebar-height: max(46px, calc(35px / var(--window-zoom-factor, 1)));
  --drawer-safe-top: calc(var(--drawer-titlebar-height) + var(--drawer-top-gap));
  --drawer-safe-bottom: calc(var(--drawer-bottom-offset, 96px) + var(--drawer-bottom-gap));
  position: fixed;
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-dialog);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: 1410;
  transition:
    opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 0.22s;
  display: flex;
  flex-direction: column;
}

:global(.drawer-panel[data-state='open']) {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
  pointer-events: auto;
  transform: translate(0, 0);
  -webkit-app-region: no-drag;
}

:global(.drawer-right) {
  top: var(--drawer-safe-top);
  right: 0;
  bottom: var(--drawer-safe-bottom);
  width: min(380px, 88vw);
  border-radius: 10px 0 0 10px;
  transform: translateX(24px);
  box-shadow: none;
}

:global(.drawer-bottom) {
  left: var(--drawer-content-left, 0px);
  top: max(var(--drawer-content-top, 0px), var(--drawer-safe-top));
  bottom: var(--drawer-safe-bottom);
  transform: translateY(8%);
  width: var(--drawer-content-width, 92vw);
  border-radius: 24px;
}

:global(.drawer-bottom[data-state='open']) {
  transform: translateY(0);
}
</style>
