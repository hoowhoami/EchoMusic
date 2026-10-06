<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  inject,
  provide,
} from 'vue';
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
  holdOpen?: boolean;
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
  (e: 'open-auto-focus', event: Event): void;
}>();

const internalOpen = ref(props.open ?? false);
const suspended = ref(false);
const disposed = ref(false);
const mounted = ref(false);
const canOpen = computed(() => !props.disabled && !suspended.value && !disposed.value);
// 真实 DOM 引用，用于点击外部判断
const triggerWrapRef = ref<HTMLElement | null>(null);
const contentWrapRef = ref<HTMLElement | null>(null);
// Portalled descendants are outside our DOM subtree but inside this interaction.
// Register only actual Vue descendants, not every open popover on the page.
type PopoverBranch = (target: Node) => boolean;
type RegisterPopoverBranch = (branch: PopoverBranch) => () => void;
const parentRegisterBranch = inject<RegisterPopoverBranch | null>('echo-popover-branch', null);
const childBranches = new Set<PopoverBranch>();
const containsPopoverTarget: PopoverBranch = (target) =>
  !!triggerWrapRef.value?.contains(target) ||
  !!contentWrapRef.value?.contains(target) ||
  [...childBranches].some((contains) => contains(target));
const registerPopoverBranch: RegisterPopoverBranch = (branch) => {
  childBranches.add(branch);
  return () => {
    childBranches.delete(branch);
  };
};
provide('echo-popover-branch', registerPopoverBranch);
const unregisterParentBranch = parentRegisterBranch?.(containsPopoverTarget);
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const isOpen = computed(() => {
  if (!canOpen.value) return false;
  if (props.trigger === 'manual') return props.open ?? false;
  return internalOpen.value;
});

const clearTimers = () => {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
};

const setOpen = (val: boolean) => {
  clearTimers();
  if (val && !canOpen.value) return;
  internalOpen.value = val;
  emit('update:open', val);
};

const doShow = () => {
  if (!canOpen.value) return;
  clearTimers();
  if (props.trigger === 'hover') {
    showTimer = setTimeout(() => setOpen(true), props.delay);
  } else {
    setOpen(true);
  }
};

const doHide = () => {
  if (!canOpen.value || props.holdOpen) return;
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
const handleContentLeave = (event?: MouseEvent) => {
  if (event?.relatedTarget && containsPopoverTarget(event.relatedTarget as Node)) {
    handleContentEnter();
    return;
  }
  if (props.trigger === 'hover') doHide();
};

const handleDocumentPointerMove = (event: PointerEvent) => {
  if (props.trigger !== 'hover' || !isOpen.value || !event.target) return;
  if (containsPopoverTarget(event.target as Node)) clearTimers();
  else if (hideTimer === null) doHide();
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
  if (props.trigger !== 'click' || !isOpen.value) return;
  const target = e.target as Node;
  if (containsPopoverTarget(target)) return;
  doHide();
};

const handleEscapeKeyDown = (event: KeyboardEvent) => {
  // Reka dispatches this only for its highest layer. Consume the event even
  // while held open or exiting so the drawer/dialog behind it cannot close.
  event.preventDefault();
  event.stopPropagation();
  if (isOpen.value && !props.holdOpen) setOpen(false);
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
      clearTimers();
      internalOpen.value = val;
    }
  },
  { flush: 'sync' },
);

watch(
  () => props.disabled,
  (disabled) => {
    if (!disabled) return;
    clearTimers();
    setOpen(false);
  },
  { flush: 'sync' },
);

// A hover popover may become click-dismissed while editing inside it.
// A pending mouseleave timeout must not close that editing session.
watch(() => props.trigger, clearTimers, { flush: 'sync' });
watch(
  () => props.holdOpen,
  (holdOpen) => {
    if (holdOpen && hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  },
  { flush: 'sync' },
);

let listeningForOutsideClick = false;
let listeningForHover = false;
const syncDocumentListeners = () => {
  const shouldListen = mounted.value && isOpen.value && props.trigger === 'click';
  if (shouldListen !== listeningForOutsideClick) {
    listeningForOutsideClick = shouldListen;
    if (shouldListen) document.addEventListener('mousedown', handleDocumentMousedown, true);
    else document.removeEventListener('mousedown', handleDocumentMousedown, true);
  }
  const shouldTrackHover = mounted.value && isOpen.value && props.trigger === 'hover';
  if (shouldTrackHover !== listeningForHover) {
    listeningForHover = shouldTrackHover;
    if (shouldTrackHover) document.addEventListener('pointermove', handleDocumentPointerMove, true);
    else document.removeEventListener('pointermove', handleDocumentPointerMove, true);
  }
};
watch([mounted, isOpen, () => props.trigger], syncDocumentListeners, { flush: 'sync' });

onMounted(() => {
  mounted.value = true;
});
onDeactivated(() => {
  const wasOpen = isOpen.value;
  suspended.value = true;
  clearTimers();
  if (wasOpen || internalOpen.value) setOpen(false);
});
onActivated(() => {
  if (!disposed.value) suspended.value = false;
});
onUnmounted(() => {
  disposed.value = true;
  mounted.value = false;
  syncDocumentListeners();
  unregisterParentBranch?.();
  childBranches.clear();
  clearTimers();
});

defineExpose({
  close: () => setOpen(false),
  open: () => setOpen(true),
});
</script>

<template>
  <PopoverRoot :open="isOpen" @update:open="handleRekaOpenChange">
    <PopoverTrigger as-child>
      <span
        ref="triggerWrapRef"
        class="echo-popover-trigger"
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
      <PopoverContent
        :side="props.side"
        :align="props.align"
        :side-offset="props.sideOffset"
        :collision-padding="12"
        avoid-collisions
        :class="['echo-popover-content', props.contentClass]"
        :style="props.contentStyle"
        :inert="!isOpen || undefined"
        @mouseenter="handleContentEnter"
        @mouseleave="handleContentLeave"
        @interact-outside="handleInteractOutside"
        @escape-key-down="handleEscapeKeyDown"
        @open-auto-focus="emit('open-auto-focus', $event)"
      >
        <div ref="contentWrapRef">
          <slot />
        </div>
        <PopoverArrow v-if="props.showArrow" :width="14" :height="8" as-child>
          <span class="echo-popover-arrow floating-surface-arrow" />
        </PopoverArrow>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.echo-popover-content {
  --popover-background: var(--floating-surface-bg);
  z-index: 9999;
  border-radius: var(--radius-popover);
  background: var(--popover-background);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  border: 0;
  box-shadow: var(--shadow-elevated);
  padding: 12px;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}

.echo-popover-content[data-state='open'] {
  animation: motion-popover-in var(--motion-duration-normal) var(--motion-ease-enter);
}

.echo-popover-content[data-state='closed'] {
  pointer-events: none;
  animation: motion-fade-out var(--motion-duration-fast) var(--motion-ease-exit);
}

@media (prefers-reduced-motion: reduce) {
  .echo-popover-content[data-state] {
    animation: none;
  }
}
</style>
