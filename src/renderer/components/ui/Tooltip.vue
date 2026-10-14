<script setup lang="ts">
import { computed, useSlots } from 'vue';
import { Primitive, useForwardExpose } from 'reka-ui';
import { useElementTooltip } from './tooltip';

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
useElementTooltip(currentElement, () => ({
  ...props,
  renderContent: slots.default,
}));
</script>

<template>
  <Primitive :ref="forwardRef" as-child v-bind="$attrs">
    <slot :name="inactive && slots.fallback ? 'fallback' : 'trigger'" />
  </Primitive>
</template>
