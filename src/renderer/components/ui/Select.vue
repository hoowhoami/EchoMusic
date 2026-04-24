<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import Popover from './Popover.vue';
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
  /** 是否可搜索 */
  filterable?: boolean;
  /** 虚拟滚动（选项超过此数量时启用） */
  virtualThreshold?: number;
}

const props = withDefaults(defineProps<Props>(), {
  options: () => [],
  placeholder: '请选择',
  filterable: false,
  virtualThreshold: 50,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: SelectValueType): void;
}>();

const open = ref(false);
const searchTerm = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const scrollTop = ref(0);

const ITEM_HEIGHT = 36;
const VISIBLE_COUNT = 10;

const selectedLabel = computed(() => {
  const selected = props.options.find((opt) => Object.is(opt.value, props.modelValue));
  return selected?.label ?? '';
});

const filteredOptions = computed(() => {
  if (!props.filterable || !searchTerm.value) return props.options;
  const keyword = searchTerm.value.toLowerCase();
  return props.options.filter((opt) => opt.label.toLowerCase().includes(keyword));
});

const useVirtual = computed(() => filteredOptions.value.length > props.virtualThreshold);

// 虚拟滚动
const totalHeight = computed(() => filteredOptions.value.length * ITEM_HEIGHT);
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - 2));
const endIndex = computed(() =>
  Math.min(filteredOptions.value.length, startIndex.value + VISIBLE_COUNT + 4),
);
const visibleItems = computed(() => {
  if (!useVirtual.value) return filteredOptions.value;
  return filteredOptions.value.slice(startIndex.value, endIndex.value);
});
const offsetY = computed(() => (useVirtual.value ? startIndex.value * ITEM_HEIGHT : 0));

const handleScroll = (e: Event) => {
  scrollTop.value = (e.target as HTMLDivElement).scrollTop;
};

const handleSelect = (option: SelectOption) => {
  if (option.disabled) return;
  emit('update:modelValue', option.value);
  open.value = false;
  searchTerm.value = '';
};

watch(open, (val) => {
  if (val) {
    searchTerm.value = '';
    scrollTop.value = 0;
    if (props.filterable) {
      nextTick(() => inputRef.value?.focus());
    }
  }
});
</script>

<template>
  <Popover
    v-model:open="open"
    trigger="click"
    side="bottom"
    :align="'end'"
    :side-offset="6"
    :show-arrow="false"
    content-class="echo-select-content"
  >
    <template #trigger>
      <button
        type="button"
        :class="['echo-select-trigger', props.triggerClass, props.class]"
        :data-state="open ? 'open' : 'closed'"
      >
        <span class="echo-select-value" :class="{ 'is-placeholder': !selectedLabel }">
          {{ selectedLabel || props.placeholder }}
        </span>
        <span class="echo-select-icon" :class="{ 'is-open': open }">
          <Icon :icon="iconChevronDown" width="14" height="14" />
        </span>
      </button>
    </template>

    <div v-if="props.filterable" class="echo-select-search">
      <input
        ref="inputRef"
        v-model="searchTerm"
        class="echo-select-search-input"
        placeholder="搜索..."
        @keydown.stop
      />
    </div>

    <div v-if="filteredOptions.length === 0" class="echo-select-empty">无匹配项</div>
    <div v-else class="echo-select-list" @scroll.passive="handleScroll">
      <div :style="useVirtual ? { height: totalHeight + 'px', position: 'relative' } : {}">
        <div :style="useVirtual ? { transform: `translateY(${offsetY}px)` } : {}">
          <button
            v-for="option in visibleItems"
            :key="String(option.value)"
            type="button"
            class="echo-select-item"
            :class="{
              'is-selected': Object.is(option.value, props.modelValue),
              'is-disabled': option.disabled,
            }"
            :style="useVirtual ? { height: ITEM_HEIGHT + 'px' } : {}"
            :disabled="option.disabled"
            @click="handleSelect(option)"
          >
            <span class="echo-select-item-text">{{ option.label }}</span>
            <span v-if="Object.is(option.value, props.modelValue)" class="echo-select-item-check"
              >✓</span
            >
          </button>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
@reference "@/style.css";

.echo-select-trigger {
  @apply inline-flex w-auto min-w-[140px] h-9 px-3 rounded-xl border border-border-light bg-black/6 dark:bg-white/6 text-text-main text-[13px] font-semibold items-center justify-between gap-2 transition-all cursor-pointer;
}

.echo-select-trigger:hover {
  @apply border-primary/30 bg-black/8 dark:bg-white/8;
}

.echo-select-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10;
}

.echo-select-value {
  @apply truncate text-text-main/80;
}

.echo-select-value.is-placeholder {
  @apply text-text-secondary/70;
}

.echo-select-icon {
  @apply transition-transform duration-200 shrink-0;
}

.echo-select-icon.is-open {
  transform: rotate(180deg);
}

.echo-select-search {
  @apply px-1 pb-2;
}

.echo-select-search-input {
  @apply w-full h-8 px-2.5 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-[13px] font-medium outline-none border border-transparent;
}

.echo-select-search-input:focus {
  @apply border-primary/30;
}

.echo-select-search-input::placeholder {
  @apply text-text-secondary/60;
}

.echo-select-empty {
  @apply px-3 py-4 text-center text-[13px] text-text-secondary;
}

.echo-select-list {
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.echo-select-item {
  @apply w-full px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold flex items-center justify-between gap-2 transition-colors cursor-pointer select-none;
}

.echo-select-item:hover {
  @apply bg-black/5 dark:bg-white/5;
}

.echo-select-item.is-selected {
  @apply text-primary bg-primary/10;
}

.echo-select-item.is-disabled {
  @apply opacity-50 cursor-not-allowed;
}

.echo-select-item-text {
  @apply truncate;
}

.echo-select-item-check {
  @apply text-primary text-[14px] leading-none font-bold shrink-0;
}
</style>

<style>
.echo-select-content {
  min-width: var(--reka-popover-trigger-width, 140px);
  max-width: min(320px, 90vw);
  padding: 6px;
}
</style>
