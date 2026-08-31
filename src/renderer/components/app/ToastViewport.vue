<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { iconCheck, iconInfo, iconTriangleAlert, iconX } from '@/icons';
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

const toneClassMap = {
  info: 'is-info',
  success: 'is-success',
  warning: 'is-warning',
  danger: 'is-danger',
} as const;

const toneIconMap = {
  info: iconInfo,
  success: iconCheck,
  warning: iconTriangleAlert,
  danger: iconTriangleAlert,
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
        :class="[
          toneClassMap[visibleToast.tone],
          `is-${visibleToast.variant}`,
          { 'has-action': visibleToast.action },
        ]"
        class="toast-card"
        role="status"
        :aria-label="`${getToneLabel(visibleToast.tone)}：${visibleToast.message}`"
        @mouseenter="toastStore.pause(visibleToast.id)"
        @mouseleave="toastStore.resume(visibleToast.id)"
      >
        <span class="toast-icon" aria-hidden="true">
          <Icon :icon="toneIconMap[visibleToast.tone]" width="16" height="16" />
        </span>

        <div class="toast-message">{{ visibleToast.message }}</div>

        <Button
          v-if="visibleToast.action"
          variant="unstyled"
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
          class="toast-close"
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
  @apply relative flex max-w-full items-center border shadow-lg backdrop-blur-md;
  width: fit-content;
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-bg-elevated) 94%, transparent);
  border-color: var(--border-subtle);
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.14),
    0 2px 8px rgba(0, 0, 0, 0.08);
  user-select: none;
}

.toast-card.is-mini {
  @apply pointer-events-none h-9 gap-2 rounded-full px-3;
  max-width: min(100%, 380px);
}

.toast-card.is-standard {
  @apply pointer-events-auto min-h-12 gap-3 rounded-2xl px-4 py-3;
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

.toast-icon {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded-full;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.is-success .toast-icon {
  color: var(--state-success);
  background: var(--state-success-bg-soft);
}

.is-warning .toast-icon {
  color: var(--state-warning);
  background: var(--state-warning-bg-soft);
}

.is-danger .toast-icon {
  color: var(--state-danger);
  background: var(--state-danger-bg-soft);
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

.toast-close {
  @apply flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-50 transition;
}

.toast-close:hover {
  @apply opacity-100;
  background: var(--control-hover-bg);
}

.toast-action {
  @apply h-7 shrink-0 rounded-lg px-2 text-[12px] font-semibold transition;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.toast-action:hover {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.toast-count {
  @apply absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none;
  color: white;
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
