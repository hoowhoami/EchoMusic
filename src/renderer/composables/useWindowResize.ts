import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';
import { createRendererSessionId, createRendererSessionNonce } from '@/utils/sessionId';

export type WindowResizeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export type WindowResizeAdapter = {
  start: (sessionId: string) => Promise<boolean>;
  resize: (sessionId: string, bounds: WindowResizeBounds) => void | Promise<unknown>;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export type WindowResizeOptions = {
  adapter: WindowResizeAdapter;
  sessionPrefix: string;
  sessionNonce?: Promise<string | null>;
  disabled?: () => boolean;
  getStartBounds?: (event: PointerEvent) => WindowResizeBounds | Promise<WindowResizeBounds>;
  minBounds?: Partial<Pick<WindowResizeBounds, 'width' | 'height'>>;
  maxBounds?: Partial<Pick<WindowResizeBounds, 'width' | 'height'>>;
  onStart?: (event: PointerEvent, sessionId: string) => void;
  onResize?: (bounds: WindowResizeBounds) => void;
  onSettled?: (sessionId: string, commit: boolean, result: unknown) => void;
};

type PendingResize = {
  id: string | null;
  pointerId: number;
  captureTarget: HTMLElement;
  epoch: number;
  pressed: boolean;
  direction: WindowResizeDirection;
};

type ActiveResize = PendingResize & {
  id: string;
  startScreenX: number;
  startScreenY: number;
  latestScreenX: number;
  latestScreenY: number;
  startBounds: WindowResizeBounds;
};

export function useWindowResize(options: WindowResizeOptions) {
  const isResizing = ref(false);
  let epoch = 0;
  let pending: PendingResize | null = null;
  let active: ActiveResize | null = null;
  let animationFrame = 0;
  const localNonce = createRendererSessionNonce();
  const sessionNonce =
    options.sessionNonce?.then((nonce) => nonce || localNonce) ?? Promise.resolve(localNonce);

  const callAsyncSafely = <T>(call: () => Promise<T>) => {
    try {
      return Promise.resolve().then(call);
    } catch {
      return Promise.reject();
    }
  };

  const cancelSafely = (id: string) => {
    void callAsyncSafely(() => options.adapter.cancel(id)).catch(() => undefined);
  };

  const removeListeners = () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onBlur);
  };

  const cancelPending = () => {
    const session = pending;
    if (!session) return;
    session.pressed = false;
    pending = null;
    epoch += 1;
    if (session.id) cancelSafely(session.id);
    releaseCapture(session);
    removeListeners();
  };

  const getBounds = (session: ActiveResize): WindowResizeBounds => {
    const dx = session.latestScreenX - session.startScreenX;
    const dy = session.latestScreenY - session.startScreenY;
    const resizeWest = session.direction.includes('w');
    const resizeEast = session.direction.includes('e');
    const resizeNorth = session.direction.includes('n');
    const resizeSouth = session.direction.includes('s');
    const minWidth = Math.max(1, options.minBounds?.width ?? 1);
    const minHeight = Math.max(1, options.minBounds?.height ?? 1);
    const maxWidth = Math.max(minWidth, options.maxBounds?.width ?? Infinity);
    const maxHeight = Math.max(minHeight, options.maxBounds?.height ?? Infinity);
    let { x, y, width, height } = session.startBounds;

    if (resizeWest) {
      width = Math.min(maxWidth, Math.max(minWidth, session.startBounds.width - dx));
      x = session.startBounds.x + session.startBounds.width - width;
    } else if (resizeEast)
      width = Math.min(maxWidth, Math.max(minWidth, session.startBounds.width + dx));
    if (resizeNorth) {
      height = Math.min(maxHeight, Math.max(minHeight, session.startBounds.height - dy));
      y = session.startBounds.y + session.startBounds.height - height;
    } else if (resizeSouth)
      height = Math.min(maxHeight, Math.max(minHeight, session.startBounds.height + dy));

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const flush = () => {
    animationFrame = 0;
    if (!active) return;
    const bounds = getBounds(active);
    options.onResize?.(bounds);
    try {
      void Promise.resolve(options.adapter.resize(active.id, bounds)).catch(() => undefined);
    } catch {
      // Native IPC can throw while the window is closing.
    }
  };

  const schedule = () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(flush);
  };

  const releaseCapture = (session: Pick<PendingResize, 'captureTarget' | 'pointerId'>) => {
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
    if (event) {
      session.latestScreenX = event.screenX;
      session.latestScreenY = event.screenY;
    }
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (commit) flush();
    active = null;
    isResizing.value = false;
    removeListeners();
    releaseCapture(session);
    if (!notifyMain) return;
    const settle = callAsyncSafely(() =>
      commit ? options.adapter.end(session.id) : options.adapter.cancel(session.id),
    );
    void settle
      .then((result) => options.onSettled?.(session.id, commit, result))
      .catch(() => undefined);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    active.latestScreenX = event.screenX;
    active.latestScreenY = event.screenY;
    schedule();
    event.preventDefault();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (active) finish(event, !options.disabled?.());
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (active) finish(event, false);
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };
  const onBlur = () => {
    cancelPending();
    finish(undefined, false);
  };

  const onPointerDown = async (event: PointerEvent, direction: WindowResizeDirection) => {
    if (options.disabled?.() || event.button !== 0 || pending || active) return;
    const captureTarget = event.currentTarget;
    if (!(captureTarget instanceof HTMLElement)) return;
    const session: PendingResize = {
      id: null,
      pointerId: event.pointerId,
      captureTarget,
      epoch: ++epoch,
      pressed: true,
      direction,
    };
    pending = session;
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onBlur);
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      cancelPending();
      return;
    }
    let nonce: string;
    try {
      nonce = (await sessionNonce) || localNonce;
    } catch {
      if (pending === session) cancelPending();
      return;
    }
    if (
      pending !== session ||
      session.epoch !== epoch ||
      !session.pressed ||
      options.disabled?.()
    ) {
      if (pending === session) cancelPending();
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
    if (!started) {
      cancelPending();
      return;
    }
    let startBounds: WindowResizeBounds;
    try {
      startBounds = (await options.getStartBounds?.(event)) ?? {
        x: Math.round(event.screenX - event.clientX),
        y: Math.round(event.screenY - event.clientY),
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
      };
    } catch {
      if (pending === session) cancelPending();
      else cancelSafely(session.id);
      return;
    }
    if (
      pending !== session ||
      session.epoch !== epoch ||
      !session.pressed ||
      options.disabled?.()
    ) {
      if (pending === session) cancelPending();
      else cancelSafely(session.id);
      return;
    }
    pending = null;
    active = {
      ...session,
      id: session.id!,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      latestScreenX: event.screenX,
      latestScreenY: event.screenY,
      startBounds,
    };
    isResizing.value = true;
    options.onStart?.(event, session.id);
    event.preventDefault();
  };

  const cancel = (notifyMain = true) => {
    cancelPending();
    finish(undefined, false, notifyMain);
  };

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      cancel();
      if (animationFrame) cancelAnimationFrame(animationFrame);
    });
  }

  return { isResizing, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, cancel };
}
