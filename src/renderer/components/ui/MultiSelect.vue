<script setup lang="ts">
import { computed, ref } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
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
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="ms-trigger"
      :data-state="open ? 'open' : 'closed'"
      :data-placeholder="isPlaceholder ? '' : undefined"
    >
      <span class="ms-value" :class="{ 'is-placeholder': isPlaceholder }">
        {{ displayText }}
      </span>
      <span class="ms-icon">
        <Icon :icon="iconChevronDown" width="14" height="14" />
      </span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        class="ms-content"
        :side-offset="6"
        :collision-padding="12"
        align="end"
        :avoid-collisions="true"
      >
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
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
@reference "@/style.css";

.ms-trigger {
  @apply inline-flex w-auto min-w-[140px] h-9 px-3 rounded-xl border border-border-light bg-black/[0.06] dark:bg-white/[0.06] text-text-main text-[13px] font-semibold items-center justify-between gap-2 transition-all cursor-pointer;
}

.ms-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10 shadow-[0_10px_24px_rgba(0,0,0,0.14)];
}

.ms-trigger:hover {
  @apply border-primary/30 bg-black/[0.08] dark:bg-white/[0.08];
}

.ms-trigger:focus-visible {
  @apply outline-none;
  box-shadow: none;
}

.ms-value {
  @apply truncate text-text-main/80;
}

.ms-value.is-placeholder {
  @apply text-text-secondary/70;
}

.ms-icon {
  @apply transition-transform text-text-secondary;
}

.ms-trigger[data-state='open'] .ms-icon {
  transform: rotate(180deg);
}
</style>

<style>
/* 弹出层在 Portal 中渲染，需要全局样式 */
.ms-content {
  position: relative;
  z-index: 9999;
  border-radius: 20px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  padding: 8px;
  box-sizing: border-box;
  width: max-content;
  min-width: var(--reka-popover-trigger-width);
  max-width: 320px;
  max-height: 360px;
  overflow: hidden;
  animation: ms-fade-in 0.16s ease-out;
}

.ms-content[data-state='closed'] {
  animation: ms-fade-out 0.12s ease-in;
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
  font-size: 14px;
  line-height: 1;
  font-weight: 700;
  flex-shrink: 0;
}

@keyframes ms-fade-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes ms-fade-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
</style>
