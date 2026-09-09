<script setup lang="ts">
import { computed, ref, useSlots, watch } from 'vue';
import TooltipScope from './TooltipScope.vue';
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
const updateOpen = (value: boolean) => {
  const trigger = currentElement.value as HTMLElement | undefined;
  if (value && inactive.value) value = false;
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
</script>

<template>
  <Primitive v-if="inactive" :ref="forwardRef" as-child v-bind="$attrs">
    <slot :name="slots.fallback ? 'fallback' : 'trigger'" />
  </Primitive>
  <TooltipScope v-else>
    <TooltipRoot
      :open="open"
      :delay-duration="props.delayDuration"
      :ignore-non-keyboard-focus="props.ignoreNonKeyboardFocus"
      @update:open="updateOpen"
    >
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
          <slot>
            {{ props.content }}
          </slot>
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
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-line;
  z-index: 10030;
  user-select: none;
}

:global(.app-tooltip-arrow) {
  display: block;
  fill: var(--color-bg-elevated);
  stroke: none;
}
</style>
