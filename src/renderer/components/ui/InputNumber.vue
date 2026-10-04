<script setup lang="ts">
import { computed, ref, watch, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { iconChevronUp, iconChevronDown } from '@/icons';

interface Props {
  id?: string;
  size?: 'sm' | 'md';
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
  size: 'md',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const isEditing = ref(false);
const editingValue = ref('');
const suspended = ref(false);
const disposed = ref(false);
const canInteract = computed(() => !props.disabled && !suspended.value && !disposed.value);
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressInterval: ReturnType<typeof setInterval> | null = null;

const numericValue = computed(() => {
  const parsed = Number(props.modelValue);
  return Number.isFinite(parsed) ? parsed : undefined;
});
const validStep = computed(() => Number.isFinite(props.step) && props.step > 0);

const clamp = (val: number) => Math.max(props.min, Math.min(props.max, val));

const decimalPlaces = (value: number) => {
  const [coefficient, exponent = '0'] = String(value).split('e');
  return Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent));
};

const addStep = (base: number, delta: number) => {
  const scale = 10 ** Math.max(decimalPlaces(base), decimalPlaces(delta));
  const scaledBase = Math.round(base * scale);
  const scaledDelta = Math.round(delta * scale);
  const sum = scaledBase + scaledDelta;
  // Calculate decimal steps as integers when safe, without rounding away a
  // manually entered value that has finer precision than the configured step.
  if ([scaledBase, scaledDelta, sum].every(Number.isSafeInteger)) return sum / scale;
  return base + delta;
};

const emitFiniteValue = (value: number) => {
  if (Number.isFinite(value)) emit('update:modelValue', String(value));
};

const canIncrement = computed(() => {
  if (!canInteract.value || !validStep.value) return false;
  return numericValue.value === undefined || numericValue.value < props.max;
});

const canDecrement = computed(() => {
  if (!canInteract.value || !validStep.value) return false;
  return numericValue.value === undefined || numericValue.value > props.min;
});

const increment = () => {
  if (!canIncrement.value) return;
  isEditing.value = false;
  const base = numericValue.value ?? (Number.isFinite(props.min) ? props.min : 0);
  emitFiniteValue(clamp(addStep(base, props.step)));
};

const decrement = () => {
  if (!canDecrement.value) return;
  isEditing.value = false;
  const base = numericValue.value ?? (Number.isFinite(props.max) ? props.max : 0);
  emitFiniteValue(clamp(addStep(base, -props.step)));
};

const handleInput = (e: Event) => {
  if (!canInteract.value) return;
  const raw = (e.target as HTMLInputElement).value;
  // 允许数字、小数点、负号和空值；只保留第一个小数点和第一个负号
  let filtered = raw.replace(/[^\d.-]/g, '');
  // 负号只允许出现在开头
  filtered = filtered.replace(/(?!^)-/g, '');
  // 只保留第一个小数点
  const dotIndex = filtered.indexOf('.');
  if (dotIndex !== -1) {
    filtered = filtered.slice(0, dotIndex + 1) + filtered.slice(dotIndex + 1).replace(/\./g, '');
  }
  if (raw !== filtered) {
    (e.target as HTMLInputElement).value = filtered;
  }
  isEditing.value = true;
  editingValue.value = filtered;
};

const handleFocus = () => {
  if (!canInteract.value) return;
  isEditing.value = true;
  editingValue.value = String(props.modelValue ?? '');
};

const handleBlur = () => {
  if (!isEditing.value || !canInteract.value) return;
  isEditing.value = false;
  const parsed = Number(editingValue.value);
  if (editingValue.value === '' || !Number.isFinite(parsed)) {
    // 空值或无效值，恢复原值
    editingValue.value = '';
    return;
  }
  const clamped = clamp(parsed);
  emitFiniteValue(clamped);
};

const handleKeydown = (e: KeyboardEvent) => {
  if (!canInteract.value || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    increment();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    decrement();
  } else if (e.key === 'Enter') {
    // Commit before a parent handles Enter (for example, moving a playlist row).
    handleBlur();
  }
};

let pressGeneration = 0;
let listening = false;
let pressAction: (() => void) | null = null;
const stopPress = () => {
  pressGeneration++;
  pressAction = null;
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  if (pressInterval !== null) {
    clearInterval(pressInterval);
    pressInterval = null;
  }
  if (listening) {
    window.removeEventListener('mouseup', stopPress);
    window.removeEventListener('blur', stopPress);
    listening = false;
  }
};

const startPress = (action: () => void) => {
  stopPress();
  if (!canInteract.value) return;
  const generation = pressGeneration;
  pressAction = action;
  action();
  // A parent can disable or remove this control in response to the first step.
  if (!canInteract.value || generation !== pressGeneration) return;
  listening = true;
  window.addEventListener('mouseup', stopPress);
  window.addEventListener('blur', stopPress);
  pressTimer = setTimeout(() => {
    if (!canInteract.value || generation !== pressGeneration) return;
    pressTimer = null;
    pressInterval = setInterval(() => {
      if (canInteract.value && generation === pressGeneration) action();
    }, 80);
  }, 400);
};

watch(
  [canIncrement, canDecrement],
  ([up, down]) => {
    if ((pressAction === increment && !up) || (pressAction === decrement && !down)) stopPress();
  },
  { flush: 'sync' },
);

watch(
  canInteract,
  (available) => {
    if (available) return;
    stopPress();
    isEditing.value = false;
    editingValue.value = '';
  },
  { flush: 'sync' },
);
onDeactivated(() => {
  suspended.value = true;
});
onActivated(() => {
  suspended.value = false;
});
onBeforeUnmount(() => {
  disposed.value = true;
  stopPress();
});
</script>

<template>
  <div
    :class="[
      'input-number',
      props.class,
      { 'is-disabled': props.disabled, 'is-small': props.size === 'sm' },
    ]"
  >
    <input
      ref="inputRef"
      :id="props.id"
      type="text"
      inputmode="numeric"
      :value="isEditing ? editingValue : props.modelValue"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      class="input-number-field"
      @focus="handleFocus"
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
        aria-label="增加数值"
        @mousedown.left.prevent="startPress(increment)"
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
        aria-label="减少数值"
        @mousedown.left.prevent="startPress(decrement)"
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
  border: 1px solid var(--control-border);
  background: var(--control-muted-bg);
  transition: border-color 0.15s ease;
}

.input-number:focus-within {
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--control-border));
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

.input-number.is-small {
  height: 28px;
  border-radius: 8px;
}

.input-number.is-small .input-number-field {
  padding-left: 10px;
  font-size: 12px;
  line-height: 26px;
}

.input-number.is-small .input-number-controls {
  width: 22px;
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
  border-left: 1px solid var(--control-border);
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
  background: var(--control-hover-bg);
  color: var(--color-text-main);
}

.input-number-btn:active:not(.is-disabled) {
  background: var(--row-active-bg);
}

.input-number-btn.is-disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.input-number-btn + .input-number-btn {
  border-top: 1px solid var(--control-border);
}
</style>
