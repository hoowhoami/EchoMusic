<script setup lang="ts">
import { ref, watch } from 'vue';
import Popover from './Popover.vue';
import Button from './Button.vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';
type Tone = 'primary' | 'danger';

interface Props {
  open?: boolean;
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: Tone;
  disabled?: boolean;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  side?: Placement;
  align?: Align;
  sideOffset?: number;
}

const props = withDefaults(defineProps<Props>(), {
  title: '确认操作',
  description: '',
  confirmText: '确认',
  cancelText: '取消',
  tone: 'primary',
  disabled: false,
  confirmDisabled: false,
  confirmLoading: false,
  side: 'top',
  align: 'center',
  sideOffset: 8,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const isOpen = ref(props.open ?? false);

watch(
  () => props.open,
  (value) => {
    if (value !== undefined) isOpen.value = value;
  },
);

const setOpen = (value: boolean) => {
  if ((value && props.disabled) || isOpen.value === value) return;
  isOpen.value = value;
  emit('update:open', value);
};

const handleCancel = () => {
  if (!isOpen.value) return;
  setOpen(false);
  emit('cancel');
};

const handleConfirm = () => {
  if (!isOpen.value || props.disabled || props.confirmDisabled || props.confirmLoading) return;
  setOpen(false);
  emit('confirm');
};
</script>

<template>
  <Popover
    :open="isOpen"
    @update:open="setOpen"
    trigger="click"
    :side="side"
    :align="align"
    :side-offset="sideOffset"
    :disabled="disabled"
    content-class="echo-popconfirm-content"
  >
    <template #trigger>
      <slot name="trigger" />
    </template>

    <div class="popconfirm" role="alertdialog" :aria-label="title">
      <div class="popconfirm-message">
        <span class="popconfirm-icon" aria-hidden="true">!</span>
        <div class="popconfirm-copy">
          <div class="popconfirm-title">
            <slot name="title">{{ title }}</slot>
          </div>
          <div v-if="$slots.description || description" class="popconfirm-description">
            <slot name="description">{{ description }}</slot>
          </div>
        </div>
      </div>
      <div class="popconfirm-actions">
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="popconfirm-action popconfirm-cancel app-focus-ring-soft"
          @click.stop="handleCancel"
        >
          {{ cancelText }}
        </Button>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          :class="[
            'popconfirm-action popconfirm-confirm app-focus-ring-soft',
            tone === 'danger' && 'is-danger',
          ]"
          :disabled="confirmDisabled"
          :loading="confirmLoading"
          @click.stop="handleConfirm"
        >
          {{ confirmText }}
        </Button>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
@reference "@/style.css";

:global(.echo-popconfirm-content.echo-popover-content) {
  --popover-background: var(--floating-surface-bg);
  padding: 0;
  border-radius: 12px;
  background: var(--popover-background);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  box-shadow: var(--shadow-elevated);
}

:global(.echo-popconfirm-content .echo-popover-arrow) {
  fill: var(--popover-background);
}

.popconfirm {
  width: max-content;
  min-width: 260px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 16px 18px;
}

.popconfirm-message {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.popconfirm-icon {
  width: 20px;
  height: 20px;
  margin-top: 1px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--state-warning);
  color: var(--color-bg-elevated);
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
}

.popconfirm-copy {
  min-width: 0;
}

.popconfirm-title {
  color: var(--color-text-main);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.45;
  white-space: normal;
}

.popconfirm-description {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.55;
  white-space: normal;
}

.popconfirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.popconfirm-action {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease,
    transform 0.12s ease,
    opacity 0.16s ease;
}

.popconfirm-action:active:not(:disabled) {
  transform: scale(0.98);
}

.popconfirm-action:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.popconfirm-cancel {
  border: 1px solid var(--control-border);
  background: transparent;
  color: var(--color-text-main);
}

.popconfirm-cancel:hover {
  background: var(--control-muted-bg);
}

.popconfirm-confirm {
  border: 1px solid transparent;
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.popconfirm-confirm:hover {
  background: var(--color-primary-hover);
  color: var(--color-on-primary-hover);
}

.popconfirm-confirm.is-danger {
  background: var(--state-danger);
  color: var(--color-bg-elevated);
}

.popconfirm-confirm.is-danger:hover {
  background: color-mix(in srgb, var(--state-danger) 86%, var(--color-text-main));
}
</style>
