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
        :width="14"
        :height="14"
        aria-hidden="true"
      />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>

<style scoped>
.checkbox {
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  padding: 0;
  flex-shrink: 0;
  border-radius: var(--radius-detail);
  border: 1px solid var(--control-checkbox-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--control-checkbox-bg);
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}

.checkbox[data-state='unchecked']:not([data-disabled]):hover {
  border-color: var(--control-checkbox-border-hover);
  background: var(--control-hover-bg);
}

.checkbox:focus-visible:not([data-disabled]) {
  outline: 1px solid var(--control-checkbox-active-border) !important;
  outline-offset: 2px;
}

.checkbox[data-state='checked'],
.checkbox[data-state='indeterminate'] {
  border-color: var(--control-checkbox-active-border);
  background: var(--control-active-bg);
}

.checkbox:is([data-state='checked'], [data-state='indeterminate']):not([data-disabled]):hover {
  background: var(--control-accent-hover-bg);
}

.checkbox[data-state='unchecked']:not([data-disabled]):active {
  background: var(--control-neutral-pressed-bg);
}

.checkbox:is([data-state='checked'], [data-state='indeterminate']):not([data-disabled]):active {
  background: var(--control-accent-pressed-bg);
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

@media (prefers-reduced-motion: reduce) {
  .checkbox {
    transition: none;
  }
}
</style>
