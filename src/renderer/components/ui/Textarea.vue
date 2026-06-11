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
  padding: 12px 14px;
  border: 1px solid var(--control-border);
  border-radius: 12px;
  background: var(--control-muted-bg);
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.55;
  outline: none;
  resize: vertical;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.textarea-root::placeholder {
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}

.textarea-root:focus {
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--control-border));
}

.textarea-root:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
