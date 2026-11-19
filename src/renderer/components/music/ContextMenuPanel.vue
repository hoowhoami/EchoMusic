<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

/**
 * 右键菜单外壳（全站唯一一份）：定位夹取、外部点击/Esc/滚动关闭、打开时锁滚动都由这里处理。
 * 菜单项与文案由调用方通过默认插槽传入，类名沿用 song-context-item / song-context-separator。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    x: number;
    y: number;
    /** 打开期间要锁住滚动的元素：列表自己的滚动体，避免菜单开着时列表跟着滚。 */
    scrollLockEl?: HTMLElement | null;
    /** 量不到菜单宽度时的兜底宽度。 */
    fallbackWidth?: number;
  }>(),
  { scrollLockEl: null, fallbackWidth: 180 },
);

const emit = defineEmits<{ (event: 'close'): void }>();

const MENU_PADDING = 8;
const MENU_BOTTOM_PADDING = 96;

const menuRef = ref<HTMLElement | null>(null);
const position = ref({ x: props.x, y: props.y });
const menuStyle = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }));

const place = () => {
  const menu = menuRef.value;
  const width = menu?.offsetWidth || props.fallbackWidth;
  const height = menu?.offsetHeight || 0;
  const maxX = Math.max(MENU_PADDING, window.innerWidth - width - MENU_PADDING);
  const maxY = Math.max(MENU_PADDING, window.innerHeight - height - MENU_BOTTOM_PADDING);
  position.value = {
    x: Math.round(Math.min(Math.max(props.x, MENU_PADDING), maxX)),
    y: Math.round(Math.min(Math.max(props.y, MENU_PADDING), maxY)),
  };
};

const handlePointerDown = (event: PointerEvent) => {
  const target = event.target as Node | null;
  if (target && menuRef.value?.contains(target)) return;
  emit('close');
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  emit('close');
};

const handleViewportChange = (event: Event) => {
  // 菜单自己内部滚动不算，只有页面/视口变化才收起。
  if (event.type === 'scroll' && menuRef.value?.contains(event.target as Node)) return;
  emit('close');
};

let restoreScrollLock: (() => void) | null = null;

const lockScroll = () => {
  const el = props.scrollLockEl;
  if (!el) return;
  const previous = el.style.overflow;
  el.style.overflow = 'hidden';
  restoreScrollLock = () => {
    if (el.style.overflow === 'hidden') el.style.overflow = previous;
  };
};

const releaseScrollLock = () => {
  restoreScrollLock?.();
  restoreScrollLock = null;
};

const bindListeners = () => {
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
};

const unbindListeners = () => {
  document.removeEventListener('pointerdown', handlePointerDown, true);
  document.removeEventListener('keydown', handleKeydown, true);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
};

watch(
  () => props.open,
  async (open) => {
    if (open) {
      position.value = { x: props.x, y: props.y };
      lockScroll();
      bindListeners();
      await nextTick();
      if (!props.open) return;
      place();
      return;
    }
    unbindListeners();
    releaseScrollLock();
  },
);

watch(
  () => [props.x, props.y] as const,
  async () => {
    if (!props.open) return;
    position.value = { x: props.x, y: props.y };
    await nextTick();
    if (!props.open) return;
    place();
  },
);

onBeforeUnmount(() => {
  unbindListeners();
  releaseScrollLock();
});

defineExpose({ place });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="song-context-menu"
      :style="menuStyle"
      role="menu"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

<style>
/* 全站右键菜单唯一一份样式（原 SongList.vue 里的 :global 副本已删）。 */
.song-context-menu {
  position: fixed;
  box-sizing: border-box;
  width: max-content;
  min-width: min(180px, calc(100vw - 16px));
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 104px);
  padding: 6px;
  border-radius: var(--radius-popover);
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  border: 1px solid var(--surface-outline);
  box-shadow: var(--shadow-elevated);
  display: flex;
  flex-direction: column;
  z-index: 1200;
  overflow-y: auto;
  overscroll-behavior: contain;
  outline: none;
  contain: paint;
  isolation: isolate;
  transform: translateZ(0);
  backface-visibility: hidden;
  animation: song-context-enter var(--motion-duration-fast) var(--motion-ease-standard);
}

.song-context-item {
  appearance: none;
  box-sizing: border-box;
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 100%;
  min-height: 36px;
  text-align: left;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  overflow-wrap: anywhere;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-main);
  box-shadow: none;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard),
    box-shadow var(--motion-duration-fast) var(--motion-ease-standard);
}

.song-context-item:not(:disabled):hover {
  background: var(--control-hover-bg);
  box-shadow: none;
}

.song-context-item:not(:disabled):active {
  background: var(--control-neutral-pressed-bg);
}

.song-context-item.is-danger {
  color: var(--control-danger-text);
}

.song-context-item.is-danger:not(:disabled):hover {
  background: var(--control-danger-hover-bg);
  box-shadow: none;
}

.song-context-item.is-danger:not(:disabled):active {
  background: var(--control-danger-pressed-bg);
}

.song-context-item:not(:disabled):focus-visible,
.song-context-item.is-danger:not(:disabled):focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--color-primary-text);
}

.song-context-item:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.song-context-separator {
  flex-shrink: 0;
  border: 0;
  border-top: 1px solid var(--border-subtle);
  margin: 4px 6px;
}

@keyframes song-context-enter {
  from {
    opacity: 0;
    transform: translate3d(0, 4px, 0);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .song-context-menu {
    animation: none;
  }
  .song-context-item {
    transition: none;
  }
}
</style>
