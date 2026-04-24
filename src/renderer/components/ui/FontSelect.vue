<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import { iconChevronDown } from '@/icons';

interface FontOption {
  label: string;
  value: string;
}

interface Props {
  modelValue?: string;
  options: FontOption[];
  placeholder?: string;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  options: () => [],
  placeholder: '搜索字体...',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const open = ref(false);
const searchTerm = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLDivElement | null>(null);

// 虚拟滚动参数
const ITEM_HEIGHT = 36;
const VISIBLE_COUNT = 10;
const scrollTop = ref(0);

const filteredOptions = computed(() => {
  if (!searchTerm.value) return props.options;
  const keyword = searchTerm.value.toLowerCase();
  return props.options.filter((opt) => opt.label.toLowerCase().includes(keyword));
});

const selectedLabel = computed(() => {
  const matched = props.options.find((opt) => opt.value === props.modelValue);
  return matched?.label ?? props.modelValue ?? '';
});

// 虚拟滚动计算
const totalHeight = computed(() => filteredOptions.value.length * ITEM_HEIGHT);
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - 2));
const endIndex = computed(() =>
  Math.min(filteredOptions.value.length, startIndex.value + VISIBLE_COUNT + 4),
);
const visibleItems = computed(() =>
  filteredOptions.value.slice(startIndex.value, endIndex.value).map((opt, i) => ({
    ...opt,
    index: startIndex.value + i,
  })),
);
const offsetY = computed(() => startIndex.value * ITEM_HEIGHT);

const handleScroll = (e: Event) => {
  scrollTop.value = (e.target as HTMLDivElement).scrollTop;
};

const handleSelect = (value: string) => {
  emit('update:modelValue', value);
  open.value = false;
  searchTerm.value = '';
};

watch(open, (val) => {
  if (val) {
    searchTerm.value = '';
    scrollTop.value = 0;
    nextTick(() => inputRef.value?.focus());
  }
});
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger :class="['font-select-trigger', props.class]">
      <span class="font-select-value" :title="selectedLabel">{{ selectedLabel }}</span>
      <Icon
        :icon="iconChevronDown"
        width="14"
        height="14"
        class="font-select-icon"
        :class="{ 'rotate-180': open }"
      />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        class="font-select-content"
        :side-offset="6"
        :collision-padding="12"
        side="bottom"
        align="end"
      >
        <div class="font-select-search">
          <input
            ref="inputRef"
            v-model="searchTerm"
            class="font-select-search-input"
            :placeholder="placeholder"
            @keydown.stop
          />
        </div>
        <div v-if="filteredOptions.length === 0" class="font-select-empty">无匹配字体</div>
        <div v-else ref="listRef" class="font-select-list" @scroll.passive="handleScroll">
          <div :style="{ height: totalHeight + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${offsetY}px)` }">
              <button
                v-for="item in visibleItems"
                :key="item.value"
                type="button"
                class="font-select-item"
                :class="{ 'is-selected': item.value === props.modelValue }"
                :style="{ height: ITEM_HEIGHT + 'px', fontFamily: item.value }"
                @click="handleSelect(item.value)"
              >
                <span class="font-select-item-text">{{ item.label }}</span>
                <span v-if="item.value === props.modelValue" class="font-select-item-check">✓</span>
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
@reference "@/style.css";

.font-select-trigger {
  @apply inline-flex w-auto min-w-[180px] h-9 px-3 rounded-xl border border-border-light bg-black/6 dark:bg-white/6 text-text-main text-[13px] font-semibold items-center justify-between gap-2 transition-all cursor-pointer;
}

.font-select-trigger:hover {
  @apply border-primary/30 bg-black/8 dark:bg-white/8;
}

.font-select-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10;
}

.font-select-value {
  @apply truncate text-text-main/80;
}

.font-select-icon {
  @apply transition-transform duration-200;
}

.font-select-search {
  @apply px-2 pb-2;
}

.font-select-search-input {
  @apply w-full h-8 px-2.5 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-[13px] font-medium outline-none border border-transparent;
}

.font-select-search-input:focus {
  @apply border-primary/30;
}

.font-select-search-input::placeholder {
  @apply text-text-secondary/60;
}

.font-select-empty {
  @apply px-3 py-4 text-center text-[13px] text-text-secondary;
}

.font-select-list {
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.font-select-item {
  @apply w-full px-3 rounded-xl text-left text-[13px] font-semibold flex items-center justify-between gap-2 transition-colors cursor-pointer select-none;
}

.font-select-item:hover {
  @apply bg-black/5 dark:bg-white/5;
}

.font-select-item.is-selected {
  @apply text-primary bg-primary/10;
}

.font-select-item-text {
  @apply truncate;
}

.font-select-item-check {
  @apply text-primary text-[14px] leading-none font-bold shrink-0;
}
</style>

<style>
.font-select-content {
  z-index: 9999;
  border-radius: 20px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  padding: 8px;
  box-sizing: border-box;
  width: 280px;
  animation: font-select-fade-in 0.16s ease-out;
}

.font-select-content[data-state='closed'] {
  animation: font-select-fade-out 0.12s ease-in;
}

@keyframes font-select-fade-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes font-select-fade-out {
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
