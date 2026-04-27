<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';

defineOptions({
  inheritAttrs: false,
});

interface Props {
  hideScrollbar?: boolean;
  scrollbarInset?: number;
  contentProps?: Record<string, unknown> | null;
}

type ContentRefTarget =
  | ((el: HTMLElement | null) => void)
  | { value: HTMLElement | null }
  | null
  | undefined;

const props = withDefaults(defineProps<Props>(), {
  hideScrollbar: false,
  scrollbarInset: 6,
  contentProps: null,
});
const emit = defineEmits<{
  (e: 'scroll', event: Event): void;
}>();
const attrs = useAttrs();

const scrollAreaRef = ref<HTMLElement | null>(null);
const wrapRef = ref<HTMLElement | null>(null);
const viewRef = ref<HTMLElement | null>(null);
const scrollbarRef = ref<HTMLElement | null>(null);
const thumbRef = ref<HTMLElement | null>(null);

const scrollTop = ref(0);
const scrollHeight = ref(0);
const clientHeight = ref(0);
const isDragging = ref(false);
const dragStartY = ref(0);
const dragStartScrollTop = ref(0);
const isHovering = ref(false);
const autoHideTimer = ref<number | null>(null);
let measureFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let observedChild: Element | null = null;

const effectiveScrollbarInset = computed(() => Math.max(0, props.scrollbarInset));

const showScrollbar = computed(() => {
  if (props.hideScrollbar) return false;
  return scrollHeight.value > clientHeight.value;
});

const contentRefTarget = computed<ContentRefTarget>(() => {
  const maybeRef = props.contentProps?.ref;
  if (typeof maybeRef === 'function') return maybeRef as (el: HTMLElement | null) => void;
  if (maybeRef && typeof maybeRef === 'object' && 'value' in maybeRef) {
    return maybeRef as { value: HTMLElement | null };
  }
  return null;
});

const contentAttrs = computed(() => {
  const source = props.contentProps ?? {};
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'ref'));
});

const assignContentRef = (target: ContentRefTarget, el: HTMLElement | null) => {
  if (!target) return;
  if (typeof target === 'function') {
    target(el);
    return;
  }
  target.value = el;
};

const setContentRef = (target: Element | ComponentPublicInstance | null) => {
  const el = target instanceof HTMLElement ? target : null;
  wrapRef.value = el;
  assignContentRef(contentRefTarget.value, el);
};

const setViewRef = (target: Element | ComponentPublicInstance | null) => {
  viewRef.value = target instanceof HTMLElement ? target : null;
};

const scrollTo = (options: ScrollToOptions) => {
  wrapRef.value?.scrollTo(options);
};

const setScrollTop = (value: number) => {
  const wrap = wrapRef.value;
  if (!wrap) return;
  wrap.scrollTop = value;
  updateScrollMetrics();
};

const update = () => {
  updateScrollMetrics();
};

defineExpose({
  wrapRef,
  update,
  scrollTo,
  setScrollTop,
});

const thumbHeight = computed(() => {
  if (scrollHeight.value === 0) return 0;
  const trackHeight = Math.max(0, clientHeight.value - effectiveScrollbarInset.value * 2);
  if (trackHeight === 0) return 0;
  const ratio = clientHeight.value / scrollHeight.value;
  return Math.min(trackHeight, Math.max(30, trackHeight * ratio));
});

const thumbTop = computed(() => {
  if (scrollHeight.value === 0) return 0;
  const maxScroll = scrollHeight.value - clientHeight.value;
  if (maxScroll === 0) return effectiveScrollbarInset.value;
  const trackHeight = Math.max(0, clientHeight.value - effectiveScrollbarInset.value * 2);
  if (trackHeight === 0) return effectiveScrollbarInset.value;
  const ratio = scrollTop.value / maxScroll;
  const maxThumbOffset = Math.max(0, trackHeight - thumbHeight.value);
  return effectiveScrollbarInset.value + ratio * maxThumbOffset;
});

const updateScrollMetrics = () => {
  const wrap = wrapRef.value;
  if (!wrap) return;
  scrollTop.value = wrap.scrollTop;
  scrollHeight.value = wrap.scrollHeight;
  clientHeight.value = wrap.clientHeight;
};

const scheduleUpdate = () => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    updateScrollMetrics();
  });
};

const disconnectObservers = () => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
  observedChild = null;
};

const connectObservers = () => {
  disconnectObservers();
  if (!wrapRef.value) return;

  resizeObserver = new ResizeObserver(() => {
    scheduleUpdate();
  });
  resizeObserver.observe(wrapRef.value);
  if (scrollAreaRef.value && scrollAreaRef.value !== wrapRef.value) {
    resizeObserver.observe(scrollAreaRef.value);
  }

  observedChild = viewRef.value ?? wrapRef.value.firstElementChild;
  if (observedChild) {
    resizeObserver.observe(observedChild);
  }

  mutationObserver = new MutationObserver(() => {
    const nextChild = viewRef.value ?? wrapRef.value?.firstElementChild ?? null;
    if (resizeObserver && nextChild !== observedChild) {
      if (observedChild) {
        resizeObserver.unobserve(observedChild);
      }
      if (nextChild) {
        resizeObserver.observe(nextChild);
      }
      observedChild = nextChild;
    }
    scheduleUpdate();
  });
  mutationObserver.observe(wrapRef.value, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
};

const clearAutoHideTimer = () => {
  if (autoHideTimer.value !== null) {
    clearTimeout(autoHideTimer.value);
    autoHideTimer.value = null;
  }
};

const scheduleAutoHide = () => {
  clearAutoHideTimer();
  autoHideTimer.value = window.setTimeout(() => {
    if (!isDragging.value) {
      isHovering.value = false;
    }
    autoHideTimer.value = null;
  }, 1500);
};

const handleScroll = (event: Event) => {
  updateScrollMetrics();

  // 滚动时显示滚动条
  isHovering.value = true;
  scheduleAutoHide();
  emit('scroll', event);
};

const handleScrollAreaMouseEnter = () => {
  updateScrollMetrics();
  isHovering.value = true;
  clearAutoHideTimer();
};

const handleScrollAreaMouseLeave = () => {
  if (!isDragging.value) {
    scheduleAutoHide();
  }
};

const handleThumbMouseDown = (e: MouseEvent) => {
  e.preventDefault();
  isDragging.value = true;
  dragStartY.value = e.clientY;
  dragStartScrollTop.value = scrollTop.value;
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
};

const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging.value || !wrapRef.value) return;

  const deltaY = e.clientY - dragStartY.value;
  const maxScroll = scrollHeight.value - clientHeight.value;
  const trackHeight = Math.max(0, clientHeight.value - effectiveScrollbarInset.value * 2);
  const maxThumbOffset = Math.max(1, trackHeight - thumbHeight.value);
  const scrollDelta = (deltaY / maxThumbOffset) * maxScroll;

  setScrollTop(dragStartScrollTop.value + scrollDelta);
};

