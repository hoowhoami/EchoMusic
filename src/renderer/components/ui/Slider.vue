<script setup lang="ts">
import { computed } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';

type SliderOrientation = 'horizontal' | 'vertical';

interface Props {
  modelValue?: number;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  valueSuffix?: string;
  disabled?: boolean;
  orientation?: SliderOrientation;
  class?: string;
  trackClass?: string;
  rangeClass?: string;
  thumbClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 100,
  step: 1,
  showValue: false,
  valueSuffix: '',
  disabled: false,
  orientation: 'horizontal',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
  (e: 'valueCommit', value: number): void;
}>();

const normalizedValue = computed(() => props.modelValue ?? props.min);

const handleUpdate = (value?: number[]) => {
  if (!value?.length) return;
  emit('update:modelValue', value[0]);
};

const handleCommit = (value?: number[]) => {
  if (!value?.length) return;
  emit('valueCommit', value[0]);
};

const rootClass = computed(() => [
  'slider-root',
  props.orientation === 'vertical' ? 'slider-root-vertical' : 'slider-root-horizontal',
  props.class,
]);

const trackClass = computed(() => ['slider-track', props.trackClass]);
const rangeClass = computed(() => ['slider-range', props.rangeClass]);
const thumbClass = computed(() => ['slider-thumb', props.thumbClass]);
const valueLabel = computed(() => `${normalizedValue.value}${props.valueSuffix}`);
</script>

<template>
  <div class="slider-wrapper" :class="props.orientation === 'vertical' ? 'slider-wrapper-vertical' : 'slider-wrapper-horizontal'">
    <SliderRoot
      :model-value="[normalizedValue]"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :disabled="props.disabled"
      :orientation="props.orientation"
      :class="rootClass"
      @update:model-value="handleUpdate"
      @value-commit="handleCommit"
    >
      <SliderTrack :class="trackClass">
        <SliderRange :class="rangeClass" />
      </SliderTrack>
      <SliderThumb :class="thumbClass" />
    </SliderRoot>
    <span v-if="props.showValue" class="slider-value-label">{{ valueLabel }}</span>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.slider-root {
  @apply relative select-none touch-none cursor-pointer;
}

.slider-wrapper-horizontal {
  @apply relative flex items-center pt-4;
}

.slider-wrapper-vertical {
  @apply flex flex-col items-center gap-2;
}

.slider-root-horizontal {
  @apply flex items-center h-6;
}

.slider-root-vertical {
  @apply flex flex-col items-center w-6;
}

.slider-track {
  background-color: color-mix(in srgb, var(--color-text-main) 9%, var(--color-bg-card) 91%);
  @apply relative grow rounded-full;
}

.dark .slider-track {
  background-color: color-mix(in srgb, var(--color-text-main) 14%, var(--color-bg-card) 86%);
}

.slider-root-horizontal .slider-track {
  @apply h-[3px];
}

.slider-root-vertical .slider-track {
  @apply w-[3px];
}

.slider-range {
  @apply absolute rounded-full bg-primary;
}

.slider-root-horizontal .slider-range {
  @apply h-full;
}

.slider-root-vertical .slider-range {
  @apply w-full;
}

.slider-thumb {
  @apply block w-3 h-3 rounded-full bg-white border border-black/10 shadow-sm transition-shadow focus-visible:outline-none;
}

.slider-value-label {
  @apply absolute top-0 right-0 text-[11px] font-semibold text-text-main/70 tabular-nums leading-none pointer-events-none;
}

.slider-thumb:focus-visible {
  box-shadow: none;
}

.slider-root[data-disabled] {
  @apply opacity-60 cursor-not-allowed;
}

.slider-root[data-disabled] .slider-thumb {
  @apply cursor-not-allowed;
}
</style>
