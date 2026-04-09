<script setup lang="ts">
import { computed } from 'vue';
import type { StyleValue } from 'vue';
import { useVModel } from '@vueuse/core';
import {
  DialogRoot,
  DialogOverlay,
  DialogContent,
  DialogPortal,
  DialogTitle,
  DialogDescription,
  VisuallyHidden,
} from 'reka-ui';

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
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay as-child>
        <div :class="overlayClass" :style="overlayStyle" />
      </DialogOverlay>

      <DialogContent as-child>
        <div :class="panelClass" :style="panelStyle">
          <VisuallyHidden>
            <DialogTitle>侧边栏</DialogTitle>
            <DialogDescription>侧边栏内容</DialogDescription>
          </VisuallyHidden>
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
@reference "@/style.css";

:global(.drawer-overlay) {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(1px);
  z-index: 1400;
  opacity: 0;
  transition: opacity 0.2s ease;
}

:global(.drawer-overlay[data-state='open']) {
  opacity: 1;
}

:global(.drawer-panel) {
  position: fixed;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-light);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
  opacity: 0;
  z-index: 1410;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  display: flex;
  flex-direction: column;
}

:global(.drawer-panel[data-state='open']) {
  opacity: 1;
  transform: translate(0, 0);
}

:global(.drawer-right) {
  top: 0;
  right: 0;
  bottom: var(--drawer-bottom-offset, 96px);
  width: min(380px, 88vw);
  border-radius: 18px 0 0 18px;
  transform: translateX(12px);
  box-shadow: none;
}

:global(.drawer-bottom) {
  left: var(--drawer-content-left, 0px);
  top: var(--drawer-content-top, 0px);
  bottom: var(--drawer-bottom-offset, 96px);
  transform: translateY(8%);
  width: var(--drawer-content-width, 92vw);
  border-radius: 24px;
}

:global(.drawer-bottom[data-state='open']) {
  transform: translateY(0);
}
</style>
