import { BrowserWindow, app, ipcMain, nativeTheme, screen } from 'electron';
import type {
  DesktopLyricLockPhase,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';
import {
  DESKTOP_LYRIC_MAX_HEIGHT,
  DESKTOP_LYRIC_MAX_WIDTH,
  DESKTOP_LYRIC_MIN_HEIGHT,
  DESKTOP_LYRIC_MIN_WIDTH,
  constrainBoundsToDisplay,
  getDesktopLyricSettings,
  getDesktopLyricVirtualScreenBounds,
  getDesktopLyricWindowState,
  persistDesktopLyricSettings,
  persistDesktopLyricWindowState,
  sanitizeDesktopLyricSettings,
  setDesktopLyricEnabledFlag,
  setDesktopLyricLockedFlag,
} from './desktopLyric/store';
import {
  applyWindowBounds,
  clearWindowPresentationTimers,
  clearWindowInteractionTimers,
  createDesktopLyricWindow,
  getDesktopLyricWindow,
  loadDesktopLyricWindow,
  scheduleWindowInteractionSync,
  scheduleWindowPresentationSync,
  setDesktopLyricFixedSize,
  syncWindowPresentation,
  updateWindowHeight,
  withDesktopLyricWindow,
} from './desktopLyric/window';

export { getDesktopLyricWindow } from './desktopLyric/window';

const DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS = 320;

let desktopLyricIsLocked = false;
let desktopLyricClosingFromFailure = false;
let desktopLyricAppIsQuitting = false;
let desktopLyricDisplayMetricsTimer: NodeJS.Timeout | null = null;
let desktopLyricLockPhaseTimer: NodeJS.Timeout | null = null;
let desktopLyricForwardRestoreTimer: NodeJS.Timeout | null = null;
let desktopLyricMainWindowBound = false;

app.on('before-quit', () => {
  desktopLyricAppIsQuitting = true;
});

let snapshot: DesktopLyricSnapshot = {
  playback: null,
  lyrics: [],
  currentIndex: -1,
  settings: getDesktopLyricSettings(),
  lockPhase: 'idle',
};
desktopLyricIsLocked = snapshot.settings.locked;

const sendSnapshot = () => {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('desktop-lyric:snapshot', snapshot);
    } catch {
      // ignore destroyed frames while broadcasting
    }
  });
};

const clearDesktopLyricLockPhaseTimer = () => {
  if (!desktopLyricLockPhaseTimer) return;
  clearTimeout(desktopLyricLockPhaseTimer);
  desktopLyricLockPhaseTimer = null;
};

const setDesktopLyricLockPhase = (phase: DesktopLyricLockPhase, withCooldown = false) => {
  clearDesktopLyricLockPhaseTimer();
  if (snapshot.lockPhase !== phase) {
    snapshot = {
      ...snapshot,
      lockPhase: phase,
    };
    sendSnapshot();
  }
  if (!withCooldown || phase === 'idle') return;
  desktopLyricLockPhaseTimer = setTimeout(() => {
    desktopLyricLockPhaseTimer = null;
    setDesktopLyricLockPhase('idle');
  }, DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS);
};

const persistWindowBounds = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  persistDesktopLyricWindowState(bounds);
};

const reconcileDesktopLyricBounds = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const nextBounds = constrainBoundsToDisplay(bounds);
  const changed =
    bounds.x !== nextBounds.x ||
    bounds.y !== nextBounds.y ||
    bounds.width !== nextBounds.width ||
    bounds.height !== nextBounds.height;
  if (!changed) return;
  applyWindowBounds(nextBounds);
  persistWindowBounds();
};

const clearDesktopLyricDisplayMetricsTimer = () => {
  if (!desktopLyricDisplayMetricsTimer) return;
  clearTimeout(desktopLyricDisplayMetricsTimer);
  desktopLyricDisplayMetricsTimer = null;
};

const scheduleDesktopLyricBoundsReconcile = () => {
  clearDesktopLyricDisplayMetricsTimer();
  desktopLyricDisplayMetricsTimer = setTimeout(() => {
    desktopLyricDisplayMetricsTimer = null;
    reconcileDesktopLyricBounds();
  }, 120);
};

