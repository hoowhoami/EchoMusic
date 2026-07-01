import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import type {
  DesktopLyricCommand,
  DesktopLyricLockPhase,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotMessage,
  DesktopLyricSnapshotPatch,
  DesktopLyricWindowBoundsUpdate,
} from '../shared/desktop-lyric';
import {
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
  applyWindowSizeLimits,
  applyWindowBounds,
  clearWindowPresentationTimers,
  clearWindowInteractionTimers,
  createDesktopLyricWindow,
  getDesktopLyricWindow,
  loadDesktopLyricWindow,
  schedulePersistWindowBounds,
  scheduleWindowInteractionSync,
  scheduleWindowPresentationSync,
  setDesktopLyricFixedSize,
  syncWindowPresentation,
  updateWindowBounds,
  updateWindowHeight,
  withDesktopLyricWindow,
} from './desktopLyric/window';
import log from './logger';
import { showMainWindow, getMainWindow } from './window';
import { getActiveWindowMode } from './windowMode';
import { closeMiniPlayerWindow } from './miniPlayer';
import { ipcRegistry } from './ipc/registry';
import { refreshTrayMenus } from './tray';

export { getDesktopLyricWindow } from './desktopLyric/window';

const DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS = 320;

let desktopLyricIsLocked = false;
let desktopLyricClosingFromFailure = false;
let desktopLyricAppIsQuitting = false;
let desktopLyricDisplayMetricsTimer: NodeJS.Timeout | null = null;
let desktopLyricLockPhaseTimer: NodeJS.Timeout | null = null;
let desktopLyricForwardRestoreTimer: NodeJS.Timeout | null = null;
let desktopLyricMainWindowBound = false;
let desktopLyricIgnoreMouseEventsKey: string | null = null;
// 锁定状态下用光标轮询可靠检测鼠标进出窗口，规避 forward 穿透模式下
// mouseleave 不可靠（尤其 Windows）导致解锁按钮卡住不消失的问题
let desktopLyricHoverPollTimer: NodeJS.Timeout | null = null;
let desktopLyricCursorInside = false;
const DESKTOP_LYRIC_HOVER_POLL_INTERVAL_MS = 150;

app.on('before-quit', () => {
  desktopLyricAppIsQuitting = true;
});

let snapshot: DesktopLyricSnapshot = {
  playback: null,
  lyricsTrackId: null,
  lyricsRevision: 0,
  lyrics: [],
  currentIndex: -1,
  lyricTimeOffset: 0,
  settings: getDesktopLyricSettings(),
  lockPhase: 'idle',
};
desktopLyricIsLocked = snapshot.settings.locked;

const sendSnapshotToWindow = (
  win: BrowserWindow | null | undefined,
  message: DesktopLyricSnapshotMessage = snapshot,
) => {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('desktop-lyric:snapshot', message);
  } catch {
    // ignore destroyed frames while broadcasting
  }
};

const sendSnapshot = (
  scope: 'desktop' | 'settings' = 'settings',
  message: DesktopLyricSnapshotMessage = snapshot,
) => {
  const lyricWin = getDesktopLyricWindow();
  sendSnapshotToWindow(lyricWin, message);

  if (scope === 'desktop') return;

  const mainWin = getMainWindow();
  if (mainWin && mainWin !== lyricWin) sendSnapshotToWindow(mainWin, message);
};

const clearDesktopLyricLockPhaseTimer = () => {
  if (!desktopLyricLockPhaseTimer) return;
  clearTimeout(desktopLyricLockPhaseTimer);
  desktopLyricLockPhaseTimer = null;
};

const resetDesktopLyricIgnoreMouseEventsCache = () => {
  desktopLyricIgnoreMouseEventsKey = null;
};

const applyDesktopLyricIgnoreMouseEvents = (
  ignore: boolean,
  options?: { forward?: boolean; force?: boolean },
) => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;

  const forward = Boolean(ignore && options?.forward);
  const nextKey = `${ignore ? '1' : '0'}:${forward ? '1' : '0'}`;
  if (!options?.force && desktopLyricIgnoreMouseEventsKey === nextKey) return;
  desktopLyricIgnoreMouseEventsKey = nextKey;
  win.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined);
};

const DESKTOP_LYRIC_RENDERER_COMMANDS = new Set<DesktopLyricCommand>([
  'toggleTranslation',
  'toggleRomanization',
  'lyricOffsetBackward',
  'lyricOffsetForward',
  'lyricOffsetReset',
]);

