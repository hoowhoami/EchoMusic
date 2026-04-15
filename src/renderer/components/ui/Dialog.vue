<script setup lang="ts">
import { computed, useSlots } from 'vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { useVModel } from '@vueuse/core';
import { iconX } from '@/icons';
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogClose,
  VisuallyHidden,
} from 'reka-ui';

interface Props {
  open?: boolean;
  title?: string;
  description?: string;
  showClose?: boolean;
  modal?: boolean;
  closeOnEscape?: boolean;
  closeOnInteractOutside?: boolean;
  overlayClass?: string;
  contentClass?: string;
  contentStyle?: Record<string, string | number>;
  descriptionClass?: string;
  bodyClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  showClose: false,
  modal: true,
  closeOnEscape: true,
  closeOnInteractOutside: true,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const slots = useSlots();

const hasTitle = computed(() => Boolean(props.title) || Boolean(slots.title));
const hasDescription = computed(() => Boolean(props.description) || Boolean(slots.description));
const hasFooter = computed(() => Boolean(slots.footer));
const hasBody = computed(() => Boolean(slots.default));

const overlayClass = computed(() => ['dialog-overlay', props.overlayClass]);
const contentClass = computed(() => ['dialog-content', props.contentClass]);
const computedDescriptionClass = computed(() => ['dialog-description', props.descriptionClass]);
const computedBodyClass = computed(() => [
  'dialog-body',
  hasDescription.value ? 'mt-2' : null,
  props.bodyClass,
]);

const handleEscapeKeyDown = (event: Event) => {
  if (!props.closeOnEscape) {
    event.preventDefault();
  }
};

const handleInteractOutside = (event: Event) => {
  if (!props.closeOnInteractOutside) {
    event.preventDefault();
  }
};
</script>

<template>
  <DialogRoot v-model:open="open" :modal="props.modal">
    <DialogPortal>
      <DialogOverlay as-child>
        <div :class="overlayClass" />
      </DialogOverlay>

      <DialogContent
        as-child
        @escape-key-down="handleEscapeKeyDown"
        @interact-outside="handleInteractOutside"
      >
        <div :class="contentClass" :style="props.contentStyle">
          <!-- 关闭按钮 -->
          <DialogClose v-if="props.showClose" as-child>
            <Button class="dialog-close" variant="ghost" size="xs" type="button" aria-label="关闭">
              <Icon :icon="iconX" width="14" height="14" />
            </Button>
          </DialogClose>

          <!-- 固定头部：标题 -->
          <div v-if="hasTitle" class="dialog-header shrink-0">
            <DialogTitle as-child>
              <h3 class="dialog-title">
                <slot name="title">{{ props.title }}</slot>
              </h3>
            </DialogTitle>
          </div>
          <VisuallyHidden v-else>
            <DialogTitle>对话框</DialogTitle>
          </VisuallyHidden>

          <!-- 可滚动区域：描述 + 内容 -->
          <Scrollbar class="flex-1 min-h-0 mt-2" :content-props="{ class: 'dialog-scroll-area' }">
            <template v-if="hasDescription">
              <DialogDescription as-child>
                <p :class="computedDescriptionClass">
                  <slot name="description">{{ props.description }}</slot>
                </p>
              </DialogDescription>
            </template>
            <VisuallyHidden v-else>
              <DialogDescription>对话框内容</DialogDescription>
            </VisuallyHidden>

            <div v-if="hasBody" :class="computedBodyClass">
              <slot />
            </div>
          </Scrollbar>

          <!-- 固定底部：页脚 -->
          <div v-if="hasFooter" class="dialog-footer shrink-0">
            <slot name="footer" />
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-overlay) {
  @apply fixed inset-0 bg-black/30 backdrop-blur-[1px] z-[200];
  opacity: 0;
  transition: opacity 0.16s ease-out;
}

:global(.dialog-overlay[data-state='open']) {
  opacity: 1;
}

:global(.dialog-overlay[data-state='closed']) {
  opacity: 0;
}

:global(.dialog-content) {
  @apply fixed left-1/2 top-[46%] z-[210] w-[420px] max-w-[92vw] rounded-2xl bg-bg-main border border-border-light/40 shadow-2xl flex flex-col;
  @apply max-h-[calc(100vh-240px)];
  /* 将右侧内边距设为 2px，使滚动条紧贴边缘 */
  padding: 24px 2px 24px 24px;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
  transition:
    opacity 0.18s ease-out,
    transform 0.18s ease-out;
  will-change: transform, opacity;
}

:global(.dialog-content[data-state='open']) {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

:global(.dialog-content[data-state='closed']) {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
}

:global(.dialog-content.detail-intro-dialog) {
  left: calc(var(--drawer-content-left, 0px) + (var(--drawer-content-width, 100vw) / 2));
  top: calc(var(--drawer-content-top, 0px) + (var(--drawer-content-height, 100vh) / 2));
  width: min(720px, calc(var(--drawer-content-width, 100vw) - 40px));
  max-width: calc(var(--drawer-content-width, 100vw) - 40px);
  max-height: min(760px, calc(var(--drawer-content-height, 100vh) - 24px));
}

.dialog-header {
  @apply pb-2 pr-6; /* pr-6 补偿 content 的 24px 边距 */
}

.dialog-title {
  @apply text-lg font-bold text-text-main;
}

.dialog-description {
  @apply text-sm text-text-secondary whitespace-pre-wrap leading-relaxed pr-4;
}

.dialog-body {
  @apply text-sm text-text-main pr-4;
}

.dialog-footer {
  @apply flex justify-end gap-3 pt-4 pr-6;
}

.dialog-close {
  @apply absolute top-4 right-4 h-8 w-8 min-w-0 p-0 text-text-main/50 hover:text-text-main z-10;
}
</style>
