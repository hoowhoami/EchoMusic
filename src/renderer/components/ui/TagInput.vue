<script setup lang="ts">
import { ref, useId } from 'vue';
import { iconX } from '@/icons';

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    disabled?: boolean;
    placeholder?: string;
    label?: string;
  }>(),
  { placeholder: '输入标签，按回车添加', label: '标签' },
);
const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:draft': [value: string];
}>();
const input = ref<HTMLInputElement>();
const draft = ref('');
const composing = ref(false);
const hintId = useId();
const delimiters = /[,，\r\n]+/;

function setDraft(value: string) {
  draft.value = value;
  emit('update:draft', value);
}

function commit() {
  if (props.disabled || composing.value) return;
  const additions = draft.value
    .split(delimiters)
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (additions.length)
    emit('update:modelValue', [...new Set([...props.modelValue, ...additions])]);
  setDraft('');
}

function onInput(event: Event) {
  setDraft((event.target as HTMLInputElement).value);
  if (!composing.value && delimiters.test(draft.value)) commit();
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text');
  if (props.disabled || composing.value || !text || !delimiters.test(text)) return;
  event.preventDefault();
  const target = event.target as HTMLInputElement;
  const start = target.selectionStart ?? draft.value.length;
  const end = target.selectionEnd ?? start;
  setDraft(draft.value.slice(0, start) + text + draft.value.slice(end));
  commit();
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled || composing.value || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
  } else if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    event.preventDefault();
    emit('update:modelValue', props.modelValue.slice(0, -1));
  }
}

function remove(index: number) {
  if (props.disabled) return;
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  );
  input.value?.focus();
}

defineExpose({ commit });
</script>

<template>
  <div class="tag-input-field">
    <div class="tag-input" :class="{ 'is-disabled': disabled }" @click.self="input?.focus()">
      <span v-for="(tag, index) in modelValue" :key="tag" class="tag-input-chip">
        <span class="tag-input-text">{{ tag }}</span>
        <button
          type="button"
          class="tag-input-remove"
          :disabled="disabled"
          :aria-label="`删除标签 ${tag}`"
          @click="remove(index)"
        >
          <Icon :icon="iconX" width="12" height="12" />
        </button>
      </span>
      <input
        ref="input"
        class="tag-input-control"
        :value="draft"
        :disabled="disabled"
        :placeholder="placeholder"
        :aria-label="label"
        :aria-describedby="hintId"
        autocomplete="off"
        @input="onInput"
        @paste="onPaste"
        @keydown="onKeydown"
        @blur="commit"
        @compositionstart="composing = true"
        @compositionend="
          composing = false;
          onInput($event);
        "
      />
    </div>
    <span :id="hintId" class="tag-input-hint">回车或逗号添加，可粘贴多个标签</span>
  </div>
</template>

<style scoped>
.tag-input-field {
  min-width: 0;
}
.tag-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-height: 36px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--control-muted-bg);
  color: var(--color-text-main);
  transition: border-color 0.15s;
  cursor: text;
}
.tag-input:focus-within {
  border-color: var(--color-primary);
}
.tag-input.is-disabled {
  opacity: 0.6;
  cursor: default;
}
.tag-input-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 8px;
  border-radius: 5px;
  background: var(--control-hover-bg);
  font-size: 12px;
  line-height: 20px;
}
.tag-input-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tag-input-remove {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.tag-input-remove:hover {
  background: var(--control-muted-bg);
  color: var(--color-text-main);
}
.tag-input-remove:focus-visible {
  outline: 2px solid var(--color-primary);
}
.tag-input input {
  flex: 1;
  width: 0;
  min-width: min(160px, 100%);
  height: 24px;
  padding: 0 4px;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.tag-input input::placeholder {
  color: var(--color-text-secondary);
  opacity: 0.65;
}
.tag-input-hint {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
}
</style>
