<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent, PopoverArrow } from 'reka-ui';

type TriggerMode = 'hover' | 'click' | 'focus' | 'manual';
type Placement = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';

interface Props {
  /** 触发方式 */
  trigger?: TriggerMode;
  /** 弹出方向 */
  side?: Placement;
  /** 对齐方式 */
  align?: Align;
  /** 与触发器的间距 */
  sideOffset?: number;
  /** 是否显示箭头 */
  showArrow?: boolean;
  /** hover 模式下显示延迟（毫秒） */
  delay?: number;
  /** hover 模式下隐藏延迟（毫秒） */
  duration?: number;
  /** 外部控制显隐 */
  open?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 内容区域自定义 class */
  contentClass?: string;
  /** 内容区域自定义 style */
  contentStyle?: string | Record<string, string>;
}

const props = withDefaults(defineProps<Props>(), {
  trigger: 'hover',
  side: 'top',
  align: 'center',
  sideOffset: 8,
  showArrow: true,
  delay: 100,
  duration: 100,
  disabled: false,
  contentClass: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

// 内部状态
const internalOpen = ref(false);
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

// 合并外部和内部状态
const isOpen = computed(() => {
  if (props.trigger === 'manual') return props.open ?? false;
  return internalOpen.value;
});

// reka-ui PopoverRoot 的 open 状态（click 模式直接用它）
const rekaOpen = computed(() => {
  if (props.trigger === 'click') return internalOpen.value;
  return false;
});

const clearTimers = () => {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
};

const doShow = () => {
  if (props.disabled) return;
  clearTimers();
  if (props.trigger === 'hover') {
    showTimer = setTimeout(() => {
      internalOpen.value = true;
      emit('update:open', true);
    }, props.delay);
  } else {
    internalOpen.value = true;
    emit('update:open', true);
  }
};

const doHide = () => {
  clearTimers();
  if (props.trigger === 'hover') {
    hideTimer = setTimeout(() => {
      internalOpen.value = false;
      emit('update:open', false);
    }, props.duration);
  } else {
    internalOpen.value = false;
    emit('update:open', false);
  }
};

const handleTriggerEnter = () => {
  if (props.trigger === 'hover') doShow();
};

const handleTriggerLeave = () => {
  if (props.trigger === 'hover') doHide();
};

const handleContentEnter = () => {
  if (props.trigger === 'hover') {
    // 鼠标进入内容区，取消隐藏
    clearTimers();
  }
};

const handleContentLeave = () => {
  if (props.trigger === 'hover') doHide();
};

const handleTriggerClick = () => {
  if (props.trigger === 'click') {
    if (internalOpen.value) {
      doHide();
    } else {
      doShow();
    }
  }
};

const handleTriggerFocus = () => {
  if (props.trigger === 'focus') doShow();
};

const handleTriggerBlur = () => {
  if (props.trigger === 'focus') doHide();
};

// click 模式下 reka-ui 的 open 变化同步
const handleRekaOpenChange = (val: boolean) => {
  if (props.trigger === 'click') {
    internalOpen.value = val;
    emit('update:open', val);
  }
};

// manual 模式下外部 open 变化同步
watch(
  () => props.open,
  (val) => {
    if (props.trigger === 'manual' && val !== undefined) {
      internalOpen.value = val;
    }
  },
);

onUnmounted(clearTimers);
</script>

<template>
  <PopoverRoot
    :open="props.trigger === 'click' ? rekaOpen : isOpen"
    @update:open="handleRekaOpenChange"
  >
    <PopoverTrigger
      as-child
      @mouseenter="handleTriggerEnter"
      @mouseleave="handleTriggerLeave"
      @click="handleTriggerClick"
      @focus="handleTriggerFocus"
      @blur="handleTriggerBlur"
    >
      <slot name="trigger" />
    </PopoverTrigger>
    <PopoverPortal>
      <Transition name="popover-fade">
        <PopoverContent
          v-if="isOpen"
          :side="props.side"
          :align="props.align"
          :side-offset="props.sideOffset"
          :collision-padding="12"
          avoid-collisions
          :class="['echo-popover-content', props.contentClass]"
          :style="props.contentStyle"
          @mouseenter="handleContentEnter"
          @mouseleave="handleContentLeave"
          @interact-outside="props.trigger === 'click' ? doHide() : undefined"
        >
          <slot />
          <PopoverArrow v-if="props.showArrow" :width="14" :height="8" class="echo-popover-arrow" />
        </PopoverContent>
      </Transition>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.echo-popover-content {
  z-index: 9999;
  border-radius: 16px;
  background: var(--color-bg-card);
  border: 1px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.12),
    0 2px 6px rgba(0, 0, 0, 0.06);
  padding: 12px;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
  will-change: transform, opacity;
}

.dark .echo-popover-content {
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.36),
    0 2px 6px rgba(0, 0, 0, 0.18);
}

.echo-popover-arrow {
  fill: var(--color-bg-card);
  stroke: none;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.04));
}

/* 动画 */
.popover-fade-enter-active {
  transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.popover-fade-leave-active {
  transition: opacity 0.1s cubic-bezier(0.4, 0, 1, 1);
}

.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
}
</style>
