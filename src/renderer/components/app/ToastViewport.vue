<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { iconCheck, iconCircleAlert, iconCircleX, iconInfo, iconX } from '@/icons';
import { useToastStore, type ToastTone } from '@/stores/toast';

const props = withDefaults(
  defineProps<{
    lyricViewOpen?: boolean;
  }>(),
  {
    lyricViewOpen: false,
  },
);

const route = useRoute();
const toastStore = useToastStore();
const visibleToast = computed(() => toastStore.items[0] ?? null);
const titledMessage = computed(() => {
  const [reason, ...detail] = (visibleToast.value?.message ?? '').split('\n');
  return { reason, detail: detail.join('\n') };
});

const toneClassMap = {
  info: 'is-info',
  success: 'is-success',
  warning: 'is-warning',
  danger: 'is-danger',
} as const;

const toneIconMap = {
  info: iconInfo,
  success: iconCheck,
  warning: iconCircleAlert,
  danger: iconCircleX,
} as const;

const DEFAULT_BOTTOM = 24;
const ANCHOR_GAP = 12;
const VIEWPORT_EDGE_GAP = 12;
const MAX_VIEWPORT_WIDTH = 460;

const viewportLeft = ref(window.innerWidth / 2);
const viewportBottom = ref(DEFAULT_BOTTOM);
const viewportWidth = ref(Math.min(MAX_VIEWPORT_WIDTH, window.innerWidth - VIEWPORT_EDGE_GAP * 2));
let anchorObserver: ResizeObserver | null = null;
let anchorMutationObserver: MutationObserver | null = null;
let observedAnchor: HTMLElement | null = null;
let updateFrame: number | null = null;

const viewportStyle = computed(() => ({
  left: `${viewportLeft.value}px`,
  bottom: `${viewportBottom.value}px`,
  width: `${Math.max(220, viewportWidth.value)}px`,
}));

const isAnchorVisible = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height >= 24 && Number.parseFloat(style.opacity || '1') > 0.05;
};

const resolveAnchor = () => {
  if (props.lyricViewOpen) {
    const lyricAnchor = document.querySelector<HTMLElement>('[data-toast-anchor="lyric-player"]');
    return lyricAnchor && isAnchorVisible(lyricAnchor) ? lyricAnchor : null;
  }

  const mainAnchor = document.querySelector<HTMLElement>('[data-toast-anchor="main-player"]');
  return mainAnchor && isAnchorVisible(mainAnchor) ? mainAnchor : null;
};

const observeAnchor = (anchor: HTMLElement | null) => {
  if (anchor === observedAnchor) return;
  anchorObserver?.disconnect();
  observedAnchor = anchor;
  if (!anchor) return;
  anchorObserver = new ResizeObserver(schedulePositionUpdate);
  anchorObserver.observe(anchor);
};

const updatePosition = () => {
  updateFrame = null;
  const anchor = resolveAnchor();
  observeAnchor(anchor);

  if (!anchor) {
    viewportLeft.value = window.innerWidth / 2;
    viewportBottom.value = DEFAULT_BOTTOM;
    viewportWidth.value = Math.min(MAX_VIEWPORT_WIDTH, window.innerWidth - VIEWPORT_EDGE_GAP * 2);
    return;
  }

  const rect = anchor.getBoundingClientRect();
  viewportLeft.value = rect.left + rect.width / 2;
  viewportBottom.value = Math.max(DEFAULT_BOTTOM, window.innerHeight - rect.top + ANCHOR_GAP);
  viewportWidth.value = Math.min(
    MAX_VIEWPORT_WIDTH,
    rect.width - VIEWPORT_EDGE_GAP * 2,
    window.innerWidth - VIEWPORT_EDGE_GAP * 2,
  );
};

function schedulePositionUpdate() {
  if (updateFrame !== null) window.cancelAnimationFrame(updateFrame);
  updateFrame = window.requestAnimationFrame(updatePosition);
}

const containsToastAnchor = (node: Node) =>
  node instanceof Element &&
  (node.matches('[data-toast-anchor]') || Boolean(node.querySelector('[data-toast-anchor]')));

