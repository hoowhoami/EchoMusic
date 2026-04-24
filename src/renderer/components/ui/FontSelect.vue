<script setup lang="ts">
/**
 * 字体选择器 — 基于 Select 的 filterable 模式
 * 每个选项用对应字体渲染预览
 */
import Select from './Select.vue';

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
</script>

<template>
  <Select
    :model-value="props.modelValue"
    :options="props.options"
    :placeholder="props.placeholder"
    :class="props.class"
    filterable
    @update:model-value="emit('update:modelValue', String($event))"
  />
</template>
