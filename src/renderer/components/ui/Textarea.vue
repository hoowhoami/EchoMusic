<script setup lang="ts">
import { useVModel } from '@vueuse/core';

interface Props {
  modelValue?: string | number;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  spellcheck?: boolean | 'true' | 'false';
  class?: string;
  textareaClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  rows: 5,
  disabled: false,
  spellcheck: false,
});

const emits = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const value = useVModel(props, 'modelValue', emits);
</script>

<template>
  <textarea
    v-model="value"
    :placeholder="props.placeholder"
    :rows="props.rows"
    :disabled="props.disabled"
    :spellcheck="props.spellcheck"
    :class="['textarea-root', props.class, props.textareaClass]"
  />
</template>

<style scoped>
@reference "@/style.css";

.textarea-root {
  width: 100%;
  min-height: 120px;
  padding: 10px var(--field-padding-x);
  border: 1px solid var(--control-border);
  border-radius: var(--radius-control);
  background: var(--field-bg);
  color: var(--color-text-main);
  font-size: var(--field-font-size);
  font-weight: var(--field-font-weight);
  line-height: 1.55;
  outline: none;
  resize: vertical;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.textarea-root::placeholder {
  color: var(--color-text-secondary);
}

.textarea-root:focus {
  background: var(--field-focus-bg);
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--control-border));
}

.textarea-root:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.textarea-root:hover:not(:disabled):not(:focus) {
  background: var(--field-hover-bg);
}
</style>
