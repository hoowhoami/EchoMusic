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
import log from './logger';
import { showMainWindow, getMainWindow } from './window';
import { getActiveWindowMode } from './windowMode';
import { closeMiniPlayerWindow } from './miniPlayer';

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
  lyricsTrackId: null,
  lyricsRevision: 0,
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
  log.error('[DesktopLyric]', `Window destroyed due to ${reason}`);
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
  // 如果窗口已经就绪且不可见，则显示
  if (win.isVisible()) {
    if (win.isMinimized()) {
      if (typeof win.restore === 'function') win.restore();
    }
  } else {
    // 如果窗口还未显示（可能是刚创建正在等待 ready-to-show，或者是之前 hide 了）
    // 对于刚创建的情况，ready-to-show 回调会自动处理显示。
    // 对于 hide 后的情况，我们需要手动调用显示。
    // 注意：Electron 的 isVisible() 在 show:false 时返回 false。
    // 我们在这里仅处理非初次创建（已 ready）的情况。
    // 我们可以通过 check if window is already loaded.
  }

  // 简化逻辑：仅触发必要的刷新，让 ready-to-show 负责初次显示，
  // 如果已经 ready 过了且被隐藏了，则手动显示。
  if (!win.isVisible() && win.webContents.getURL()) {
    win.showInactive();
  }

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
    if (payload.playback !== undefined) {
      const nextLyricsTrackId = payload.playback?.lyricHash || payload.playback?.trackId || null;
      snapshot = {
        ...snapshot,
        playback: payload.playback,
        ...(nextLyricsTrackId !== snapshot.lyricsTrackId
          ? {
              lyricsTrackId: nextLyricsTrackId,
              lyricsRevision: snapshot.lyricsRevision + 1,
              lyrics: [],
              currentIndex: -1,
            }
          : {}),
      };
    }
    if (payload.lyrics !== undefined) {
      const activeLyricsTrackId =
        snapshot.playback?.lyricHash || snapshot.playback?.trackId || null;
      const nextLyricsTrackId =
        payload.lyricsTrackId !== undefined ? payload.lyricsTrackId : activeLyricsTrackId;
      if (nextLyricsTrackId === activeLyricsTrackId) {
        snapshot = {
          ...snapshot,
          lyricsTrackId: nextLyricsTrackId,
          lyricsRevision: snapshot.lyricsRevision + 1,
          lyrics: payload.lyrics,
        };
      }
    } else if (payload.lyricsTrackId !== undefined) {
      const activeLyricsTrackId =
        snapshot.playback?.lyricHash || snapshot.playback?.trackId || null;
      if (payload.lyricsTrackId === activeLyricsTrackId) {
        snapshot = { ...snapshot, lyricsTrackId: payload.lyricsTrackId };
      }
    }
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
        | 'cycleLyricsMode'
        | 'openLyricSource',
    ) => {
      const lyricWin = getDesktopLyricWindow();
      const focusedMainWindow = BrowserWindow.getAllWindows().find(
        (win) => win !== lyricWin && !win.isDestroyed(),
      );
      if (!focusedMainWindow) return;
      if (command === 'openLyricSource') {
        if (getActiveWindowMode() === 'mini') {
          closeMiniPlayerWindow();
        }
        showMainWindow();
        const mainWin = getMainWindow();
        if (!mainWin || mainWin.isDestroyed()) return;
        setTimeout(() => {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('shortcut-trigger', command);
          }
        }, 300);
        return;
      }
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
