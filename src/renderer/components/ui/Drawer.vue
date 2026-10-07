<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { StyleValue } from 'vue';
import { useVModel } from '@vueuse/core';
import { useCachedOverlayOpen } from '@/composables/useCachedOverlayOpen';
import { isTopmostDrawer } from './overlayEscape';

interface Props {
  open?: boolean;
  title?: string;
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

const open = useCachedOverlayOpen(useVModel(props, 'open', emit, { defaultValue: false }));

const panelRef = ref<HTMLElement | null>(null);

const overlayClass = computed(() => ['drawer-overlay', props.overlayClass]);
const panelClass = computed(() => ['drawer-panel', `drawer-${props.side}`, props.panelClass]);

const close = () => {
  open.value = false;
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !e.defaultPrevented && open.value && isTopmostDrawer(panelRef.value)) {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
};

let mounted = false;
let listening = false;
const syncKeydownListener = () => {
  const shouldListen = mounted && open.value;
  if (shouldListen === listening) return;
  listening = shouldListen;
  if (shouldListen) window.addEventListener('keydown', handleKeydown);
  else window.removeEventListener('keydown', handleKeydown);
};
watch(open, syncKeydownListener, { flush: 'sync' });
onMounted(() => {
  mounted = true;
  syncKeydownListener();
});
onUnmounted(() => {
  mounted = false;
  syncKeydownListener();
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
      ref="panelRef"
      :class="panelClass"
      :data-state="open ? 'open' : 'closed'"
      :style="panelStyle"
      role="dialog"
      :aria-label="title"
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
    opacity var(--motion-duration-exit) var(--motion-ease-exit),
    visibility 0s linear var(--motion-duration-exit);
}

:global(.drawer-overlay[data-state='open']) {
  opacity: 1;
  visibility: visible;
  transition-duration: var(--motion-duration-normal), 0s;
  transition-timing-function: var(--motion-ease-enter), linear;
  transition-delay: 0s;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

:global(.drawer-panel) {
  /*
   * 抽屉的安全区：
   * - 上方避开标题栏 / 窗口控制按钮（高度与 TitleBar / OverlayHeader 保持一致）；
   * - 下方避开播放器（--drawer-bottom-offset 由 PlayerBar 按实际高度发布，已含 8px 余量）。
   * 上下边距配对调整：保留面板高度，同时与底部播放器拉开间距。
   * 各具体抽屉的 top / bottom 请统一引用这两个变量，不要再写死 12px。
   */
  --drawer-top-gap: 16px;
  --drawer-bottom-gap: 12px;
  --drawer-titlebar-height: max(46px, calc(35px / var(--window-zoom-factor, 1)));
  --drawer-safe-top: calc(var(--drawer-titlebar-height) + var(--drawer-top-gap));
  --drawer-safe-bottom: calc(var(--drawer-bottom-offset, 96px) + var(--drawer-bottom-gap));
  position: fixed;
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  border: 1px solid var(--surface-outline);
  box-shadow: var(--shadow-dialog);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: 1410;
  transition:
    opacity var(--motion-duration-exit) var(--motion-ease-exit),
    transform var(--motion-duration-exit) var(--motion-ease-exit),
    visibility 0s linear var(--motion-duration-exit);
  display: flex;
  flex-direction: column;
}

:global(.drawer-panel[data-state='open']) {
  transition-duration: var(--motion-duration-panel), var(--motion-duration-panel), 0s;
  transition-timing-function: var(--motion-ease-enter), var(--motion-ease-enter), linear;
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
  border-radius: var(--radius-popover) 0 0 var(--radius-popover);
  transform: translateX(16px);
  box-shadow: none;
}

:global(.drawer-bottom) {
  left: var(--drawer-content-left, 0px);
  top: max(var(--drawer-content-top, 0px), var(--drawer-safe-top));
  bottom: var(--drawer-safe-bottom);
  transform: translateY(16px);
  width: var(--drawer-content-width, 92vw);
  border-radius: var(--radius-dialog);
}

:global(.drawer-bottom[data-state='open']) {
  transform: translateY(0);
}
@media (prefers-reduced-motion: reduce) {
  :global(.drawer-overlay),
  :global(.drawer-panel) {
    transition: none;
  }
}
</style>
