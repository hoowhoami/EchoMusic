<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconMinus } from '@/icons';
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
    <CheckboxIndicator class="checkbox-indicator">
      <Icon
        :icon="props.modelValue === 'indeterminate' ? iconMinus : iconCheckMark"
        :width="12"
        :height="12"
        aria-hidden="true"
      />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>

<style scoped>
.checkbox {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 4px;
  border: 1.5px solid var(--control-checkbox-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--control-checkbox-bg);
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.checkbox[data-state='unchecked']:not([data-disabled]):hover {
  border-color: var(--control-checkbox-border-hover);
  background: color-mix(in srgb, var(--color-primary) 8%, var(--control-checkbox-bg));
}

.checkbox:focus-visible {
  outline: 2px solid var(--control-checkbox-border-hover) !important;
  outline-offset: 2px;
  border-color: var(--control-checkbox-border-hover);
}

.checkbox[data-state='checked'],
.checkbox[data-state='indeterminate'] {
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.checkbox-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--control-checkbox-indicator);
}

.checkbox[data-disabled] {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
