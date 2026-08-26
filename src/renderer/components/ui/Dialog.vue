<script setup lang="ts">
import { computed, useSlots } from 'vue';
import type { StyleValue } from 'vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { useDialogStack } from '@/components/ui/dialogStack';
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
  /** 内容样式；zIndex 由全局弹窗栈统一管理，传入该属性不会覆盖层级。 */
  contentStyle?: Record<string, string | number>;
  descriptionClass?: string;
  bodyClass?: string;
  noScroll?: boolean;
  flushBody?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  showClose: false,
  modal: true,
  closeOnEscape: true,
  closeOnInteractOutside: true,
  noScroll: false,
  flushBody: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const slots = useSlots();
const {
  activationKey,
  presenceElement,
  isTop,
  isInteractive,
  overlayZIndex,
  contentZIndex,
  finishClose,
} = useDialogStack(open);

const hasTitle = computed(() => Boolean(props.title) || Boolean(slots.title));
const hasDescription = computed(() => Boolean(props.description) || Boolean(slots.description));
const hasFooter = computed(() => Boolean(slots.footer));
const hasBody = computed(() => Boolean(slots.default));

const overlayClass = computed(() => ['dialog-overlay', props.overlayClass]);
const contentClass = computed(() => ['dialog-content', props.contentClass]);
const computedDescriptionClass = computed(() => ['dialog-description', props.descriptionClass]);
const computedBodyClass = computed(() => [
  'dialog-body',
  props.flushBody ? 'dialog-body-flush' : null,
  hasDescription.value ? 'mt-2' : null,
  props.bodyClass,
]);
const overlayStyle = computed<StyleValue>(() => ({ zIndex: overlayZIndex.value }));
const contentStyle = computed<StyleValue>(() => [
  props.contentStyle,
  { zIndex: contentZIndex.value },
]);

const handleEscapeKeyDown = (event: Event) => {
  if (!isInteractive.value || !props.closeOnEscape) {
    event.preventDefault();
  }
};

const handleInteractOutside = (event: Event) => {
  if (!isInteractive.value || !props.closeOnInteractOutside) {
    event.preventDefault();
  }
};
</script>

<template>
  <DialogRoot v-model:open="open" :modal="props.modal">
    <DialogPortal>
      <DialogOverlay as-child>
        <div
          :class="overlayClass"
          :style="overlayStyle"
          :data-dialog-stack-top="isTop ? '' : undefined"
          :data-dialog-stack-interactive="isInteractive ? 'true' : 'false'"
        />
      </DialogOverlay>

      <DialogContent
        :key="activationKey"
        as-child
        @escape-key-down="handleEscapeKeyDown"
        @interact-outside="handleInteractOutside"
      >
        <div
          :class="contentClass"
          :style="contentStyle"
          :aria-hidden="isInteractive ? undefined : 'true'"
          :inert="isInteractive ? undefined : true"
          :data-dialog-stack-top="isTop ? '' : undefined"
          :data-dialog-stack-interactive="isInteractive ? 'true' : 'false'"
          @after-leave="finishClose"
        >
          <!--
            Reka as-child 会接管外层节点的 ref；内部哨兵用于跟踪 Presence 实际挂载状态。
            动画中重开会因 activationKey 销毁旧节点，可能不触发 after-leave，哨兵 ref
            的卸载回调是这种情况以及父级直接卸载时的必要兜底。
          -->
          <span ref="presenceElement" hidden aria-hidden="true" />

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
          <Scrollbar
            v-if="!props.noScroll"
            class="flex-1 min-h-0 mt-2"
            :scrollbar-right-inset="1"
            :content-props="{ class: 'dialog-scroll-area' }"
          >
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

          <!-- noScroll 模式：不包裹 Scrollbar，由内容自行管理滚动 -->
          <template v-else>
            <VisuallyHidden>
              <DialogDescription>
                <slot v-if="hasDescription" name="description">{{ props.description }}</slot>
                <template v-else>对话框内容</template>
              </DialogDescription>
            </VisuallyHidden>
            <div v-if="hasBody" :class="[computedBodyClass, 'flex-1 min-h-0']">
              <slot />
            </div>
          </template>

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
  @apply fixed inset-0;
  background: var(--surface-overlay-bg);
  opacity: 0;
}

:global(.dialog-overlay[data-state='open']) {
  opacity: 1;
  animation: dialog-overlay-in 160ms ease-out both;
  -webkit-app-region: no-drag;
}

:global(.dialog-overlay[data-state='closed']) {
  opacity: 0;
  animation: dialog-overlay-out 140ms ease-in both;
}

:global(.dialog-content) {
  @apply fixed left-1/2 top-[46%] w-[420px] max-w-[92vw] rounded-2xl border flex flex-col select-none;
  @apply max-h-[calc(100vh-240px)];
  background: var(--color-bg-dialog);
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-dialog);
  /* 右侧留白由标题、正文和页脚承担；滚动区延伸到边缘，滑块右侧间距统一由 Scrollbar 控制。 */
  padding: 24px 0 24px 24px;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
  will-change: transform, opacity;
}

:global(.dialog-overlay[data-dialog-stack-interactive='false']),
:global(.dialog-content[data-dialog-stack-interactive='false']) {
  pointer-events: none !important;
}

:global(.dialog-content[data-state='open']) {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
  animation: dialog-content-in 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
  -webkit-app-region: no-drag;
}

:global(.dialog-content[data-state='closed']) {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
  animation: dialog-content-out 140ms cubic-bezier(0.4, 0, 1, 1) both;
}

@keyframes dialog-overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes dialog-overlay-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes dialog-content-in {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes dialog-content-out {
  from {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.98);
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(.dialog-overlay[data-state]),
  :global(.dialog-content[data-state]) {
    animation: none;
  }
}

:global(.dialog-content.detail-intro-dialog) {
  /* 简介以舒适阅读行长为主，避免大屏下文本横向铺得过宽。 */
  width: min(560px, 92vw);
  max-width: 92vw;
  max-height: min(760px, calc(100vh - 160px));
}

.dialog-header {
  @apply pb-2 pr-6; /* 标题与正文、页脚统一保留 24px 右侧留白。 */
}

.dialog-title {
  @apply text-lg font-bold text-text-main;
}

.dialog-description {
  @apply text-sm text-text-secondary whitespace-pre-wrap leading-relaxed pr-6;
}

.dialog-body {
  @apply text-sm text-text-main pr-6;
}

.dialog-body-flush {
  @apply pr-0;
}

.dialog-footer {
  @apply flex justify-end gap-3 pt-4 pr-6;
}

.dialog-close {
  @apply absolute top-4 right-4 h-8 w-8 min-w-0 p-0 text-text-main/50 hover:text-text-main z-10;
}
</style>
