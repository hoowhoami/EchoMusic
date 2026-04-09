<script setup lang="ts">
import { computed } from 'vue';
import Button from '@/components/ui/Button.vue';

interface Props {
  tabs: string[];
  modelValue?: number;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  tabs: () => [],
  modelValue: 0,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const tabCount = computed(() => (props.tabs.length > 0 ? props.tabs.length : 1));

const sliderStyle = computed(() => ({
  width: `calc(100% / ${tabCount.value})`,
  transform: `translateX(${props.modelValue * 100}%)`,
}));

const isSelected = (index: number) => index === props.modelValue;

const handleSelect = (index: number) => {
  if (index === props.modelValue) return;
  emit('update:modelValue', index);
};
</script>

<template>
  <div class="custom-tab-root" :class="props.class">
    <div class="custom-tab-track">
      <div class="custom-tab-slider" :style="sliderStyle"></div>
      <Button
        variant="unstyled"
        size="none"
        v-for="(label, index) in props.tabs"
        :key="label + index"
        type="button"
        class="custom-tab-item"
        :class="{ active: isSelected(index) }"
        @click="handleSelect(index)"
      >
        {{ label }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.custom-tab-root {
  width: 100%;
  height: 42px;
  padding: 4px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.custom-tab-track {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  align-items: center;
}

.custom-tab-slider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 9px;
  background: #ffffff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
  transition: transform 0.2s ease;
  z-index: 1;
}

.dark .custom-tab-slider {
  background: var(--color-primary);
  box-shadow: none;
}

.dark .custom-tab-root {
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
  border-color: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.custom-tab-item {
  position: relative;
  z-index: 2;
  height: 100%;
  font-size: 13px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 47%, transparent);
  border-radius: 9px;
  transition: color 0.2s ease;
}

.custom-tab-item:hover {
  color: color-mix(in srgb, var(--color-text-main) 85%, transparent);
}

.custom-tab-item.active {
  color: var(--color-primary);
}

.dark .custom-tab-item.active {
  color: #ffffff;
}

.dark .custom-tab-item:hover {
  color: color-mix(in srgb, #ffffff 88%, transparent);
}
</style>
