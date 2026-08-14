import { computed, onBeforeUnmount, readonly, ref, watch, type Ref } from 'vue';

export type DialogStackToken = symbol;

export const DIALOG_STACK_BASE_Z_INDEX = 1600;
export const DIALOG_STACK_LAYER_STEP = 20;
export const DIALOG_STACK_CONTENT_OFFSET = 10;

/**
 * Creates an ordered dialog registry. Re-activating a token moves it to the
 * top, which also covers a dialog being reopened while its close animation is
 * still running.
 */
export const createDialogStack = () => {
  const entries = ref<DialogStackToken[]>([]);

  const activate = (token: DialogStackToken) => {
    entries.value = [...entries.value.filter((entry) => entry !== token), token];
  };

  const deactivate = (token: DialogStackToken) => {
    if (!entries.value.includes(token)) return;
    entries.value = entries.value.filter((entry) => entry !== token);
  };

  const indexOf = (token: DialogStackToken) => entries.value.indexOf(token);
  const isTop = (token: DialogStackToken) => entries.value.at(-1) === token;

  return {
    entries: readonly(entries),
    activate,
    deactivate,
    indexOf,
    isTop,
  };
};

// 栈按 renderer/document 隔离，并在同一上下文内有意共享：宿主应用与插件通过
// ctx.ui.mount/teleport 创建的迷你 Vue 应用需要参与同一浮层顺序。Electron 多窗口
// 运行在彼此独立的 renderer 上下文中，因此不会跨窗口共享状态。
const globalDialogStack = createDialogStack();

/**
 * Keeps the app-level visual dialog stack aligned with Reka's FocusScope and
 * DismissableLayer stacks. A closing dialog remains registered until Reka's
 * Presence emits `after-leave`, then the previous dialog becomes interactive.
 * This intentionally keeps lower dialogs non-interactive during the short
 * leave animation so visual order and focus ownership cannot diverge.
 */
export const useDialogStack = (open: Ref<boolean>) => {
  const token: DialogStackToken = Symbol('dialog');
  const activationKey = ref(0);
  const presenceElement = ref<HTMLElement | null>(null);

  watch(
    open,
    (isOpen) => {
      if (isOpen) {
        activationKey.value += 1;
        globalDialogStack.activate(token);
      } else if (!presenceElement.value) {
        // Covers true -> false changes batched before the Portal ever mounts.
        globalDialogStack.deactivate(token);
      }
    },
    { immediate: true, flush: 'sync' },
  );

  watch(
    presenceElement,
    (element) => {
      // Presence normally emits after-leave. The ref fallback also handles a
      // parent unmount, immediate node removal, or activationKey replacing a
      // closing node when the same dialog is reopened before after-leave.
      if (!element && !open.value) globalDialogStack.deactivate(token);
    },
    { flush: 'sync' },
  );

  onBeforeUnmount(() => {
    globalDialogStack.deactivate(token);
  });

  const layerIndex = computed(() => globalDialogStack.indexOf(token));
  const isTop = computed(() => globalDialogStack.isTop(token));
  const isInteractive = computed(() => open.value && isTop.value);
  const overlayZIndex = computed(() =>
    layerIndex.value >= 0
      ? DIALOG_STACK_BASE_Z_INDEX + layerIndex.value * DIALOG_STACK_LAYER_STEP
      : DIALOG_STACK_BASE_Z_INDEX - DIALOG_STACK_LAYER_STEP,
  );
  const contentZIndex = computed(() => overlayZIndex.value + DIALOG_STACK_CONTENT_OFFSET);

  const finishClose = () => {
    if (!open.value) globalDialogStack.deactivate(token);
  };

  return {
    activationKey,
    presenceElement,
    layerIndex,
    isTop,
    isInteractive,
    overlayZIndex,
    contentZIndex,
    finishClose,
  };
};
