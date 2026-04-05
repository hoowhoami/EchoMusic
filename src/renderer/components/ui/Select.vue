<script setup lang="ts">
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';
import { computed } from 'vue';
import { iconChevronDown } from '@/icons';

type SelectValueType = string | number;

interface SelectOption {
  label: string;
  value: SelectValueType;
  disabled?: boolean;
}

interface Props {
  modelValue?: SelectValueType;
  options: SelectOption[];
  placeholder?: string;
  class?: string;
  triggerClass?: string;
  contentClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  options: () => [],
  placeholder: '请选择',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: SelectValueType): void;
}>();

const selectedLabel = computed(() => {
  const selected = props.options.find((option) => Object.is(option.value, props.modelValue));
  return selected?.label ?? '';
});
</script>

<template>
  <SelectRoot
    :model-value="props.modelValue"
    @update:model-value="emit('update:modelValue', $event as SelectValueType)"
  >
    <SelectTrigger :class="['select-trigger', props.triggerClass, props.class]">
      <SelectValue
        :placeholder="props.placeholder"
        :title="selectedLabel || props.placeholder"
        class="select-value"
      />
      <SelectIcon class="select-icon">
        <Icon :icon="iconChevronDown" width="14" height="14" />
      </SelectIcon>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        class="select-content"
        :class="props.contentClass"
        position="popper"
        :side-offset="6"
        :collision-padding="12"
        avoid-collisions
      >
        <SelectViewport class="select-viewport">
          <SelectItem
            v-for="option in props.options"
            :key="String(option.value)"
            :value="option.value"
            :disabled="option.disabled"
            class="select-item"
          >
            <SelectItemText class="select-item-text" :title="option.label">
              {{ option.label }}
            </SelectItemText>
            <SelectItemIndicator class="select-item-indicator">
              ✓
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style scoped>
@reference "@/style.css";

.select-trigger {
  @apply inline-flex w-auto min-w-[140px] h-9 px-3 rounded-xl border border-border-light bg-black/[0.06] dark:bg-white/[0.06] text-text-main text-[13px] font-semibold items-center justify-between gap-2 transition-all;
}

.select-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10 shadow-[0_10px_24px_rgba(0,0,0,0.14)];
}

.select-trigger:hover {
  @apply border-primary/30 bg-black/[0.08] dark:bg-white/[0.08];
}

.select-trigger:focus-visible {
  @apply outline-none;
  box-shadow: none;
}

.select-value {
  @apply truncate text-text-main/80 data-[placeholder]:text-text-secondary/70;
}

.select-icon {
  @apply transition-transform data-[state=open]:rotate-180;
}

:global(.select-content) {
  @apply relative z-[9999] rounded-[20px] border border-border-light bg-bg-card shadow-[0_16px_40px_rgba(0,0,0,0.18)] p-2;
  box-sizing: border-box;
  width: max-content;
  min-width: var(--reka-select-trigger-width);
  max-width: min(320px, var(--reka-select-content-available-width));
  max-height: min(320px, var(--reka-select-content-available-height));
  overflow: hidden;
  animation: select-fade-in 0.16s ease-out;
}

:global(.select-content[data-state='closed']) {
  animation: select-fade-out 0.12s ease-in;
}

.select-viewport {
  max-height: min(304px, var(--reka-select-content-available-height));
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: transparent;
}

.select-item {
  @apply w-full px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold flex items-center justify-between gap-2;
  @apply hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer select-none;
  @apply data-[state=checked]:text-primary data-[state=checked]:bg-primary/10;
  @apply data-[disabled]:opacity-60 data-[disabled]:cursor-not-allowed;
  @apply focus-visible:outline-none;
}

.select-item:focus-visible {
  box-shadow: none;
}

:global(.select-content::after) {
  content: '';
  @apply absolute inset-0 rounded-xl border border-black/5 pointer-events-none;
}

.select-item-text {
  @apply truncate;
}

.select-item-indicator {
  @apply text-primary text-[14px] leading-none font-bold;
}

@keyframes select-fade-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes select-fade-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(-4px) scale(0.98); }
}
</style>
