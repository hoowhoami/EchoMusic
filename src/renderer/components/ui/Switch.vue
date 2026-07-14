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
  @apply relative inline-flex h-6 w-11 items-center rounded-full transition-colors outline-none;
  @apply data-disabled:opacity-60 data-disabled:cursor-not-allowed;
  @apply focus-visible:outline-none;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 26%, var(--control-border));
  background: color-mix(in srgb, var(--color-text-main) 14%, var(--control-muted-bg));
}

.switch-root[data-state='checked'] {
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.switch-root:not([data-state='checked']):not([data-disabled]):hover {
  border-color: color-mix(in srgb, var(--color-text-main) 36%, var(--control-border));
  background: color-mix(in srgb, var(--color-text-main) 20%, var(--control-muted-bg));
}

.switch-root:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 22%, transparent);
}

.switch-thumb {
  @apply block h-4 w-4 rounded-full bg-white shadow-sm transition-transform;
  @apply data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-1;
}
</style>
