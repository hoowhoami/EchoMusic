<script setup lang="ts">
import { ref } from 'vue';
import {
  SliderRoot as RekaSliderRoot,
  useForwardPropsEmits,
  useForwardExpose,
  type SliderRootProps,
  type SliderRootEmits,
} from 'reka-ui';

const props = defineProps<SliderRootProps>();
const emit = defineEmits<SliderRootEmits>();
const forwarded = useForwardPropsEmits(props, emit);
const { forwardRef } = useForwardExpose();
const pointerFocus = ref(false);
const handleFocusOut = (event: FocusEvent) => {
  const root = event.currentTarget as HTMLElement;
  if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) {
    pointerFocus.value = false;
  }
};
</script>

<template>
  <RekaSliderRoot
    :ref="forwardRef"
    v-slot="slotProps"
    v-bind="forwarded"
    :data-pointer-focus="pointerFocus ? 'true' : undefined"
    @pointerdown.capture="pointerFocus = true"
    @keydown.capture="pointerFocus = false"
    @focusout="handleFocusOut"
  >
    <slot v-bind="slotProps" />
  </RekaSliderRoot>
</template>