const setDesktopLyricLockPhase = (phase: DesktopLyricLockPhase, withCooldown = false) => {
  clearDesktopLyricLockPhaseTimer();
  if (snapshot.lockPhase !== phase) {
    snapshot = {
      ...snapshot,
      lockPhase: phase,
    };
    sendSnapshot('desktop');
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

const toFiniteNumber = (value: unknown, fallback: number) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const toOptionalFiniteNumber = (value: unknown, fallback?: number) => {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const buildDesktopLyricWindowBounds = (patch: DesktopLyricWindowBoundsUpdate) => {
  const win = getDesktopLyricWindow();
  const storedWindowState = getDesktopLyricWindowState();
  const currentBounds = win && !win.isDestroyed() ? win.getBounds() : null;
  return constrainBoundsToDisplay({
    width: toFiniteNumber(patch.width, currentBounds?.width ?? storedWindowState.width),
    height: toFiniteNumber(patch.height, currentBounds?.height ?? storedWindowState.height),
    x: toOptionalFiniteNumber(patch.x, currentBounds?.x ?? storedWindowState.x),
    y: toOptionalFiniteNumber(patch.y, currentBounds?.y ?? storedWindowState.y),
  });
};

export const updateDesktopLyricWindowBounds = (patch: DesktopLyricWindowBoundsUpdate = {}) => {
  const nextWindowState = buildDesktopLyricWindowBounds(patch);
  persistDesktopLyricWindowState(nextWindowState);
  const win = getDesktopLyricWindow();
  if (win && !win.isDestroyed()) {
    applyWindowSizeLimits();
    return updateWindowBounds(nextWindowState);
  }
  return nextWindowState;
};

const getLayoutPreferredBounds = (
  bounds: { x?: number; y?: number; width: number; height: number },
  layout: DesktopLyricSettings['layout'],
) => {
  const shouldUseVerticalPreset = layout === 'vertical' && bounds.width >= bounds.height;
  const shouldUseHorizontalPreset = layout === 'horizontal' && bounds.height > bounds.width;
  if (!shouldUseVerticalPreset && !shouldUseHorizontalPreset) return bounds;

  const width = shouldUseVerticalPreset ? 240 : 800;
  const height = shouldUseVerticalPreset ? 720 : 180;
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return { width, height };
  }
  const centerX = (bounds.x ?? 0) + bounds.width / 2;
  const centerY = (bounds.y ?? 0) + bounds.height / 2;
  return {
    width,
    height,
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
  };
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
  if (!snapshot.settings.locked) return;
  applyDesktopLyricIgnoreMouseEvents(true, { forward: enableForward });
};

const sendDesktopLyricHover = (hovered: boolean) => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send('desktop-lyric:hover', hovered);
  } catch {
    // 窗口正在销毁时忽略
  }
};

const stopDesktopLyricHoverPolling = () => {
  if (desktopLyricHoverPollTimer) {
    clearInterval(desktopLyricHoverPollTimer);
    desktopLyricHoverPollTimer = null;
  }
  desktopLyricCursorInside = false;
};

const pollDesktopLyricHover = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed() || !win.isVisible() || !desktopLyricIsLocked) {
    stopDesktopLyricHoverPolling();
    return;
  }
  let inside = false;
  try {
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    inside =
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height;
  } catch {
    return;
  }
  if (inside === desktopLyricCursorInside) return;
  desktopLyricCursorInside = inside;
  // 鼠标离开窗口时强制恢复穿透，避免之前停留在解锁按钮上取消的穿透残留
  if (!inside) {
    applyDesktopLyricIgnoreMouseEvents(true, { forward: true, force: true });
  }
  sendDesktopLyricHover(inside);
};

const startDesktopLyricHoverPolling = () => {
  if (desktopLyricHoverPollTimer) return;
  desktopLyricCursorInside = false;
  desktopLyricHoverPollTimer = setInterval(
    pollDesktopLyricHover,
    DESKTOP_LYRIC_HOVER_POLL_INTERVAL_MS,
  );
};

