import { app } from 'electron';
import log from './logger';
import type { ClosePreferences } from '../shared/app';

type BackgroundIconOptions = Pick<
  ClosePreferences,
  'hideDockInBackground' | 'hideMenuBarInBackground'
>;

let backgroundMode = false;
let quitting = false;
let pendingDockRestore: Promise<void> | null = null;
let setTrayVisible: ((visible: boolean) => void) | null = null;
let iconOptions: BackgroundIconOptions = {
  hideDockInBackground: false,
  hideMenuBarInBackground: false,
};

const shouldHideDock = () => backgroundMode && iconOptions.hideDockInBackground;
const shouldShowTray = () => !quitting && !(backgroundMode && iconOptions.hideMenuBarInBackground);

export const isMacBackgroundMode = () => backgroundMode;

// Keep tray ownership in tray.ts, without introducing a window/tray import cycle.
export const registerMacTrayVisibility = (handler: (visible: boolean) => void) => {
  setTrayVisible = handler;
  if (process.platform === 'darwin') handler(shouldShowTray());
};

export const syncMacDockVisibility = async () => {
  if (process.platform !== 'darwin') return;
  if (shouldHideDock() || quitting) {
    app.dock?.hide();
    return;
  }
  try {
    await app.dock?.show();
    // A close/quit can arrive while AppKit is changing the activation policy.
    if (shouldHideDock() || quitting) app.dock?.hide();
  } catch (error) {
    log.warn('[Window] Failed to restore Dock icon:', error);
  }
};

const restoreDock = async () => {
  const restoring = syncMacDockVisibility();
  pendingDockRestore = restoring;
  await restoring;
  if (pendingDockRestore === restoring) pendingDockRestore = null;
};

const applyBackgroundIcons = (wasDockHidden: boolean) => {
  if (process.platform !== 'darwin' || !backgroundMode || quitting) return;
  setTrayVisible?.(shouldShowTray());
  if (shouldHideDock()) app.dock?.hide();
  else if (wasDockHidden) void restoreDock();
};

export const updateMacBackgroundOptions = (options: BackgroundIconOptions) => {
  const wasDockHidden = shouldHideDock();
  iconOptions = { ...options };
  applyBackgroundIcons(wasDockHidden);
};

export const enterMacBackgroundMode = (options: BackgroundIconOptions) => {
  if (process.platform !== 'darwin' || quitting) return;
  // Update both preferences together; a Dock-only background keeps its tray entry.
  const wasDockHidden = shouldHideDock();
  iconOptions = { ...options };
  backgroundMode = true;
  applyBackgroundIcons(wasDockHidden);
};

export const leaveMacBackgroundMode = async () => {
  if (quitting) return;
  if (!backgroundMode) {
    await pendingDockRestore;
    return;
  }
  const wasDockHidden = shouldHideDock();
  backgroundMode = false;
  setTrayVisible?.(true);
  if (wasDockHidden) await restoreDock();
  else await pendingDockRestore;
};

app.on('before-quit', () => {
  quitting = true;
});