const runToastAction = (id: number) => {
  const item = toastStore.items.find((toast) => toast.id === id);
  if (!item?.action) return;
  try {
    item.action.handler();
  } finally {
    toastStore.remove(id);
  }
};

const pauseToast = (event: MouseEvent) => {
  toastStore.pause(Number((event.currentTarget as HTMLElement).dataset.toastId));
};
const resumeToast = (event: MouseEvent) => {
  toastStore.resume(Number((event.currentTarget as HTMLElement).dataset.toastId));
};
const resumeVisibleToast = () => {
  if (visibleToast.value) toastStore.resume(visibleToast.value.id);
};

const getToneLabel = (tone: ToastTone) => {
  if (tone === 'success') return '成功';
  if (tone === 'warning') return '警告';
  if (tone === 'danger') return '错误';
  return '提示';
};

watch(
  () => [props.lyricViewOpen, route.fullPath],
  async () => {
    await nextTick();
    schedulePositionUpdate();
  },
  { flush: 'post' },
);

watch(
  () => visibleToast.value?.id,
  async () => {
    await nextTick();
    schedulePositionUpdate();
  },
);

onMounted(() => {
  window.addEventListener('resize', schedulePositionUpdate);
  window.addEventListener('blur', resumeVisibleToast);
  anchorMutationObserver = new MutationObserver((records) => {
    const anchorChanged = records.some(
      (record) =>
        Array.from(record.addedNodes).some(containsToastAnchor) ||
        Array.from(record.removedNodes).some(containsToastAnchor),
    );
    if (anchorChanged) schedulePositionUpdate();
  });
  anchorMutationObserver.observe(document.body, { childList: true, subtree: true });
  schedulePositionUpdate();
});

onUnmounted(() => {
  window.removeEventListener('resize', schedulePositionUpdate);
  window.removeEventListener('blur', resumeVisibleToast);
  resumeVisibleToast();
  anchorObserver?.disconnect();
  anchorMutationObserver?.disconnect();
  if (updateFrame !== null) window.cancelAnimationFrame(updateFrame);
});
</script>

<template>
  <div
    class="toast-viewport pointer-events-none fixed z-5000 flex justify-center"
    :style="viewportStyle"
    aria-live="polite"
    aria-atomic="true"
  >
    <Transition name="toast-rise" mode="out-in">
      <div
        v-if="visibleToast"
        :key="visibleToast.id"
        :data-toast-id="visibleToast.id"
        :class="[
          toneClassMap[visibleToast.tone],
          `is-${visibleToast.variant}`,
          { 'has-action': visibleToast.action, 'has-title': visibleToast.title },
        ]"
        class="toast-card"
        role="status"
        :aria-label="`${visibleToast.title || getToneLabel(visibleToast.tone)}：${visibleToast.message}`"
        @mouseenter="pauseToast"
        @mouseleave="resumeToast"
      >
        <span class="toast-icon" aria-hidden="true">
          <Icon :icon="toneIconMap[visibleToast.tone]" width="16" height="16" />
        </span>

        <div class="toast-copy">
          <div v-if="visibleToast.title" class="toast-title">{{ visibleToast.title }}</div>
          <div class="toast-message">
            <template v-if="visibleToast.title">
              <div class="toast-reason">{{ titledMessage.reason }}</div>
              <div v-if="titledMessage.detail" class="toast-detail">{{ titledMessage.detail }}</div>
            </template>
            <template v-else>{{ visibleToast.message }}</template>
          </div>
        </div>

        <Button
          v-if="visibleToast.action"
          variant="primary"
          size="none"
          class="toast-action"
          @click="runToastAction(visibleToast.id)"
        >
          {{ visibleToast.action.label }}
        </Button>

        <Button
          v-if="visibleToast.variant === 'standard'"
          variant="unstyled"
          size="none"
          class="action-icon toast-close"
          aria-label="关闭提示"
          @click="toastStore.remove(visibleToast.id)"
        >
          <Icon :icon="iconX" width="14" height="14" />
        </Button>

        <span v-if="visibleToast.count > 1" :key="visibleToast.count" class="toast-count">
          ×{{ visibleToast.count }}
        </span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.toast-viewport {
  transform: translateX(-50%);
  transition:
    left 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.toast-card {
  @apply relative flex max-w-full items-center border shadow-lg;
  width: fit-content;
  color: var(--color-text-main);
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  border-color: var(--border-subtle);
  border-radius: var(--radius-popover);
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.14),
    0 2px 8px rgba(0, 0, 0, 0.08);
  user-select: none;
}

