<script setup lang="ts">
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';

type CheckboxState = boolean | 'indeterminate';

const props = withDefaults(
  defineProps<{
    modelValue?: CheckboxState;
    disabled?: boolean;
    ariaLabel?: string;
  }>(),
  { modelValue: false, disabled: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: CheckboxState): void;
}>();
</script>

<template>
  <CheckboxRoot
    class="checkbox"
    :model-value="props.modelValue"
    :disabled="props.disabled"
    :aria-label="props.ariaLabel"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <CheckboxIndicator class="checkbox-indicator" />
  </CheckboxRoot>
</template>

<style scoped>
.checkbox {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 5px;
  border: 1.5px solid var(--control-checkbox-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--control-checkbox-bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--surface-card-base) 36%, transparent);
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.checkbox:not([data-disabled]):hover {
  border-color: var(--control-checkbox-border-hover);
  background: color-mix(in srgb, var(--color-primary) 8%, var(--control-checkbox-bg));
}

.checkbox:focus-visible {
  outline: 2px solid var(--control-checkbox-border-hover) !important;
  outline-offset: 2px;
  border-color: var(--control-checkbox-border-hover);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.checkbox[data-state='checked'],
.checkbox[data-state='indeterminate'] {
  border-color: var(--color-primary);
  background: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.checkbox-indicator {
  width: 8px;
  height: 8px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.checkbox[data-state='checked'] .checkbox-indicator::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 7px;
  border: 2px solid var(--control-checkbox-indicator);
  border-top: none;
  border-left: none;
  transform: translate(-50%, -55%) rotate(45deg);
}

.checkbox[data-state='indeterminate'] .checkbox-indicator::after {
  content: '';
  width: 8px;
  height: 2px;
  border: none;
  background: var(--control-checkbox-indicator);
  border-radius: 999px;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.checkbox[data-disabled] {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
