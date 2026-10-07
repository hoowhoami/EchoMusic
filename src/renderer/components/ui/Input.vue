<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useVModel } from '@vueuse/core';
import { type PrimitiveProps } from 'reka-ui';
import { iconX } from '@/icons';

defineOptions({ inheritAttrs: false });

interface Props extends PrimitiveProps {
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  class?: string;
  inputClass?: string;
  showClear?: boolean;
  disabled?: boolean;
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  as: 'input',
  type: 'text',
  showClear: true,
});

const emits = defineEmits(['update:modelValue', 'clear']);

const value = useVModel(props, 'modelValue', emits);
const attrs = useAttrs();
const inputRef = ref<HTMLInputElement | null>(null);
const canClear = computed(
  () =>
    props.showClear &&
    !props.disabled &&
    !props.readonly &&
    value.value !== '' &&
    value.value !== undefined &&
    value.value !== null,
);

const handleClear = () => {
  if (!canClear.value || inputRef.value?.matches(':disabled')) return;
  value.value = '';
  emits('clear');
  inputRef.value?.focus({ preventScroll: true });
};
</script>

<template>
  <div :class="['relative group w-full', props.class]">
    <input
      ref="inputRef"
      v-model="value"
      v-bind="attrs"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :class="[
        'echo-input-control w-full h-14 pl-6 pr-12 bg-[var(--field-bg)] border-0 rounded-control outline-none motion-control-feedback font-medium text-[15px] text-text-main placeholder:text-text-secondary placeholder:opacity-100',
        props.inputClass,
      ]"
    />

    <!-- 清除图标按钮 -->
    <button
      v-if="canClear"
      type="button"
      aria-label="清空输入"
      class="action-icon absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6 flex items-center justify-center icon-action motion-control-feedback"
      @click="handleClear"
    >
      <Icon :icon="iconX" width="14" height="14" />
    </button>
  </div>
</template>

<style scoped>
.echo-input-control:hover:not(:disabled):not(:focus) {
  background: var(--field-hover-bg);
}

.echo-input-control:focus:not(:disabled) {
  background: var(--field-focus-bg);
}

.echo-input-control[aria-invalid='true'],
.echo-input-control[aria-invalid='true']:focus,
.echo-input-control[aria-invalid='true']:hover:not(:disabled) {
  background: var(--control-danger-bg);
}
</style>