const applyDesktopLyricInteractionState = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (desktopLyricIsLocked) {
    applyDesktopLyricIgnoreMouseEvents(true, { forward: true, force: true });
    startDesktopLyricHoverPolling();
  } else {
    applyDesktopLyricIgnoreMouseEvents(false, { force: true });
    stopDesktopLyricHoverPolling();
    // 解锁后通知渲染进程隐藏解锁按钮，避免残留 hover 状态
    sendDesktopLyricHover(false);
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
  // 查找主窗口，忽略已销毁的窗口和桌面歌词窗口
  const mainWin = BrowserWindow.getAllWindows().find(
    (win) => win !== lyricWin && !win.isDestroyed(),
  );
  // 即使找不到主窗口，也要清理定时器
  if (desktopLyricForwardRestoreTimer) {
    clearTimeout(desktopLyricForwardRestoreTimer);
    desktopLyricForwardRestoreTimer = null;
  }
  // 如果主窗口已销毁，监听器会自动清理，无需手动移除
  if (!mainWin) return;
  mainWin.removeListener('move', onMainWindowMoveOrResize);
  mainWin.removeListener('resize', onMainWindowMoveOrResize);
  if (process.platform !== 'linux') {
    mainWin.removeListener('moved', onMainWindowMoveOrResizeEnd);
    mainWin.removeListener('resized', onMainWindowMoveOrResizeEnd);
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
    sendSnapshot('desktop');
    bindMainWindowEvents();
  });

  win.on('hide', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    clearWindowInteractionTimers();
    clearWindowPresentationTimers();
    stopDesktopLyricHoverPolling();
    unbindMainWindowEvents();
    setDesktopLyricLockPhase('idle');
  });

  win.on('closed', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    clearWindowInteractionTimers();
    clearWindowPresentationTimers();
    stopDesktopLyricHoverPolling();
    unbindMainWindowEvents();
    resetDesktopLyricIgnoreMouseEventsCache();
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
  sendSnapshot('desktop');
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
  stopDesktopLyricHoverPolling();
  unbindMainWindowEvents();
  resetDesktopLyricIgnoreMouseEventsCache();
  withDesktopLyricWindow(null);
  win.destroy();
};

export const updateDesktopLyricSettings = async (partial: Partial<DesktopLyricSettings>) => {
  const current = snapshot.settings;
  const nextSettings = sanitizeDesktopLyricSettings(partial, current);
  const layoutChanged = current.layout !== nextSettings.layout;
  const shouldRefreshMenus =
    current.enabled !== nextSettings.enabled || current.locked !== nextSettings.locked;

  snapshot = {
    ...snapshot,
    settings: nextSettings,
  };

  persistDesktopLyricSettings(nextSettings);

  const storedWindowState = getDesktopLyricWindowState();
  const win = getDesktopLyricWindow();
  const currentBounds = win && !win.isDestroyed() ? win.getBounds() : null;
  const candidateWindowState = {
    width: currentBounds?.width ?? storedWindowState.width,
    height: currentBounds?.height ?? storedWindowState.height,
    x: currentBounds?.x ?? storedWindowState.x,
    y: currentBounds?.y ?? storedWindowState.y,
  };
  const nextWindowState = constrainBoundsToDisplay(
    layoutChanged
      ? getLayoutPreferredBounds(candidateWindowState, nextSettings.layout)
      : candidateWindowState,
  );
  persistDesktopLyricWindowState(nextWindowState);

  if (win && !win.isDestroyed()) {
    applyWindowSizeLimits();
    if (layoutChanged) {
      updateWindowBounds(nextWindowState);
    }

    if (nextSettings.enabled) {
      refreshDesktopLyricInteraction(true);
      refreshDesktopLyricPresentation();
      if (!win.isVisible()) win.showInactive();
      refreshDesktopLyricInteraction(true);
      refreshDesktopLyricPresentation(process.platform === 'win32');
    } else {
      destroyDesktopLyricWindow();
    }
  } else if (nextSettings.enabled) {
    await showDesktopLyricWindow();
  }

  sendSnapshot();
  if (shouldRefreshMenus) refreshTrayMenus();
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
  refreshTrayMenus();
  return snapshot;
};

export const getDesktopLyricSnapshot = () => snapshot;

