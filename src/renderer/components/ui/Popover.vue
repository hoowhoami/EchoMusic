<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent, PopoverArrow } from 'reka-ui';

type TriggerMode = 'hover' | 'click' | 'focus' | 'manual';
type Placement = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';

interface Props {
  trigger?: TriggerMode;
  side?: Placement;
  align?: Align;
  sideOffset?: number;
  showArrow?: boolean;
  delay?: number;
  duration?: number;
  open?: boolean;
  disabled?: boolean;
  contentClass?: string;
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

const internalOpen = ref(false);
// 真实 DOM 引用，用于点击外部判断
const triggerWrapRef = ref<HTMLElement | null>(null);
const contentWrapRef = ref<HTMLElement | null>(null);
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const isOpen = computed(() => {
  if (props.trigger === 'manual') return props.open ?? false;
  return internalOpen.value;
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

const setOpen = (val: boolean) => {
  internalOpen.value = val;
  emit('update:open', val);
};

const doShow = () => {
  if (props.disabled) return;
  clearTimers();
  if (props.trigger === 'hover') {
    showTimer = setTimeout(() => setOpen(true), props.delay);
  } else {
    setOpen(true);
  }
};

const doHide = () => {
  clearTimers();
  if (props.trigger === 'hover') {
    hideTimer = setTimeout(() => setOpen(false), props.duration);
  } else {
    setOpen(false);
  }
};

// hover
const handleTriggerEnter = () => {
  if (props.trigger === 'hover') doShow();
};
const handleTriggerLeave = () => {
  if (props.trigger === 'hover') doHide();
};
const handleContentEnter = () => {
  if (props.trigger === 'hover') clearTimers();
};
const handleContentLeave = () => {
  if (props.trigger === 'hover') doHide();
};

// focus
const handleTriggerFocus = () => {
  if (props.trigger === 'focus') doShow();
};
const handleTriggerBlur = () => {
  if (props.trigger === 'focus') doHide();
};

// click
const handleTriggerClick = () => {
  if (props.trigger !== 'click') return;
  if (internalOpen.value) doHide();
  else doShow();
};

// 点击外部关闭（替代 reka-ui 的 interact-outside）
const handleDocumentMousedown = (e: MouseEvent) => {
  if (props.trigger !== 'click' || !internalOpen.value) return;
  const target = e.target as Node;
  // 点击在触发器内 → 不处理，让 handleTriggerClick 管
  if (triggerWrapRef.value?.contains(target)) return;
  // 点击在内容区内 → 不关闭
  if (contentWrapRef.value?.contains(target)) return;
  doHide();
};

// 阻止 reka-ui 自行管理 open
const handleRekaOpenChange = () => {};
// 阻止 reka-ui 的 interact-outside
const handleInteractOutside = (e: Event) => {
  e.preventDefault();
};

watch(
  () => props.open,
  (val) => {
    if (val !== undefined) {
      internalOpen.value = val;
    }
  },
);

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMousedown, true);
});

onUnmounted(() => {
  clearTimers();
  document.removeEventListener('mousedown', handleDocumentMousedown, true);
});
</script>

<template>
  <PopoverRoot :open="isOpen" @update:open="handleRekaOpenChange">
    <PopoverTrigger as-child>
      <span
        ref="triggerWrapRef"
        style="display: inline-flex"
        @mouseenter="handleTriggerEnter"
        @mouseleave="handleTriggerLeave"
        @click="handleTriggerClick"
        @focus="handleTriggerFocus"
        @blur="handleTriggerBlur"
      >
        <slot name="trigger" />
      </span>
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
          @interact-outside="handleInteractOutside"
        >
          <div ref="contentWrapRef">
            <slot />
          </div>
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
