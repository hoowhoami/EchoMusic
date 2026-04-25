<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import Popover from './Popover.vue';
import { iconChevronDown, iconX } from '@/icons';

type SelectValueType = string | number;

interface SelectOption {
  label: string;
  value: SelectValueType;
  disabled?: boolean;
}

interface Props {
  modelValue?: SelectValueType | SelectValueType[];
  options: SelectOption[];
  placeholder?: string;
  class?: string;
  /** 是否可搜索 */
  filterable?: boolean;
  /** 是否可清空 */
  clearable?: boolean;
  /** 是否多选 */
  multiple?: boolean;
  /** 多选时最多显示几个标签，超出用 +N 表示 */
  maxTagCount?: number;
  /** 虚拟滚动阈值 */
  virtualThreshold?: number;
}

const props = withDefaults(defineProps<Props>(), {
  options: () => [],
  placeholder: '请选择',
  filterable: false,
  clearable: false,
  multiple: false,
  maxTagCount: 1,
  virtualThreshold: 50,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: SelectValueType | SelectValueType[]): void;
}>();

const open = ref(false);
const searchTerm = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const scrollTop = ref(0);
const isHovered = ref(false);

const ITEM_HEIGHT = 36;
const VISIBLE_COUNT = 10;

// 多选值数组
const multiValue = computed<SelectValueType[]>(() => {
  if (!props.multiple) return [];
  return Array.isArray(props.modelValue) ? props.modelValue : [];
});

// 单选显示文本
const selectedLabel = computed(() => {
  if (props.multiple) return '';
  const matched = props.options.find((opt) => Object.is(opt.value, props.modelValue));
  return matched?.label ?? '';
});

// 多选已选标签（限制显示数量）
const selectedTags = computed(() => {
  if (!props.multiple) return [];
  return multiValue.value
    .map((v) => props.options.find((opt) => Object.is(opt.value, v)))
    .filter(Boolean) as SelectOption[];
});

const visibleTags = computed(() => selectedTags.value.slice(0, props.maxTagCount));
const overflowCount = computed(() => Math.max(0, selectedTags.value.length - props.maxTagCount));

// 是否显示清除按钮
const showClear = computed(() => {
  if (!props.clearable || !isHovered.value) return false;
  if (props.multiple) return multiValue.value.length > 0;
  return props.modelValue !== undefined && props.modelValue !== '';
});

// 过滤后的选项
const filteredOptions = computed(() => {
  if (!props.filterable || !searchTerm.value) return props.options;
  const keyword = searchTerm.value.toLowerCase();
  return props.options.filter((opt) => opt.label.toLowerCase().includes(keyword));
});

// 虚拟滚动
const useVirtual = computed(() => filteredOptions.value.length > props.virtualThreshold);
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

const isSelected = (value: SelectValueType) => {
  if (props.multiple) return multiValue.value.includes(value);
  return Object.is(value, props.modelValue);
};

const handleSelect = (option: SelectOption) => {
  if (option.disabled) return;
  if (props.multiple) {
    const current = [...multiValue.value];
    const idx = current.indexOf(option.value);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(option.value);
    emit('update:modelValue', current);
  } else {
    emit('update:modelValue', option.value);
    open.value = false;
  }
  searchTerm.value = '';
};

const handleClear = (e: Event) => {
  e.stopPropagation();
  if (props.multiple) emit('update:modelValue', []);
  else emit('update:modelValue', '' as SelectValueType);
  searchTerm.value = '';
};