export const registerDesktopLyricHandlers = () => {
  ipcRegistry.registerHandler('desktop-lyric:get-snapshot', () => getDesktopLyricSnapshot());

  ipcRegistry.registerHandler('desktop-lyric:get-window', () => {
    const win = getDesktopLyricWindow();
    if (win && !win.isDestroyed()) return win.getBounds();
    const storedWindowState = getDesktopLyricWindowState();
    return constrainBoundsToDisplay(storedWindowState);
  });

  ipcRegistry.registerHandler('desktop-lyric:show', async () => {
    const result = await updateDesktopLyricSettings({ enabled: true });
    await showDesktopLyricWindow();
    return result;
  });

  ipcRegistry.registerHandler('desktop-lyric:hide', async () => {
    const result = await updateDesktopLyricSettings({ enabled: false });
    closeDesktopLyricWindow();
    return result;
  });

  ipcRegistry.registerHandler('desktop-lyric:toggle-lock', async () => toggleDesktopLyricLock());

  ipcRegistry.registerHandler(
    'desktop-lyric:update-settings',
    async (_event, payload: Partial<DesktopLyricSettings>) =>
      updateDesktopLyricSettings(payload ?? {}),
  );

  ipcRegistry.registerHandler(
    'desktop-lyric:update-window',
    (_event, payload: DesktopLyricWindowBoundsUpdate) =>
      updateDesktopLyricWindowBounds(payload ?? {}),
  );

  ipcRegistry.registerListener(
    'desktop-lyric:sync-snapshot',
    (_event, payload: DesktopLyricSnapshotPatch) => {
      if (!payload) return;
      let shouldRefreshMenus = false;
      let desktopPatch: DesktopLyricSnapshotPatch = {};
      if (payload.playback !== undefined) {
        const nextLyricsTrackId = payload.playback?.lyricHash || payload.playback?.trackId || null;
        const trackChanged = nextLyricsTrackId !== snapshot.lyricsTrackId;
        snapshot = {
          ...snapshot,
          playback: payload.playback,
          ...(trackChanged
            ? {
                lyricsTrackId: nextLyricsTrackId,
                lyricsRevision: snapshot.lyricsRevision + 1,
                lyrics: [],
                currentIndex: -1,
                lyricTimeOffset: 0,
              }
            : {}),
        };
        desktopPatch = {
          ...desktopPatch,
          playback: snapshot.playback,
          ...(trackChanged
            ? {
                lyricsTrackId: snapshot.lyricsTrackId,
                lyricsRevision: snapshot.lyricsRevision,
                lyrics: snapshot.lyrics,
                currentIndex: snapshot.currentIndex,
                lyricTimeOffset: snapshot.lyricTimeOffset,
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
          desktopPatch = {
            ...desktopPatch,
            lyricsTrackId: snapshot.lyricsTrackId,
            lyricsRevision: snapshot.lyricsRevision,
            lyrics: snapshot.lyrics,
          };
        }
      } else if (payload.lyricsTrackId !== undefined) {
        const activeLyricsTrackId =
          snapshot.playback?.lyricHash || snapshot.playback?.trackId || null;
        if (payload.lyricsTrackId === activeLyricsTrackId) {
          snapshot = { ...snapshot, lyricsTrackId: payload.lyricsTrackId };
          desktopPatch = { ...desktopPatch, lyricsTrackId: snapshot.lyricsTrackId };
        }
      }
      if (payload.currentIndex !== undefined) {
        snapshot = { ...snapshot, currentIndex: payload.currentIndex };
        desktopPatch = { ...desktopPatch, currentIndex: snapshot.currentIndex };
      }
      if (payload.lyricTimeOffset !== undefined) {
        snapshot = { ...snapshot, lyricTimeOffset: Number(payload.lyricTimeOffset) || 0 };
        desktopPatch = { ...desktopPatch, lyricTimeOffset: snapshot.lyricTimeOffset };
      }
      if (payload.lyricSyncWarning !== undefined) {
        snapshot = { ...snapshot, lyricSyncWarning: payload.lyricSyncWarning };
        desktopPatch = { ...desktopPatch, lyricSyncWarning: snapshot.lyricSyncWarning };
      }
      if (payload.settings) {
        const currentSettings = snapshot.settings;
        const nextSettings = { ...currentSettings, ...payload.settings };
        shouldRefreshMenus =
          currentSettings.enabled !== nextSettings.enabled ||
          currentSettings.locked !== nextSettings.locked;
        snapshot = { ...snapshot, settings: nextSettings };
      }
      if (payload.settings) {
        sendSnapshot('settings');
      } else {
        sendSnapshot('desktop', desktopPatch);
      }
      if (shouldRefreshMenus) refreshTrayMenus();
    },
  );

  ipcRegistry.registerListener(
    'desktop-lyric:set-ignore-mouse-events',
    (_event, ignore: boolean) => {
      if (ignore) {
        applyDesktopLyricIgnoreMouseEvents(true, { forward: true });
      } else {
        applyDesktopLyricIgnoreMouseEvents(false);
      }
    },
  );

  ipcRegistry.registerListener(
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
      schedulePersistWindowBounds();
    },
  );

  ipcRegistry.registerListener('desktop-lyric:resize', (_event, width: number, height: number) => {
    const win = getDesktopLyricWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    applyWindowBounds({
      x: bounds.x,
      y: bounds.y,
      width,
      height,
    });
    schedulePersistWindowBounds();
  });

  ipcRegistry.registerListener('desktop-lyric:set-height', (_event, height: number) => {
    updateWindowHeight(height);
  });

  ipcRegistry.registerListener(
    'desktop-lyric:toggle-fixed-size',
    (_event, options: { width: number; height: number; fixed: boolean }) => {
      setDesktopLyricFixedSize(options);
    },
  );

  ipcRegistry.registerHandler('desktop-lyric:get-bounds', () => {
    const win = getDesktopLyricWindow();
    if (!win || win.isDestroyed()) return {};
    return win.getBounds();
  });

  ipcRegistry.registerHandler('desktop-lyric:get-virtual-screen-bounds', () => {
    return getDesktopLyricVirtualScreenBounds();
  });

  ipcRegistry.registerListener('desktop-lyric:command', (_event, command: DesktopLyricCommand) => {
    const lyricWin = getDesktopLyricWindow();
    const focusedMainWindow = BrowserWindow.getAllWindows().find(
      (win) => win !== lyricWin && !win.isDestroyed(),
    );
    if (!focusedMainWindow) return;
    if (DESKTOP_LYRIC_RENDERER_COMMANDS.has(command)) {
      const mainWin = getMainWindow();
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.webContents.send('desktop-lyric:command', command);
      return;
    }
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
  });
};

let desktopLyricNativeThemeHandler: (() => void) | null = null;
let desktopLyricDisplayListenersInstalled = false;

const installDesktopLyricDisplayListeners = () => {
  if (desktopLyricDisplayListenersInstalled) return;
  desktopLyricDisplayListenersInstalled = true;
  screen.on('display-added', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-removed', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-metrics-changed', scheduleDesktopLyricBoundsReconcile);
};

const uninstallDesktopLyricDisplayListeners = () => {
  if (!desktopLyricDisplayListenersInstalled) return;
  desktopLyricDisplayListenersInstalled = false;
  screen.removeListener('display-added', scheduleDesktopLyricBoundsReconcile);
  screen.removeListener('display-removed', scheduleDesktopLyricBoundsReconcile);
  screen.removeListener('display-metrics-changed', scheduleDesktopLyricBoundsReconcile);
};

const installDesktopLyricNativeThemeListener = () => {
  if (desktopLyricNativeThemeHandler) return;
  desktopLyricNativeThemeHandler = () => {
    if (snapshot.settings.theme !== 'system') return;
    sendSnapshot('desktop');
  };
  nativeTheme.on('updated', desktopLyricNativeThemeHandler);
};

const uninstallDesktopLyricNativeThemeListener = () => {
  if (!desktopLyricNativeThemeHandler) return;
  nativeTheme.removeListener('updated', desktopLyricNativeThemeHandler);
  desktopLyricNativeThemeHandler = null;
};

export const cleanupDesktopLyric = () => {
  uninstallDesktopLyricDisplayListeners();
  uninstallDesktopLyricNativeThemeListener();
  clearDesktopLyricDisplayMetricsTimer();
  clearDesktopLyricLockPhaseTimer();
  stopDesktopLyricHoverPolling();
  if (desktopLyricForwardRestoreTimer) {
    clearTimeout(desktopLyricForwardRestoreTimer);
    desktopLyricForwardRestoreTimer = null;
  }
  unbindMainWindowEvents();
};

if (app.isReady()) {
  installDesktopLyricDisplayListeners();
  installDesktopLyricNativeThemeListener();
} else {
  void app.whenReady().then(() => {
    installDesktopLyricDisplayListeners();
    installDesktopLyricNativeThemeListener();
  });
}