const setDesktopLyricForward = (enableForward: boolean) => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (!snapshot.settings.locked) return;
  win.setIgnoreMouseEvents(true, enableForward ? { forward: true } : undefined);
};

const applyDesktopLyricInteractionState = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (desktopLyricIsLocked) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
  }
};

const refreshDesktopLyricInteraction = (useReplay = false) => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (useReplay) {
    scheduleWindowInteractionSync(applyDesktopLyricInteractionState);
    return;
  }
  applyDesktopLyricInteractionState();
};

const refreshDesktopLyricPresentation = (useRestack = false) => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (useRestack) {
    scheduleWindowPresentationSync(snapshot.settings.alwaysOnTop);
    return;
  }
  syncWindowPresentation(snapshot.settings.alwaysOnTop);
};

const onMainWindowMoveOrResize = () => {
  if (!snapshot.settings.locked) return;
  setDesktopLyricForward(false);
  if (desktopLyricForwardRestoreTimer) clearTimeout(desktopLyricForwardRestoreTimer);
  desktopLyricForwardRestoreTimer = setTimeout(() => {
    desktopLyricForwardRestoreTimer = null;
    setDesktopLyricForward(true);
  }, 300);
};

const onMainWindowMoveOrResizeEnd = () => {
  if (!snapshot.settings.locked) return;
  if (desktopLyricForwardRestoreTimer) clearTimeout(desktopLyricForwardRestoreTimer);
  desktopLyricForwardRestoreTimer = null;
  setDesktopLyricForward(true);
  refreshDesktopLyricPresentation(process.platform === 'win32');
};

const bindMainWindowEvents = () => {
  if (desktopLyricMainWindowBound) return;
  const lyricWin = getDesktopLyricWindow();
  const mainWin = BrowserWindow.getAllWindows().find(
    (win) => win !== lyricWin && !win.isDestroyed(),
  );
  if (!mainWin) return;
  desktopLyricMainWindowBound = true;
  mainWin.on('move', onMainWindowMoveOrResize);
  mainWin.on('resize', onMainWindowMoveOrResize);
  if (process.platform !== 'linux') {
    mainWin.on('moved', onMainWindowMoveOrResizeEnd);
    mainWin.on('resized', onMainWindowMoveOrResizeEnd);
  }
};

const unbindMainWindowEvents = () => {
  if (!desktopLyricMainWindowBound) return;
  desktopLyricMainWindowBound = false;
  const lyricWin = getDesktopLyricWindow();
  const mainWin = BrowserWindow.getAllWindows().find(
    (win) => win !== lyricWin && !win.isDestroyed(),
  );
  if (!mainWin) return;
  mainWin.removeListener('move', onMainWindowMoveOrResize);
  mainWin.removeListener('resize', onMainWindowMoveOrResize);
  if (process.platform !== 'linux') {
    mainWin.removeListener('moved', onMainWindowMoveOrResizeEnd);
    mainWin.removeListener('resized', onMainWindowMoveOrResizeEnd);
  }
  if (desktopLyricForwardRestoreTimer) {
    clearTimeout(desktopLyricForwardRestoreTimer);
    desktopLyricForwardRestoreTimer = null;
  }
};

const destroyDesktopLyricWindowFromFailure = (reason: 'unresponsive' | 'render-process-gone') => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed() || desktopLyricClosingFromFailure) return;
  desktopLyricClosingFromFailure = true;
  console.error(`[DesktopLyric] Window destroyed due to ${reason}`);
  win.destroy();
};

