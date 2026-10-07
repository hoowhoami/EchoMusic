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
  formatValue?: (value: number) => string;
  disabled?: boolean;
  orientation?: SliderOrientation;
  trackClass?: string;
  rangeClass?: string;
  thumbClass?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
  ariaValueText?: string;
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
  'slider-root echo-slider',
  props.orientation === 'vertical' ? 'slider-root-vertical' : 'slider-root-horizontal',
]);

const trackClass = computed(() => ['echo-slider-track', props.trackClass]);
const rangeClass = computed(() => ['echo-slider-range', props.rangeClass]);
const thumbClass = computed(() => ['echo-slider-thumb', props.thumbClass]);
const valueLabel = computed(() =>
  props.formatValue
    ? props.formatValue(normalizedValue.value)
    : `${normalizedValue.value}${props.valueSuffix}`,
);
</script>

<template>
  <div
    class="slider-wrapper"
    :class="[
      props.orientation === 'vertical' ? 'slider-wrapper-vertical' : 'slider-wrapper-horizontal',
      props.showValue ? 'has-value-label' : '',
    ]"
  >
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
      <SliderThumb
        :class="thumbClass"
        :aria-label="props.ariaLabel"
        :aria-labelledby="props.ariaLabelledby"
        :aria-describedby="props.ariaDescribedby"
        :aria-valuetext="props.ariaValueText || valueLabel"
      />
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
  @apply relative flex items-center;
  min-width: 0;
  max-width: 100%;
}

.slider-wrapper-horizontal.has-value-label {
  @apply pt-5;
}

.slider-wrapper-vertical {
  @apply relative flex flex-col items-center gap-2;
  min-height: 0;
}

.slider-root-horizontal {
  @apply flex items-center h-6;
  width: 100%;
  min-width: 0;
}

.slider-root-vertical {
  @apply flex flex-col items-center w-6;
  height: 100%;
  min-height: 0;
}

.slider-value-label {
  @apply absolute top-0 right-0 text-[11px] font-semibold text-text-secondary tabular-nums leading-none pointer-events-none;
  padding: 2px 6px;
  border-radius: var(--radius-detail);
  background: var(--control-muted-bg);
}

.slider-wrapper-vertical .slider-value-label {
  position: static;
}
</style>
