import type { WindowFrameState } from '../../shared/window-frame';

/** A non-interactive frame, independent of window background opacity. */
export function installWindowFrame() {
  const root = document.documentElement;
  const ipc = window.electron?.ipcRenderer;
  if (!ipc) return () => {};
  let disposed = false;
  let receivedUpdate = false;
  const apply = (state: WindowFrameState | null) => {
    if (disposed) return;
    root.classList.toggle('app-window-frame', Boolean(state?.visible));
    root.toggleAttribute(
      'data-echo-client-corners',
      Boolean(state?.visible && state?.clientCorners),
    );
    root.style.setProperty('--app-window-frame-radius', `${state?.radius ?? 0}px`);
  };
  const onState = (state: unknown) => {
    if (
      !state ||
      typeof state !== 'object' ||
      !('visible' in state) ||
      !('radius' in state) ||
      typeof state.visible !== 'boolean' ||
      typeof state.radius !== 'number'
    )
      return;
    receivedUpdate = true;
    apply(state as WindowFrameState);
  };
  ipc.on('window:frame-state-changed', onState);
  void ipc
    .invoke('window:frame-state')
    .then((state: WindowFrameState | null) => {
      if (!receivedUpdate) apply(state);
    })
    .catch(() => {
      // An already-running older main process may not have this handler until restart.
    });
  return () => {
    disposed = true;
    ipc.off('window:frame-state-changed', onState);
    root.classList.remove('app-window-frame');
    root.removeAttribute('data-echo-client-corners');
    root.style.removeProperty('--app-window-frame-radius');
  };
}