export const ensureDesktopLyricWindow = async () => {
  const existing = getDesktopLyricWindow();
  if (existing && !existing.isDestroyed()) return existing;

  const win = createDesktopLyricWindow();

  win.once('ready-to-show', () => {
    refreshDesktopLyricPresentation();
    refreshDesktopLyricInteraction(true);
    sendSnapshot();
    bindMainWindowEvents();
  });

  win.on('hide', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    clearWindowInteractionTimers();
    clearWindowPresentationTimers();
    unbindMainWindowEvents();
    setDesktopLyricLockPhase('idle');
  });

  win.on('closed', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    clearWindowInteractionTimers();
    clearWindowPresentationTimers();
    unbindMainWindowEvents();
    withDesktopLyricWindow(null);
    desktopLyricClosingFromFailure = false;

    const appIsQuitting = !app.isReady() || desktopLyricAppIsQuitting;
    snapshot = {
      ...snapshot,
      lockPhase: 'idle',
      settings: {
        ...snapshot.settings,
        enabled: appIsQuitting ? snapshot.settings.enabled : false,
      },
    };

    if (!appIsQuitting) {
      setDesktopLyricEnabledFlag(false);
      sendSnapshot();
    }
  });

  win.on('unresponsive', () => {
    destroyDesktopLyricWindowFromFailure('unresponsive');
  });

  win.webContents.on('render-process-gone', () => {
    destroyDesktopLyricWindowFromFailure('render-process-gone');
  });

  await loadDesktopLyricWindow();

  return win;
};

export const showDesktopLyricWindow = async () => {
  const win = await ensureDesktopLyricWindow();
  if (win.isMinimized()) {
    if (typeof win.restore === 'function') win.restore();
    win.showInactive();
  }
  if (!win.isVisible()) win.showInactive();
  refreshDesktopLyricInteraction(true);
  refreshDesktopLyricPresentation(true);
  bindMainWindowEvents();
  sendSnapshot();
  return snapshot;
};

export const closeDesktopLyricWindow = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  win.close();
};

export const destroyDesktopLyricWindow = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  clearDesktopLyricDisplayMetricsTimer();
  clearDesktopLyricLockPhaseTimer();
  clearWindowInteractionTimers();
  clearWindowPresentationTimers();
  unbindMainWindowEvents();
  withDesktopLyricWindow(null);
  win.destroy();
};

export const updateDesktopLyricSettings = async (partial: Partial<DesktopLyricSettings>) => {
  const current = snapshot.settings;
  const nextSettings = sanitizeDesktopLyricSettings(partial, current);

  snapshot = {
    ...snapshot,
    settings: nextSettings,
  };

  persistDesktopLyricSettings(nextSettings);

  const storedWindowState = getDesktopLyricWindowState();
  const win = getDesktopLyricWindow();
  const currentBounds = win && !win.isDestroyed() ? win.getBounds() : null;
  const nextWindowState = constrainBoundsToDisplay({
    width: currentBounds?.width ?? storedWindowState.width,
    height: currentBounds?.height ?? storedWindowState.height,
    x: currentBounds?.x ?? storedWindowState.x,
    y: currentBounds?.y ?? storedWindowState.y,
  });
  persistDesktopLyricWindowState(nextWindowState);

  if (win && !win.isDestroyed()) {
    win.setMinimumSize(DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MIN_HEIGHT);
    win.setMaximumSize(DESKTOP_LYRIC_MAX_WIDTH, DESKTOP_LYRIC_MAX_HEIGHT);
    refreshDesktopLyricInteraction(nextSettings.enabled);
    refreshDesktopLyricPresentation();

    if (nextSettings.enabled) {
      if (!win.isVisible()) win.showInactive();
      refreshDesktopLyricInteraction(true);
      refreshDesktopLyricPresentation(process.platform === 'win32');
    } else if (win.isVisible()) {
      win.hide();
    }
  } else if (nextSettings.enabled) {
    await showDesktopLyricWindow();
  }

  sendSnapshot();
  return snapshot;
};

export const toggleDesktopLyricLock = async () => {
  const nextLocked = !desktopLyricIsLocked;
  desktopLyricIsLocked = nextLocked;
  setDesktopLyricLockPhase(nextLocked ? 'locking' : 'unlocking', true);

  refreshDesktopLyricInteraction(true);

  snapshot = { ...snapshot, settings: { ...snapshot.settings, locked: nextLocked } };
  setDesktopLyricLockedFlag(nextLocked);
  sendSnapshot();
  return snapshot;
};

export const getDesktopLyricSnapshot = () => snapshot;

