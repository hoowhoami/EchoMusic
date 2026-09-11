<script setup lang="ts">
import { computed, useId } from 'vue';
import { strengthLabel } from '../../../shared/listeningPreferences';

const props = defineProps<{ label: string; modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const id = useId();
const valueText = computed(() => `${strengthLabel(props.modelValue)}，${props.modelValue}`);
</script>

<template>
  <div
    class="preference-strength"
    :class="{ 'is-disabled': disabled, 'is-blocked': modelValue === 0 }"
  >
    <span
      class="preference-strength-fill"
      :style="{ width: `${modelValue}%` }"
      aria-hidden="true"
    />
    <label :for="id" class="preference-strength-name">{{ label }}</label>
    <span class="preference-strength-value" aria-hidden="true"
      >{{ strengthLabel(modelValue)
      }}<small v-if="modelValue !== 50"> · {{ modelValue }}</small></span
    >
    <input
      :id="id"
      type="range"
      min="0"
      max="100"
      step="1"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="`${label}推荐强度`"
      :aria-valuetext="valueText"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
  </div>
</template>

<style scoped>
.preference-strength {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  height: 48px;
  border-radius: 14px;
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
  isolation: isolate;
}
.preference-strength-fill {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: -1;
  border-radius: 13px;
  background: rgba(var(--color-primary-rgb), 0.2);
  pointer-events: none;
}
.preference-strength-name {
  padding-left: 14px;
  font-size: 13px;
  font-weight: 800;
  white-space: nowrap;
  pointer-events: none;
}
.preference-strength-value {
  padding-right: 14px;
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  pointer-events: none;
}
.preference-strength-value small {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.preference-strength input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: ew-resize;
}
.preference-strength:hover {
  border-color: rgba(var(--color-primary-rgb), 0.45);
}
.preference-strength:focus-within {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}
.preference-strength.is-blocked .preference-strength-value {
  color: var(--color-text-main);
}
.preference-strength.is-disabled {
  opacity: 0.5;
}
.preference-strength input:disabled {
  cursor: not-allowed;
}
</style>
