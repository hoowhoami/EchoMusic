<script setup lang="ts">
import { computed, ref } from 'vue';
import { SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SliderRoot from '@/components/ui/SliderRoot.vue';

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
  /** 拖动时在拇指上方跟一个气泡，实时显示当前值（默认关）。 */
  bubble?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 100,
  step: 1,
  showValue: false,
  valueSuffix: '',
  disabled: false,
  orientation: 'horizontal',
  bubble: false,
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
// 气泡只在按住拖动时出现：松手即消失，平时不挡视线。
const dragging = ref(false);
// 禁用时不弹气泡：拖不动还跟着动会让人以为生效了。
const startDrag = () => {
  if (props.disabled) return;
  dragging.value = true;
};
const bubbleStyle = computed(() => {
  const span = Math.max(1, props.max - props.min);
  const ratio = Math.min(1, Math.max(0, (normalizedValue.value - props.min) / span));
  return { left: `${ratio * 100}%` };
});
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
    @pointerdown="startDrag"
    @pointerup="dragging = false"
    @pointercancel="dragging = false"
  >
    <span v-if="props.bubble && dragging" class="slider-bubble" :style="bubbleStyle">
      {{ valueLabel }}
    </span>
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

.slider-bubble {
  @apply pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/80 px-1.5 py-0.5 text-xs text-white;
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
