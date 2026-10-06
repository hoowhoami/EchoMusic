<script setup lang="ts">
import { computed } from 'vue';
import Button from '@/components/ui/Button.vue';

interface Props {
  tabs: string[];
  modelValue?: number;
  class?: string;
  ariaLabel?: string;
  tabIds?: string[];
  panelIds?: string[];
  disabled?: boolean;
  /** 吸顶工具栏等紧凑区域使用同一套样式的较小尺寸。 */
  size?: 'default' | 'sm';
  /** 切换设置值时使用单选组语义；切换内容面板时使用默认 tablist。 */
  role?: 'tablist' | 'radiogroup';
}

const props = withDefaults(defineProps<Props>(), {
  tabs: () => [],
  modelValue: 0,
  disabled: false,
  size: 'default',
  role: 'tablist',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

defineSlots<{
  tab?: (props: { label: string; index: number; selected: boolean }) => unknown;
}>();

const tabCount = computed(() => (props.tabs.length > 0 ? props.tabs.length : 1));
const hasSelection = computed(
  () =>
    Number.isInteger(props.modelValue) &&
    props.modelValue >= 0 &&
    props.modelValue < props.tabs.length,
);

const sliderStyle = computed(() => ({
  width: `calc((100% - ${tabCount.value - 1} * var(--custom-tab-gap)) / ${tabCount.value})`,
  transform: `translateX(calc(${props.modelValue * 100}% + ${props.modelValue} * var(--custom-tab-gap)))`,
  visibility: hasSelection.value ? ('visible' as const) : ('hidden' as const),
}));

const isSelected = (index: number) => index === props.modelValue;

const handleSelect = (index: number) => {
  if (props.disabled || !Number.isInteger(index) || index < 0 || index >= props.tabs.length) return;
  if (index === props.modelValue) return;
  emit('update:modelValue', index);
};

const handleKeydown = (event: KeyboardEvent, index: number) => {
  if (props.disabled || props.tabs.length === 0) return;
  let nextIndex = index;
  if (event.key === 'ArrowRight' || (props.role === 'radiogroup' && event.key === 'ArrowDown')) {
    nextIndex = (index + 1) % tabCount.value;
  } else if (
    event.key === 'ArrowLeft' ||
    (props.role === 'radiogroup' && event.key === 'ArrowUp')
  ) {
    nextIndex = (index - 1 + tabCount.value) % tabCount.value;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabCount.value - 1;
  } else {
    return;
  }

  event.preventDefault();
  handleSelect(nextIndex);
  const track = (event.currentTarget as HTMLElement).closest<HTMLElement>('.custom-tab-track');
  track?.querySelectorAll<HTMLElement>('.custom-tab-item')[nextIndex]?.focus();
};
</script>

<template>
  <div class="custom-tab-root" :class="[props.class, { 'is-compact': size === 'sm' }]">
    <div
      class="custom-tab-track"
      :role="props.role"
      :aria-label="props.ariaLabel"
      :aria-disabled="disabled || undefined"
    >
      <div class="custom-tab-slider" :style="sliderStyle" aria-hidden="true"></div>
      <Button
        variant="unstyled"
        size="none"
        v-for="(label, index) in props.tabs"
        :key="index"
        type="button"
        class="custom-tab-item"
        :class="{ active: isSelected(index) }"
        :role="props.role === 'radiogroup' ? 'radio' : 'tab'"
        :id="props.tabIds?.[index]"
        :aria-controls="props.role === 'tablist' ? props.panelIds?.[index] : undefined"
        :aria-selected="props.role === 'tablist' ? isSelected(index) : undefined"
        :aria-checked="props.role === 'radiogroup' ? isSelected(index) : undefined"
        :disabled="disabled"
        :tabindex="!disabled && (isSelected(index) || (!hasSelection && index === 0)) ? 0 : -1"
        @click="handleSelect(index)"
        @keydown="handleKeydown($event, index)"
      >
        <slot name="tab" :label="label" :index="index" :selected="isSelected(index)">
          <span class="custom-tab-label">{{ label }}</span>
        </slot>
      </Button>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.custom-tab-root {
  --custom-tab-gap: 4px;
  width: var(--custom-tab-width, 100%);
  height: 44px;
  padding: 4px;
  border-radius: var(--radius-item);
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
}

.custom-tab-track {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: var(--custom-tab-gap);
  align-items: center;
}

.custom-tab-root.is-compact {
  height: 32px;
  padding: 3px;
}

.custom-tab-root.is-compact .custom-tab-item {
  padding: 0 8px;
  font-size: 12px;
}

.custom-tab-slider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: var(--radius-item);
  background: var(--control-active-bg);
  box-shadow: var(--control-active-shadow);
  transition: transform var(--motion-duration-normal) var(--motion-ease-standard);
  z-index: 1;
}

.custom-tab-item {
  position: relative;
  z-index: 2;
  height: 100%;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  border-radius: var(--radius-item);
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    background-color var(--motion-duration-fast) var(--motion-ease-standard);
}

.custom-tab-item:not(.active):hover:not(:disabled) {
  color: var(--color-text-main);
  background: var(--row-hover-bg);
}

.custom-tab-item.active {
  color: var(--color-primary-text);
}

.custom-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .custom-tab-slider,
  .custom-tab-item {
    transition: none;
  }
}
</style>
