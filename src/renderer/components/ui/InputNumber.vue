<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { iconChevronUp, iconChevronDown } from '@/icons';

interface Props {
  modelValue?: number | string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  min: -Infinity,
  max: Infinity,
  step: 1,
  placeholder: '',
  suffix: '',
  disabled: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressInterval: ReturnType<typeof setInterval> | null = null;

const numericValue = computed(() => {
  const parsed = Number(props.modelValue);
  return Number.isNaN(parsed) ? undefined : parsed;
});

const clamp = (val: number) => Math.max(props.min, Math.min(props.max, val));

const canIncrement = computed(() => {
  if (props.disabled) return false;
  return numericValue.value === undefined || numericValue.value < props.max;
});

const canDecrement = computed(() => {
  if (props.disabled) return false;
  return numericValue.value === undefined || numericValue.value > props.min;
});

const increment = () => {
  if (!canIncrement.value) return;
  const base = numericValue.value ?? props.min;
  emit('update:modelValue', String(clamp(base + props.step)));
};

const decrement = () => {
  if (!canDecrement.value) return;
  const base = numericValue.value ?? props.max;
  emit('update:modelValue', String(clamp(base - props.step)));
};

const handleInput = (e: Event) => {
  const raw = (e.target as HTMLInputElement).value;
  // 只允许数字、负号和空值
  const filtered = raw.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '');
  if (raw !== filtered) {
    (e.target as HTMLInputElement).value = filtered;
  }
  emit('update:modelValue', filtered);
};

const handleBlur = () => {
  if (numericValue.value === undefined) return;
  const clamped = clamp(numericValue.value);
  if (clamped !== numericValue.value) {
    emit('update:modelValue', String(clamped));
  }
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    increment();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    decrement();
  }
};

const startPress = (action: () => void) => {
  action();
  pressTimer = setTimeout(() => {
    pressInterval = setInterval(action, 80);
  }, 400);
};

const stopPress = () => {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  if (pressInterval) {
    clearInterval(pressInterval);
    pressInterval = null;
  }
};

onBeforeUnmount(stopPress);
</script>

<template>
  <div :class="['input-number', props.class, { 'is-disabled': props.disabled }]">
    <input
      ref="inputRef"
      type="text"
      inputmode="numeric"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      class="input-number-field"
      @input="handleInput"
      @blur="handleBlur"
      @keydown="handleKeydown"
    />
    <span v-if="props.suffix" class="input-number-suffix">{{ props.suffix }}</span>
    <div class="input-number-controls">
      <button
        type="button"
        tabindex="-1"
        class="input-number-btn"
        :class="{ 'is-disabled': !canIncrement }"
        :disabled="!canIncrement"
        @mousedown.prevent="startPress(increment)"
        @mouseup="stopPress"
        @mouseleave="stopPress"
      >
        <Icon :icon="iconChevronUp" width="12" height="12" />
      </button>
      <button
        type="button"
        tabindex="-1"
        class="input-number-btn"
        :class="{ 'is-disabled': !canDecrement }"
        :disabled="!canDecrement"
        @mousedown.prevent="startPress(decrement)"
        @mouseup="stopPress"
        @mouseleave="stopPress"
      >
        <Icon :icon="iconChevronDown" width="12" height="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.input-number {
  @apply inline-flex items-stretch rounded-xl overflow-hidden;
  height: 40px;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 92%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  transition: border-color 0.15s ease;
}

.input-number:focus-within {
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--color-border-light));
}

.input-number.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-number-field {
  flex: 1;
  min-width: 0;
  padding: 0 0 0 14px;
  border: none;
  background: transparent;
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 600;
  line-height: 40px;
  outline: none;
  text-align: left;
  font-variant-numeric: tabular-nums;
}

.input-number-field::placeholder {
  color: color-mix(in srgb, var(--color-text-main) 40%, transparent);
}

.input-number-field:disabled {
  cursor: not-allowed;
}

.input-number-suffix {
  @apply flex items-center text-text-secondary text-[13px] font-semibold pr-2 select-none shrink-0;
}

.input-number-controls {
  @apply flex flex-col shrink-0;
  width: 28px;
  border-left: 1px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
}

.input-number-btn {
  @apply flex items-center justify-center flex-1;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  outline: none;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
  padding: 0;
  min-height: 0;
}

.input-number-btn:hover:not(.is-disabled) {
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
  color: var(--color-text-main);
}

.input-number-btn:active:not(.is-disabled) {
  background: color-mix(in srgb, var(--color-text-main) 14%, transparent);
}

.input-number-btn.is-disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.input-number-btn + .input-number-btn {
  border-top: 1px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
}
</style>
