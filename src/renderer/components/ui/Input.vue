<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useVModel } from '@vueuse/core';
import { type PrimitiveProps } from 'reka-ui';
import { iconX } from '@/icons';
import type { ControlSize } from './controlSizes';

defineOptions({ inheritAttrs: false });

interface Props extends PrimitiveProps {
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  class?: string;
  inputClass?: string;
  size?: ControlSize;
  showClear?: boolean;
  disabled?: boolean;
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  as: 'input',
  type: 'text',
  showClear: true,
  size: 'default',
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
  <div :class="['echo-input-wrapper relative group w-full', `echo-field-${size}`, props.class]">
    <input
      ref="inputRef"
      v-model="value"
      v-bind="attrs"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :class="[
        'echo-input-control echo-field-sized w-full bg-[var(--field-bg)] border-0 rounded-control outline-none motion-control-feedback text-text-main placeholder:text-text-secondary placeholder:opacity-100',
        { 'has-clear-action': showClear },
        props.inputClass,
      ]"
    />

    <!-- 清除图标按钮 -->
    <button
      v-if="canClear"
      type="button"
      aria-label="清空输入"
      class="action-icon echo-input-clear absolute top-1/2 -translate-y-1/2 flex items-center justify-center icon-action motion-control-feedback"
      @click="handleClear"
    >
      <Icon :icon="iconX" width="14" height="14" />
    </button>
  </div>
</template>

<style scoped>
.echo-input-control {
  padding: 0 var(--field-padding-x);
}

.echo-input-control.has-clear-action {
  padding-right: calc(var(--field-padding-x) + var(--field-clear-size));
}

.echo-input-clear {
  right: var(--field-clear-right);
  width: var(--field-clear-size);
  height: var(--field-clear-size);
}

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
