<script setup lang="ts">
import { computed, useSlots } from 'vue';
import { Primitive, useForwardExpose } from 'reka-ui';
import { useElementTooltip } from './tooltip';
import type { TooltipMode } from './tooltipRuntime';

defineOptions({ inheritAttrs: false });

interface Props {
  content?: string;
  /** Information beyond the visible label; remains available when the label fits. */
  description?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  contentClass?: string;
  /** Auto handles ordinary callers; explicit modes serve hidden or aggregated labels. */
  mode?: TooltipMode;
  ignoreNonKeyboardFocus?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  description: '',
  mode: 'auto',
  side: 'top',
  align: 'center',
  sideOffset: 8,
  disabled: false,
  contentClass: '',
  ignoreNonKeyboardFocus: true,
});

const slots = useSlots();
const inactive = computed(
  () => props.disabled || (!(props.description || props.content)?.trim() && !slots.content),
);
const { forwardRef, currentElement } = useForwardExpose();
useElementTooltip(currentElement, () => ({
  ...props,
  content: props.description || props.content,
  mode: props.description ? 'always' : props.mode,
  renderContent: slots.content,
}));
</script>

<template>
  <Primitive :ref="forwardRef" as-child v-bind="$attrs">
    <slot :name="inactive && slots.fallback ? 'fallback' : 'default'" />
  </Primitive>
</template>
