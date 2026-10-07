<script setup lang="ts">
import { useId } from 'vue';
import Slider from '@/components/ui/Slider.vue';

defineProps<{
  label: string;
  hint?: string;
  modelValue: number;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();
const labelId = useId();
const hintId = useId();
</script>

<template>
  <div class="skin-setting-slider">
    <div class="slider-heading">
      <span :id="labelId" class="setting-label">{{ label }}</span>
      <span class="setting-value">{{ valueLabel }}</span>
    </div>
    <p v-if="hint" :id="hintId" class="setting-hint">{{ hint }}</p>
    <Slider
      class="settings-slider"
      :model-value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      :aria-labelledby="labelId"
      :aria-describedby="hint ? hintId : undefined"
      :aria-value-text="valueLabel"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped src="./skinSettings.css"></style>

<style scoped>
.settings-slider {
  margin-top: 6px;
}

.skin-setting-slider {
  padding: 12px;
  min-width: 0;
}

.slider-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.setting-hint {
  margin: 4px 0 0;
}
</style>
