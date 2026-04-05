<script setup lang="ts">
import { useVModel } from '@vueuse/core';
import { SwitchRoot, SwitchThumb } from 'reka-ui';

interface Props {
  modelValue?: boolean;
  disabled?: boolean;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  disabled: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const value = useVModel(props, 'modelValue', emit);

const handleUpdate = (next: unknown) => {
  value.value = Boolean(next);
};
</script>

<template>
  <SwitchRoot
    :model-value="value"
    :disabled="props.disabled"
    :class="['switch-root', props.class]"
    @update:model-value="handleUpdate"
  >
    <SwitchThumb class="switch-thumb" />
  </SwitchRoot>
</template>

<style scoped>
@reference "@/style.css";

.switch-root {
  @apply relative inline-flex h-6 w-11 items-center rounded-full border border-border-light/60 transition-colors outline-none;
  @apply data-[state=checked]:bg-primary data-[state=unchecked]:bg-text-secondary/10;
  @apply data-[disabled]:opacity-60 data-[disabled]:cursor-not-allowed;
  @apply focus-visible:outline-none;
}

.switch-root:focus-visible {
  box-shadow: none;
}

.switch-thumb {
  @apply block h-4 w-4 rounded-full bg-white shadow-sm transition-transform;
  @apply data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-1;
}
</style>