const handleMouseUp = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);

  // 拖动结束后延迟隐藏
  scheduleAutoHide();
};

const handleScrollbarMouseEnter = () => {
  isHovering.value = true;
  clearAutoHideTimer();
};

const handleScrollbarMouseLeave = () => {
  if (!isDragging.value) {
    scheduleAutoHide();
  }
};

const handleTrackClick = (e: MouseEvent) => {
  if (!wrapRef.value || !scrollbarRef.value) return;
  if (e.target === thumbRef.value) return;

  const rect = scrollbarRef.value.getBoundingClientRect();
  const trackHeight = Math.max(0, clientHeight.value - effectiveScrollbarInset.value * 2);
  if (trackHeight === 0) return;
  const clickY = Math.max(
    0,
    Math.min(trackHeight, e.clientY - rect.top - effectiveScrollbarInset.value),
  );
  const maxScroll = scrollHeight.value - clientHeight.value;
  const maxThumbOffset = Math.max(1, trackHeight - thumbHeight.value);
  const thumbCenter = thumbHeight.value / 2;
  const targetScrollTop = ((clickY - thumbCenter) / maxThumbOffset) * maxScroll;

  wrapRef.value.scrollTo({
    top: Math.max(0, Math.min(maxScroll, targetScrollTop)),
    behavior: 'smooth',
  });
};

onMounted(() => {
  connectObservers();
  void nextTick(() => {
    scheduleUpdate();
  });
});

onBeforeUnmount(() => {
  assignContentRef(contentRefTarget.value, null);
  clearAutoHideTimer();
  disconnectObservers();
  if (measureFrame) {
    cancelAnimationFrame(measureFrame);
    measureFrame = 0;
  }
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
});

watch(
  () => props.hideScrollbar,
  () => {
    if (props.hideScrollbar) {
      isHovering.value = false;
    }
  },
);

watch(
  () => wrapRef.value,
  () => {
    connectObservers();
    void nextTick(() => {
      scheduleUpdate();
    });
  },
);

watch(
  () => props.contentProps,
  () => {
    void nextTick(() => {
      connectObservers();
      scheduleUpdate();
    });
  },
  { deep: true },
);
</script>

<template>
  <div
    ref="scrollAreaRef"
    class="scroll-area"
    v-bind="attrs"
    @mouseenter="handleScrollAreaMouseEnter"
    @mouseleave="handleScrollAreaMouseLeave"
  >
    <div :ref="setContentRef" class="scrollbar-wrap" v-bind="contentAttrs" @scroll="handleScroll">
      <div :ref="setViewRef" class="scrollbar-view">
        <slot />
      </div>
    </div>

    <Transition name="scrollbar-fade">
      <div
        v-if="showScrollbar && isHovering"
        ref="scrollbarRef"
        class="scrollbar"
        @mouseenter="handleScrollbarMouseEnter"
        @mouseleave="handleScrollbarMouseLeave"
        @click="handleTrackClick"
      >
        <div
          ref="thumbRef"
          class="scrollbar-thumb"
          :style="{
            height: `${thumbHeight}px`,
            transform: `translateY(${thumbTop}px)`,
          }"
          @mousedown="handleThumbMouseDown"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.scroll-area {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.scrollbar-wrap {
  flex: 1 1 auto;
  width: 100%;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.scrollbar-view {
  min-width: 0;
  box-sizing: border-box;
  min-height: 100%;
}

.scrollbar-wrap::-webkit-scrollbar {
  display: none;
}

.scrollbar {
  position: absolute;
  top: 0;
  right: 0;
  width: 12px;
  height: 100%;
  padding: v-bind('`${effectiveScrollbarInset}px 2px`');
  box-sizing: border-box;
  z-index: 160;
  pointer-events: auto;
}

.scrollbar-thumb {
  width: 4px;
  margin-left: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  cursor: pointer;
  transition:
    background 0.2s ease,
    width 0.2s ease;
  will-change: transform;
}

.dark .scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
}

.scrollbar-thumb:hover,
.scrollbar-thumb:active {
  width: 8px;
  background: rgba(0, 0, 0, 0.5);
}

.dark .scrollbar-thumb:hover,
.dark .scrollbar-thumb:active {
  background: rgba(255, 255, 255, 0.5);
}

.scrollbar-fade-enter-active,
.scrollbar-fade-leave-active {
  transition: opacity 0.2s ease;
}

.scrollbar-fade-enter-from,
.scrollbar-fade-leave-to {
  opacity: 0;
}
</style>