const removeTag = (value: SelectValueType, e: Event) => {
  e.stopPropagation();
  emit(
    'update:modelValue',
    multiValue.value.filter((v) => v !== value),
  );
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
    align="start"
    :side-offset="6"
    :show-arrow="false"
    content-class="echo-select-content"
  >
    <template #trigger>
      <div
        :class="['echo-select-trigger', props.class]"
        :data-state="open ? 'open' : 'closed'"
        @mouseenter="isHovered = true"
        @mouseleave="isHovered = false"
      >
        <!-- 多选标签 -->
        <div v-if="props.multiple" class="echo-select-tags">
          <span v-for="tag in visibleTags" :key="String(tag.value)" class="echo-select-tag">
            <span class="echo-select-tag-text">{{ tag.label }}</span>
            <span class="echo-select-tag-close" @click="removeTag(tag.value, $event)">
              <Icon :icon="iconX" width="10" height="10" />
            </span>
          </span>
          <span v-if="overflowCount > 0" class="echo-select-tag echo-select-tag--count">
            +{{ overflowCount }}
          </span>
          <input
            v-if="props.filterable"
            ref="inputRef"
            v-model="searchTerm"
            class="echo-select-input"
            :placeholder="selectedTags.length === 0 ? props.placeholder : ''"
            @keydown.stop
          />
          <span v-else-if="selectedTags.length === 0" class="echo-select-placeholder">
            {{ props.placeholder }}
          </span>
        </div>
        <!-- 单选 -->
        <template v-else>
          <input
            v-if="props.filterable"
            ref="inputRef"
            v-model="searchTerm"
            class="echo-select-input"
            :placeholder="selectedLabel || props.placeholder"
            @keydown.stop
          />
          <span v-else class="echo-select-value" :class="{ 'is-placeholder': !selectedLabel }">
            {{ selectedLabel || props.placeholder }}
          </span>
        </template>
        <!-- 清除 / 箭头 -->
        <span v-if="showClear" class="echo-select-clear" @click="handleClear">
          <Icon :icon="iconX" width="12" height="12" />
        </span>
        <span v-else class="echo-select-arrow" :class="{ 'is-open': open }">
          <Icon :icon="iconChevronDown" width="14" height="14" />
        </span>
      </div>
    </template>

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
              'is-selected': isSelected(option.value),
              'is-disabled': option.disabled,
            }"
            :style="useVirtual ? { height: ITEM_HEIGHT + 'px' } : {}"
            :disabled="option.disabled"
            @click="handleSelect(option)"
          >
            <span class="echo-select-item-text">{{ option.label }}</span>
            <span v-if="isSelected(option.value)" class="echo-select-item-check">✓</span>
          </button>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
@reference "@/style.css";

.echo-select-trigger {
  @apply inline-flex h-9 px-3 rounded-xl border border-border-light bg-black/6 dark:bg-white/6 text-text-main text-[13px] font-semibold items-center gap-2 transition-all cursor-pointer overflow-hidden;
}

.echo-select-trigger:hover {
  @apply border-primary/30 bg-black/8 dark:bg-white/8;
}

.echo-select-trigger[data-state='open'] {
  @apply border-primary/40 bg-primary/10;
}

.echo-select-tags {
  @apply flex-1 flex items-center flex-wrap gap-1 min-w-0 overflow-hidden;
}

.echo-select-tag {
  @apply inline-flex items-center gap-0.5 h-6 px-2 rounded-md bg-primary/10 text-primary text-[11px] font-semibold shrink-0;
}

.echo-select-tag--count {
  @apply bg-black/8 dark:bg-white/10 text-text-secondary;
}

.echo-select-tag-text {
  @apply truncate max-w-[80px];
}

.echo-select-tag-close {
  @apply flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-primary/20 transition-colors cursor-pointer;
}

.echo-select-input {
  @apply flex-1 min-w-[40px] h-full bg-transparent text-text-main text-[13px] font-semibold outline-none;
}

.echo-select-input::placeholder {
  @apply text-text-main/50 font-semibold;
}

.echo-select-value {
  @apply flex-1 truncate text-text-main/80;
}

.echo-select-value.is-placeholder {
  @apply text-text-secondary/70;
}

.echo-select-placeholder {
  @apply flex-1 text-text-secondary/70 truncate;
}

.echo-select-clear {
  @apply flex items-center justify-center w-4 h-4 rounded-full bg-black/10 dark:bg-white/10 text-text-secondary hover:text-text-main transition-colors cursor-pointer shrink-0;
}

.echo-select-arrow {
  @apply transition-transform duration-200 shrink-0 text-text-secondary;
}

.echo-select-arrow.is-open {
  transform: rotate(180deg);
}
</style>

<style>
.echo-select-content {
  width: var(--reka-popover-trigger-width, 100%);
  padding: 6px;
}

.echo-select-empty {
  padding: 12px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.echo-select-list {
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.echo-select-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 10px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-text-main);
  background: transparent;
  border: none;
  outline: none;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.echo-select-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.dark .echo-select-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.echo-select-item.is-selected {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.echo-select-item.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.echo-select-item.is-disabled:hover {
  background: transparent;
}

.echo-select-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.echo-select-item-check {
  color: var(--color-primary);
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}
</style>
