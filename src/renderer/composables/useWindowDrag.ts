import { onUnmounted, ref } from 'vue';
import { createRendererSessionId, createRendererSessionNonce } from '@/utils/sessionId';

export type WindowDragAdapter = {
  start: (sessionId: string) => Promise<boolean>;
  move: (sessionId: string, event: PointerEvent) => void;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export type WindowDragOptions = {
  adapter: WindowDragAdapter;
  sessionPrefix: string;
  sessionNonce?: Promise<string | null>;
  disabled?: () => boolean;
  isTargetDraggable?: (target: EventTarget | null) => boolean;
  onStart?: (event: PointerEvent, sessionId: string) => void;
  onMove?: (event: PointerEvent) => void;
  onFinish?: (sessionId: string, commit: boolean) => void;
  onSettled?: (sessionId: string, commit: boolean, result: unknown) => void;
};

type PendingDrag = {
  id: string | null;
  pointerId: number;
  epoch: number;
  pressed: boolean;
  captureTarget: HTMLElement;
};

type ActiveDrag = Omit<PendingDrag, 'id'> & {
  id: string;
};

/**
 * 统一处理窗口拖动的 renderer 生命周期。实际屏幕坐标和窗口边界仍由 Main
 * 控制器决定，renderer 只转发 PointerEvent 的屏幕坐标。
 */
export function useWindowDrag(options: WindowDragOptions) {
  const isDragging = ref(false);
  const lifecycle = createWindowDragLifecycle(options, (value) => {
    isDragging.value = value;
  });

  onUnmounted(() => lifecycle.dispose());

  return {
    isDragging,
    onPointerDown: lifecycle.onPointerDown,
    onPointerMove: lifecycle.onPointerMove,
    onPointerUp: lifecycle.onPointerUp,
    onPointerCancel: lifecycle.onPointerCancel,
    onPointerLeave: lifecycle.onPointerLeave,
    cancel: lifecycle.cancel,
  };
}

export function createWindowDragLifecycle(
  options: WindowDragOptions,
  setDragging: (value: boolean) => void = () => undefined,
) {
  let epoch = 0;
  let settlementEpoch = 0;
  let pending: PendingDrag | null = null;
  let active: ActiveDrag | null = null;
  let fallbackListeners = false;
  const localSessionNonce = createRendererSessionNonce();
  const sessionNonce =
    options.sessionNonce?.then((nonce) => nonce || localSessionNonce) ??
    Promise.resolve(localSessionNonce);

  const callAsyncSafely = <T>(call: () => Promise<T>) => {
    try {
      return Promise.resolve().then(call);
    } catch {
      return Promise.reject();
    }
  };

  const cancelSafely = (sessionId: string) => {
    void callAsyncSafely(() => options.adapter.cancel(sessionId)).catch(() => undefined);
  };

  const cancelPending = () => {
    const session = pending;
    if (!session) return;
    session.pressed = false;
    pending = null;
    epoch += 1;
    if (session.id) cancelSafely(session.id);
    releasePointerCapture(session);
    removeFallbackListeners();
  };

  const addFallbackListeners = () => {
    if (fallbackListeners) return;
    fallbackListeners = true;
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
  };

  const removeFallbackListeners = () => {
    if (!fallbackListeners) return;
    fallbackListeners = false;
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
  };

  const releasePointerCapture = (session: Pick<PendingDrag, 'captureTarget' | 'pointerId'>) => {
    try {
      if (session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
    } catch {
      // The pointer may already have been released by the system.
    }
  };

  const finish = (event: PointerEvent | undefined, commit: boolean, notifyMain = true) => {
    const session = active;
    if (!session || (event && event.pointerId !== session.pointerId)) return;
    active = null;
    setDragging(false);
    const settlementId = ++settlementEpoch;
    options.onFinish?.(session.id, commit);
    releasePointerCapture(session);
    removeFallbackListeners();
    const settle = notifyMain
      ? commit
        ? callAsyncSafely(() => options.adapter.end(session.id))
        : callAsyncSafely(() => options.adapter.cancel(session.id))
      : Promise.resolve(undefined);
    void settle
      .then((result) => {
        if (settlementId === settlementEpoch) options.onSettled?.(session.id, commit, result);
      })
      .catch(() => undefined);
  };

  const onPointerDown = async (event: PointerEvent) => {
    if (
      options.disabled?.() ||
      event.button !== 0 ||
      pending ||
      active ||
      (options.isTargetDraggable && !options.isTargetDraggable(event.target))
    )
      return;

    const captureTarget = event.currentTarget;
    if (!(captureTarget instanceof HTMLElement)) return;
    const session: PendingDrag = {
      id: null,
      pointerId: event.pointerId,
      epoch: ++epoch,
      pressed: true,
      captureTarget,
    };
    pending = session;
    addFallbackListeners();
    try {
      captureTarget.setPointerCapture(session.pointerId);
    } catch {
      cancelPending();
      return;
    }
    event.preventDefault();
    let nonce: string;
    try {
      nonce = await sessionNonce;
    } catch {
      if (pending === session) cancelPending();
      return;
    }
    if (pending !== session || session.epoch !== epoch || !session.pressed) return;
    if (options.disabled?.()) {
      cancelPending();
      return;
    }
    session.id = createRendererSessionId(options.sessionPrefix, nonce, session.epoch);
    let started = false;
    try {
      started = await callAsyncSafely(() => options.adapter.start(session.id!));
    } catch {
      started = false;
    }

    if (
      pending !== session ||
      session.epoch !== epoch ||
      !session.pressed ||
      options.disabled?.()
    ) {
      if (pending === session) cancelPending();
      else if (session.id) cancelSafely(session.id);
      return;
    }
    pending = null;
    if (!started) {
      cancelSafely(session.id!);
      releasePointerCapture(session);
      removeFallbackListeners();
      return;
    }

    active = { ...session, id: session.id! };
    setDragging(true);
    options.onStart?.(event, session.id);
    // Capture is requested before the asynchronous start so a fast release cannot be lost.
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    options.onMove?.(event);
    try {
      void Promise.resolve(options.adapter.move(active.id, event)).catch(() => undefined);
    } catch {
      // A synchronous IPC failure must not escape the pointer event handler.
    }
    event.preventDefault();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (active) finish(event, true);
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (active) finish(event, false);
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onPointerLeave = (event: PointerEvent) => {
    if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onWindowBlur = () => {
    cancelPending();
    finish(undefined, false);
  };

  const cancel = (notifyMain = true) => {
    cancelPending();
    finish(undefined, false, notifyMain);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    cancel,
    dispose: () => {
      cancelPending();
      finish(undefined, false);
      removeFallbackListeners();
    },
  };
}
