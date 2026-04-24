<script setup lang="ts">
import { computed, ref } from 'vue';
import Popover from './Popover.vue';
import { iconChevronDown, iconCheck } from '@/icons';

interface MultiSelectOption {
  label: string;
  value: string;
}

interface Props {
  modelValue: string[];
  options: MultiSelectOption[];
  placeholder?: string;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '请选择',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void;
}>();

const open = ref(false);

const displayText = computed(() => {
  if (props.modelValue.length === 0) return props.placeholder;
  const first = props.options.find((o) => o.value === props.modelValue[0]);
  if (!first) return props.placeholder;
  if (props.modelValue.length === 1) return first.label;
  return `${first.label} +${props.modelValue.length - 1}`;
});

const isPlaceholder = computed(() => props.modelValue.length === 0);

const toggle = (value: string) => {
  const next = props.modelValue.includes(value)
    ? props.modelValue.filter((v) => v !== value)
    : [...props.modelValue, value];
  emit('update:modelValue', next);
};

const isChecked = (value: string) => props.modelValue.includes(value);
</script>

<template>
  <Popover
    v-model:open="open"
    trigger="click"
    side="bottom"
    align="end"
    :side-offset="6"
    :show-arrow="false"
    content-class="ms-content"
  >
    <template #trigger>
      <button
        type="button"
        class="ms-trigger"
        :data-state="open ? 'open' : 'closed'"
        :data-placeholder="isPlaceholder ? '' : undefined"
      >
        <span class="ms-value" :class="{ 'is-placeholder': isPlaceholder }">
          {{ displayText }}
        </span>
        <span class="ms-icon" :class="{ 'is-open': open }">
          <Icon :icon="iconChevronDown" width="14" height="14" />
        </span>
      </button>
    </template>

    <div class="ms-viewport">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="ms-item"
        :data-checked="isChecked(option.value) ? '' : undefined"
        @click="toggle(option.value)"
      >
        <span class="ms-item-text">{{ option.label }}</span>
        <span v-if="isChecked(option.value)" class="ms-item-indicator">
          <Icon :icon="iconCheck" width="15" height="15" />
        </span>
      </button>
    </div>
  </Popover>
</template>

<style scoped>
@reference "@/style.css";

.ms-trigger {
  @apply inline-flex w-auto min-w-[140px] h-9 px-3 rounded-xl border border-border-light bg-black/6 dark:bg-white/6 text-text-main text-[13px] font-semibold items-center justify-between gap-2 transition-all cursor-pointer;
}

.ms-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10;
}

.ms-trigger:hover {
  @apply border-primary/30 bg-black/8 dark:bg-white/8;
}

.ms-value {
  @apply truncate text-text-main/80;
}

.ms-value.is-placeholder {
  @apply text-text-secondary/70;
}

.ms-icon {
  @apply transition-transform duration-200 text-text-secondary shrink-0;
}

.ms-icon.is-open {
  transform: rotate(180deg);
}
</style>

<style>
.ms-content {
  min-width: var(--reka-popover-trigger-width, 140px);
  max-width: 320px;
  padding: 6px;
}

.ms-viewport {
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.ms-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  transition: background-color 0.15s;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-main);
  background: transparent;
  border: none;
  outline: none;
}

.ms-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

:root.dark .ms-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.ms-item[data-checked] {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.ms-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-item-indicator {
  color: var(--color-primary);
  flex-shrink: 0;
}
</style>
