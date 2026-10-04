<script setup lang="ts">
import { computed, ref, useSlots, watch, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import TooltipScope from './TooltipScope.vue';
import TooltipLifecycle from './TooltipLifecycle.vue';
import {
  Primitive,
  useForwardExpose,
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui';

defineOptions({ inheritAttrs: false });

interface Props {
  content?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  contentClass?: string;
  overflowOnly?: boolean;
  ignoreNonKeyboardFocus?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  side: 'top',
  align: 'center',
  sideOffset: 8,
  disabled: false,
  contentClass: '',
  ignoreNonKeyboardFocus: true,
});

const slots = useSlots();
const inactive = computed(() => props.disabled || (!props.content?.trim() && !slots.default));
const { forwardRef, currentElement } = useForwardExpose();
const open = ref(false);
const suspended = ref(false);
let disposed = false;
const updateOpen = (value: boolean) => {
  const trigger = currentElement.value as HTMLElement | undefined;
  if (value && (inactive.value || suspended.value || disposed)) value = false;
  // The open control panel already describes its trigger (speed, quality, select, etc.).
  if (value && trigger?.closest('.echo-popover-trigger[data-state="open"]')) value = false;
  if (value && props.overflowOnly) {
    const labels = trigger?.querySelectorAll<HTMLElement>('[data-tooltip-label]');
    const candidates = labels?.length ? Array.from(labels) : trigger ? [trigger] : [];
    value = candidates.some(
      (label) => label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight,
    );
  }
  open.value = value;
};
watch(
  () => [props.content, inactive.value],
  () => {
    open.value = false;
  },
);
onDeactivated(() => {
  suspended.value = true;
  open.value = false;
});
onActivated(() => {
  if (!disposed) suspended.value = false;
});
onBeforeUnmount(() => {
  disposed = true;
  open.value = false;
});
</script>

<template>
  <Primitive v-if="inactive" :ref="forwardRef" as-child v-bind="$attrs">
    <slot :name="slots.fallback ? 'fallback' : 'trigger'" />
  </Primitive>
  <TooltipScope v-else>
    <TooltipRoot
      :open="open"
      :disabled="suspended || undefined"
      :delay-duration="props.delayDuration"
      :ignore-non-keyboard-focus="props.ignoreNonKeyboardFocus"
      @update:open="updateOpen"
    >
      <TooltipLifecycle />
      <TooltipTrigger :ref="forwardRef" as-child v-bind="$attrs">
        <slot name="trigger" />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="props.side"
          :align="props.align"
          :side-offset="props.sideOffset"
          :collision-padding="8"
          hide-when-detached
          :class="['app-tooltip-surface', 'app-tooltip-content', props.contentClass]"
        >
          <div class="app-tooltip-body">
            <slot>
              {{ props.content }}
            </slot>
          </div>
          <TooltipArrow :width="14" :height="8" class="app-tooltip-arrow" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipScope>
</template>

<style scoped>
@reference "@/style.css";

:global(.app-tooltip-content) {
  max-width: min(320px, calc(100vw - 16px));
  max-height: var(--reka-tooltip-content-available-height);
  overflow: visible;
  overflow-wrap: anywhere;
  white-space: pre-line;
  z-index: 10030;
  user-select: none;
}

:global(.app-tooltip-body) {
  max-height: max(0px, calc(var(--reka-tooltip-content-available-height, 100vh) - 12px));
  overflow: hidden;
}

:global(.app-tooltip-arrow) {
  display: block;
  fill: var(--floating-surface-bg);
  stroke: none;
}
@media (prefers-reduced-motion: no-preference) {
  :global(.app-tooltip-content[data-state='delayed-open']),
  :global(.app-tooltip-content[data-state='instant-open']) {
    animation: motion-fade-in var(--motion-duration-fast) var(--motion-ease-enter);
  }
  :global(.app-tooltip-content[data-state='closed']) {
    pointer-events: none;
    animation: motion-fade-out var(--motion-duration-fast) var(--motion-ease-exit);
  }
}
</style>
