<script setup lang="ts">
import { useVModel } from '@vueuse/core';
import { type PrimitiveProps } from 'reka-ui';
import Button from '@/components/ui/Button.vue';
import { iconX } from '@/icons';

interface Props extends PrimitiveProps {
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  class?: string;
  inputClass?: string;
  showClear?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  as: 'input',
  type: 'text',
  showClear: true,
});

const emits = defineEmits(['update:modelValue', 'clear']);

const value = useVModel(props, 'modelValue', emits);

const handleClear = () => {
  value.value = '';
  emits('clear');
};
</script>

<template>
  <div :class="['relative group w-full', props.class]">
    <input
      v-model="value"
      :type="type"
      :placeholder="placeholder"
      :class="[
        'w-full h-14 pl-6 pr-12 bg-black/[0.03] dark:bg-white/[0.03] border border-transparent rounded-2xl outline-none transition-all font-medium text-[15px] placeholder:opacity-50',
        props.inputClass,
      ]"
    />

    <!-- 清除图标按钮 -->
    <Button
      v-if="showClear && value"
      @click="handleClear"
      type="button"
      variant="ghost"
      size="xs"
      class="absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6 min-w-0 p-0 text-text-main opacity-40 hover:opacity-70"
    >
      <Icon :icon="iconX" width="14" height="14" />
    </Button>
  </div>
</template>