export const registerDesktopLyricHandlers = () => {
  ipcMain.handle('desktop-lyric:get-snapshot', () => getDesktopLyricSnapshot());

  ipcMain.handle('desktop-lyric:show', async () => {
    const result = await updateDesktopLyricSettings({ enabled: true });
    await showDesktopLyricWindow();
    return result;
  });

  ipcMain.handle('desktop-lyric:hide', async () => {
    const result = await updateDesktopLyricSettings({ enabled: false });
    closeDesktopLyricWindow();
    return result;
  });

  ipcMain.handle('desktop-lyric:toggle-lock', async () => toggleDesktopLyricLock());

  ipcMain.handle(
    'desktop-lyric:update-settings',
    async (_event, payload: Partial<DesktopLyricSettings>) =>
      updateDesktopLyricSettings(payload ?? {}),
  );

  ipcMain.on('desktop-lyric:sync-snapshot', (_event, payload: DesktopLyricSnapshotPatch) => {
    if (!payload) return;
    if (payload.playback !== undefined) snapshot = { ...snapshot, playback: payload.playback };
    if (payload.lyrics !== undefined) snapshot = { ...snapshot, lyrics: payload.lyrics };
    if (payload.currentIndex !== undefined) {
      snapshot = { ...snapshot, currentIndex: payload.currentIndex };
    }
    if (payload.lyricSyncWarning !== undefined) {
      snapshot = { ...snapshot, lyricSyncWarning: payload.lyricSyncWarning };
    }
    if (payload.settings) {
      snapshot = { ...snapshot, settings: { ...snapshot.settings, ...payload.settings } };
    }
    sendSnapshot();
  });

  ipcMain.on('desktop-lyric:set-ignore-mouse-events', (_event, ignore: boolean) => {
    const win = getDesktopLyricWindow();
    if (!win || win.isDestroyed()) return;
    if (ignore) {
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      win.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on(
    'desktop-lyric:move',
    (_event, x: number, y: number, width: number, height: number) => {
      const win = getDesktopLyricWindow();
      if (!win || win.isDestroyed()) return;
      applyWindowBounds({
        x,
        y,
        width,
        height,
      });
      persistDesktopLyricWindowState({ x, y, width, height });
    },
  );

  ipcMain.on('desktop-lyric:resize', (_event, width: number, height: number) => {
    const win = getDesktopLyricWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    applyWindowBounds({
      x: bounds.x,
      y: bounds.y,
      width,
      height,
    });
    persistDesktopLyricWindowState({
      ...bounds,
      width,
      height,
    });
  });

  ipcMain.on('desktop-lyric:set-height', (_event, height: number) => {
    updateWindowHeight(height);
  });

  ipcMain.on(
    'desktop-lyric:toggle-fixed-size',
    (_event, options: { width: number; height: number; fixed: boolean }) => {
      setDesktopLyricFixedSize(options);
    },
  );

  ipcMain.handle('desktop-lyric:get-bounds', () => {
    const win = getDesktopLyricWindow();
    if (!win || win.isDestroyed()) return {};
    return win.getBounds();
  });

  ipcMain.handle('desktop-lyric:get-virtual-screen-bounds', () => {
    return getDesktopLyricVirtualScreenBounds();
  });

  ipcMain.on(
    'desktop-lyric:command',
    (
      _event,
      command:
        | 'togglePlayback'
        | 'previousTrack'
        | 'nextTrack'
        | 'toggleLyricsMode'
        | 'cycleLyricsMode',
    ) => {
      const lyricWin = getDesktopLyricWindow();
      const focusedMainWindow = BrowserWindow.getAllWindows().find(
        (win) => win !== lyricWin && !win.isDestroyed(),
      );
      if (!focusedMainWindow) return;
      focusedMainWindow.webContents.send('shortcut-trigger', command);
    },
  );
};

nativeTheme.on('updated', () => {
  if (snapshot.settings.theme !== 'system') return;
  sendSnapshot();
});

let desktopLyricDisplayListenersInstalled = false;

const installDesktopLyricDisplayListeners = () => {
  if (desktopLyricDisplayListenersInstalled) return;
  desktopLyricDisplayListenersInstalled = true;
  screen.on('display-added', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-removed', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-metrics-changed', scheduleDesktopLyricBoundsReconcile);
};

if (app.isReady()) {
  installDesktopLyricDisplayListeners();
} else {
  void app.whenReady().then(() => {
    installDesktopLyricDisplayListeners();
  });
}