.toast-card.is-mini {
  @apply pointer-events-none h-9 gap-2 px-3;
  max-width: min(100%, 380px);
}

.toast-card.is-standard {
  @apply pointer-events-auto min-h-12 gap-3 px-4 py-3;
  border-color: color-mix(in srgb, var(--color-text-main) 20%, var(--border-subtle));
}

.toast-card.is-success {
  border-color: color-mix(in srgb, var(--state-success) 36%, var(--border-subtle));
}

.toast-card.is-warning {
  border-color: color-mix(in srgb, var(--state-warning) 40%, var(--border-subtle));
}

.toast-card.is-danger {
  border-color: color-mix(in srgb, var(--state-danger) 40%, var(--border-subtle));
}

.toast-card.is-standard.is-success {
  border-color: color-mix(in srgb, var(--state-success) 54%, var(--border-subtle));
}

.toast-card.is-standard.is-warning {
  border-color: color-mix(in srgb, var(--state-warning) 58%, var(--border-subtle));
}

.toast-card.is-standard.is-danger {
  border-color: color-mix(in srgb, var(--state-danger) 58%, var(--border-subtle));
}

.toast-card.has-title {
  align-items: flex-start;
  gap: 10px;
  min-width: min(320px, 100%);
  padding: 10px 14px;
}

.has-title .toast-close {
  margin-top: -2px;
}

.toast-icon {
  @apply flex h-5 w-5 shrink-0 items-center justify-center;
  border-radius: var(--radius-control);
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.is-success .toast-icon {
  color: var(--state-success);
  background: transparent;
}

.is-warning .toast-icon {
  color: var(--state-warning);
  background: transparent;
}

.is-danger .toast-icon {
  color: var(--state-danger);
  background: transparent;
}

.toast-copy {
  min-width: 0;
  flex: 1;
}

.toast-title {
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--text-main);
}

.toast-message {
  @apply min-w-0 text-[13px];
  color: var(--color-text-main);
  word-break: break-word;
}

.is-mini .toast-message {
  @apply truncate font-medium leading-5;
}

.is-standard .toast-message {
  @apply flex-1 leading-5;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.has-title .toast-message {
  display: block;
  white-space: pre-line;
  color: var(--text-secondary);
}

.toast-detail {
  font-size: 12px;
  line-height: 18px;
  color: var(--text-secondary);
}

.toast-close {
  @apply flex h-6 w-6 shrink-0 items-center justify-center transition;
  border-radius: var(--radius-control);
  color: var(--icon-main);
}

.toast-close:hover {
  color: var(--text-main);
  background: var(--control-hover-bg);
}

.toast-action {
  @apply h-7 shrink-0 px-2 text-[12px] font-semibold transition;
  border-radius: var(--radius-control);
}

.toast-count {
  @apply absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center px-1 text-[10px] font-bold leading-none;
  border-radius: var(--radius-detail);
  color: var(--color-on-primary);
  background: var(--color-primary);
  border: 2px solid var(--color-bg-elevated);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  animation: toast-count-bump 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.is-warning .toast-count {
  background: var(--state-warning);
}

.is-danger .toast-count {
  background: var(--state-danger);
}

.is-success .toast-count {
  background: var(--state-success);
}

.toast-rise-enter-active,
.toast-rise-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.toast-rise-enter-from,
.toast-rise-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@keyframes toast-count-bump {
  0% {
    transform: scale(0.72);
  }
  70% {
    transform: scale(1.12);
  }
  100% {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast-viewport,
  .toast-rise-enter-active,
  .toast-rise-leave-active {
    transition: none;
  }

  .toast-count {
    animation: none;
  }
}
</style>
