import { app } from 'electron';
import log from './logger';

let backgroundMode = false;
let quitting = false;
let pendingDockRestore: Promise<void> | null = null;
let setTrayVisible: ((visible: boolean) => void) | null = null;

export const isMacBackgroundMode = () => backgroundMode;

// Keep tray ownership in tray.ts, without introducing a window/tray import cycle.
export const registerMacTrayVisibility = (handler: (visible: boolean) => void) => {
  setTrayVisible = handler;
  if (process.platform === 'darwin') handler(!backgroundMode && !quitting);
};

export const syncMacDockVisibility = async () => {
  if (process.platform !== 'darwin') return;
  if (backgroundMode || quitting) {
    app.dock?.hide();
    return;
  }
  try {
    await app.dock?.show();
    // A close/quit can arrive while AppKit is changing the activation policy.
    if (backgroundMode || quitting) app.dock?.hide();
  } catch (error) {
    log.warn('[Window] Failed to restore Dock icon:', error);
  }
};

export const enterMacBackgroundMode = () => {
  if (process.platform !== 'darwin' || quitting) return;
  backgroundMode = true;
  setTrayVisible?.(false);
  app.dock?.hide();
};

export const leaveMacBackgroundMode = async () => {
  if (quitting) return;
  if (!backgroundMode) {
    await pendingDockRestore;
    return;
  }
  backgroundMode = false;
  setTrayVisible?.(true);
  const restoring = syncMacDockVisibility();
  pendingDockRestore = restoring;
  await restoring;
  if (pendingDockRestore === restoring) pendingDockRestore = null;
};

app.on('before-quit', () => {
  quitting = true;
});
