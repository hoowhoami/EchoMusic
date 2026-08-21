import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import type {
  DesktopLyricCommand,
  DesktopLyricClientRect,
  DesktopLyricLockPhase,
  DesktopLyricPlaybackPayload,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotMessage,
  DesktopLyricSnapshotPatch,
  DesktopLyricWindowBoundsUpdate,
} from '../shared/desktop-lyric';
import { isWaylandWindowingBackend } from '../shared/windowing';
import {
  acceptPlaybackBridgeRendererPayload,
  beginPlaybackBridgeTransition,
  createPlaybackBridgeState,
  isSamePlaybackSnapshot,
  shouldAcceptPlaybackSnapshot,
  patchPlaybackSnapshot,
  shouldApplyPlaybackBridgePatch,
  type PlaybackSnapshotPatch,
} from '../shared/playback';
import {
  constrainBoundsToDisplay,
  getDesktopLyricSettings,
  getDesktopLyricWindowLimits,
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
  flushPersistWindowBounds,
  scheduleWindowInteractionSync,
  scheduleWindowPresentationSync,
  syncWindowPresentation,
  updateWindowBounds,
  withDesktopLyricWindow,
} from './desktopLyric/window';
import log from './logger';
import { showMainWindow, getMainWindow } from './window';
import { getActiveWindowMode } from './window/mode';
import { closeMiniPlayerWindow } from './miniPlayer';
import { ipcRegistry } from './ipc/registry';
import { refreshTrayMenus } from './tray';
import { WindowDragController } from './windowDrag';

export { getDesktopLyricWindow } from './desktopLyric/window';

const DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS = 320;
const desktopLyricUsesWayland = isWaylandWindowingBackend();
const desktopLyricSupportsForwardedMouseEvents =
  process.platform === 'darwin' || process.platform === 'win32';
const desktopLyricUsesX11HitTesting = process.platform === 'linux' && !desktopLyricUsesWayland;

let desktopLyricClosingFromFailure = false;
let desktopLyricAppIsQuitting = false;
let desktopLyricDisplayMetricsTimer: NodeJS.Timeout | null = null;
let desktopLyricLockPhaseTimer: NodeJS.Timeout | null = null;
let desktopLyricForwardRestoreTimer: NodeJS.Timeout | null = null;
let desktopLyricMainWindowBound = false;
let desktopLyricIgnoreMouseEventsKey: string | null = null;
// 用光标轮询可靠检测鼠标进出窗口：锁定状态规避 forward 穿透下 mouseleave
// 不可靠的问题，解锁状态为渲染进程的即时 hover 提供最终一致性兜底。
let desktopLyricHoverPollTimer: NodeJS.Timeout | null = null;
let desktopLyricCursorInside = false;
let desktopLyricCursorOverUnlockButton = false;
let desktopLyricUnlockButtonBounds: DesktopLyricClientRect | null = null;
const desktopLyricDragController = new WindowDragController({
  getWindow: getDesktopLyricWindow,
  getTargetWebContents: () => getDesktopLyricWindow()?.webContents ?? null,
  isAvailable: () => !desktopLyricUsesWayland,
  canStart: () => !snapshot.settings.locked,
  transformBounds: (bounds) => {
    const limits = getDesktopLyricWindowLimits();
    return {
      ...bounds,
      width: Math.min(limits.maxWidth, Math.max(limits.minWidth, bounds.width)),
      height: Math.min(limits.maxHeight, Math.max(limits.minHeight, bounds.height)),
    };
  },
  persist: schedulePersistWindowBounds,
  rollback: (origin) => {
    applyWindowBounds(origin);
    flushPersistWindowBounds();
  },
});
const cancelDesktopLyricSessions = () => {
  const cancelled = desktopLyricDragController.cancelAll();
  return {
    drag: cancelled.kind === 'drag' ? cancelled.bounds : null,
    resize: cancelled.kind === 'resize' ? cancelled.bounds : null,
  };
};
const DESKTOP_LYRIC_HOVER_POLL_INTERVAL_MS = 150;
const desktopLyricPlaybackBridge = createPlaybackBridgeState();

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

  const forward = Boolean(ignore && options?.forward && desktopLyricSupportsForwardedMouseEvents);
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
  persistDesktopLyricWindowState(
    desktopLyricUsesWayland ? { width: bounds.width, height: bounds.height } : bounds,
  );
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
    x: toOptionalFiniteNumber(
      patch.x,
      desktopLyricUsesWayland ? storedWindowState.x : (currentBounds?.x ?? storedWindowState.x),
    ),
    y: toOptionalFiniteNumber(
      patch.y,
      desktopLyricUsesWayland ? storedWindowState.y : (currentBounds?.y ?? storedWindowState.y),
    ),
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
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  if (desktopLyricUsesWayland) {
    persistWindowBounds();
    const storedWindowState = getDesktopLyricWindowState();
    return { ...storedWindowState, width: bounds.width, height: bounds.height };
  }
  const nextBounds = constrainBoundsToDisplay(bounds);
  const changed =
    bounds.x !== nextBounds.x ||
    bounds.y !== nextBounds.y ||
    bounds.width !== nextBounds.width ||
    bounds.height !== nextBounds.height;
  if (changed) applyWindowBounds(nextBounds);
  persistWindowBounds();
  return changed ? win.getBounds() : bounds;
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
  applyDesktopLyricIgnoreMouseEvents(true, {
    forward: snapshot.settings.showUnlockButton && enableForward,
  });
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
  desktopLyricCursorOverUnlockButton = false;
};

const getDesktopLyricCursorState = () => {
  const win = getDesktopLyricWindow();
  if (desktopLyricUsesWayland || !win || win.isDestroyed() || !win.isVisible()) return null;
  try {
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const inside =
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height;
    return {
      inside,
      clientX: point.x - bounds.x,
      clientY: point.y - bounds.y,
    };
  } catch {
    return null;
  }
};

const getDesktopLyricHoverState = () => getDesktopLyricCursorState()?.inside ?? false;

const isCursorOverDesktopLyricUnlockButton = (
  cursorState: NonNullable<ReturnType<typeof getDesktopLyricCursorState>>,
) => {
  const bounds = desktopLyricUnlockButtonBounds;
  if (!cursorState.inside || !bounds) return false;
  return (
    cursorState.clientX >= bounds.x &&
    cursorState.clientX < bounds.x + bounds.width &&
    cursorState.clientY >= bounds.y &&
    cursorState.clientY < bounds.y + bounds.height
  );
};

const pollDesktopLyricHover = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed() || !win.isVisible()) {
    stopDesktopLyricHoverPolling();
    return;
  }
  const cursorState = getDesktopLyricCursorState();
  const inside = cursorState?.inside ?? false;
  const overUnlockButton = Boolean(
    cursorState &&
    desktopLyricUsesX11HitTesting &&
    snapshot.settings.locked &&
    snapshot.settings.showUnlockButton &&
    isCursorOverDesktopLyricUnlockButton(cursorState),
  );
  if (overUnlockButton !== desktopLyricCursorOverUnlockButton) {
    desktopLyricCursorOverUnlockButton = overUnlockButton;
    // Linux 不支持 setIgnoreMouseEvents 的 forward 选项。X11 下由主进程
    // 轮询光标，只在解锁按钮范围内临时接收鼠标事件。
    if (desktopLyricUsesX11HitTesting && snapshot.settings.locked) {
      applyDesktopLyricIgnoreMouseEvents(!overUnlockButton, { force: true });
    }
  }
  const changed = inside !== desktopLyricCursorInside;
  if (!changed) return;
  desktopLyricCursorInside = inside;
  // 锁定状态下鼠标离开窗口时强制恢复穿透，避免之前停留在解锁按钮上
  // 取消的穿透残留。
  if (changed && snapshot.settings.locked && !inside) {
    applyDesktopLyricIgnoreMouseEvents(true, {
      forward: snapshot.settings.showUnlockButton,
      force: true,
    });
  }
  sendDesktopLyricHover(inside);
};

const startDesktopLyricHoverPolling = () => {
  if (desktopLyricUsesWayland || desktopLyricHoverPollTimer) return;
  desktopLyricCursorInside = false;
  pollDesktopLyricHover();
  desktopLyricHoverPollTimer = setInterval(
    pollDesktopLyricHover,
    DESKTOP_LYRIC_HOVER_POLL_INTERVAL_MS,
  );
};

const applyDesktopLyricInteractionState = () => {
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  if (snapshot.settings.locked) {
    applyDesktopLyricIgnoreMouseEvents(true, {
      forward: snapshot.settings.showUnlockButton && !desktopLyricUsesWayland,
      force: true,
    });
    if (snapshot.settings.showUnlockButton && !desktopLyricUsesWayland) {
      startDesktopLyricHoverPolling();
    } else {
      stopDesktopLyricHoverPolling();
      sendDesktopLyricHover(false);
    }
  } else {
    applyDesktopLyricIgnoreMouseEvents(false, { force: true });
    stopDesktopLyricHoverPolling();
    // 解锁后清掉锁定态 hover。渲染进程负责即时点亮；macOS/Windows/X11
    // 再由整窗光标轮询兜底处理 mouseleave/失焦丢失。
    sendDesktopLyricHover(false);
    if (!desktopLyricUsesWayland) startDesktopLyricHoverPolling();
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
    const cancelled = cancelDesktopLyricSessions();
    if (!win.webContents.isDestroyed()) {
      if (cancelled.drag) win.webContents.send('desktop-lyric:cancel-drag', cancelled.drag);
      if (cancelled.resize) win.webContents.send('desktop-lyric:cancel-resize', cancelled.resize);
    }
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
    desktopLyricUnlockButtonBounds = null;
    desktopLyricDragController.dispose();
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
  desktopLyricDragController.dispose();
  const win = getDesktopLyricWindow();
  if (!win || win.isDestroyed()) return;
  clearDesktopLyricDisplayMetricsTimer();
  clearDesktopLyricLockPhaseTimer();
  clearWindowInteractionTimers();
  clearWindowPresentationTimers();
  stopDesktopLyricHoverPolling();
  unbindMainWindowEvents();
  resetDesktopLyricIgnoreMouseEventsCache();
  desktopLyricUnlockButtonBounds = null;
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

  if (!current.locked && nextSettings.locked) {
    const cancelled = cancelDesktopLyricSessions();
    const win = getDesktopLyricWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:cancel-drag', cancelled.drag);
      win.webContents.send('desktop-lyric:cancel-resize', cancelled.resize);
    }
  }

  persistDesktopLyricSettings(nextSettings);

  const storedWindowState = getDesktopLyricWindowState();
  const win = getDesktopLyricWindow();
  const currentBounds = win && !win.isDestroyed() ? win.getBounds() : null;
  const candidateWindowState = {
    width: currentBounds?.width ?? storedWindowState.width,
    height: currentBounds?.height ?? storedWindowState.height,
    x: desktopLyricUsesWayland ? storedWindowState.x : (currentBounds?.x ?? storedWindowState.x),
    y: desktopLyricUsesWayland ? storedWindowState.y : (currentBounds?.y ?? storedWindowState.y),
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
  const nextLocked = !snapshot.settings.locked;
  snapshot = { ...snapshot, settings: { ...snapshot.settings, locked: nextLocked } };
  if (nextLocked) {
    const cancelled = cancelDesktopLyricSessions();
    const win = getDesktopLyricWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:cancel-drag', cancelled.drag);
      win.webContents.send('desktop-lyric:cancel-resize', cancelled.resize);
    }
  }
  setDesktopLyricLockPhase(nextLocked ? 'locking' : 'unlocking', true);

  refreshDesktopLyricInteraction(true);

  setDesktopLyricLockedFlag(nextLocked);
  sendSnapshot();
  refreshTrayMenus();
  return snapshot;
};

export const getDesktopLyricSnapshot = () => snapshot;

const shouldAcceptPlaybackPayload = (
  next: DesktopLyricPlaybackPayload | null,
  current: DesktopLyricPlaybackPayload | null,
) =>
  shouldAcceptPlaybackSnapshot(next, current, {
    isSamePlayback: isSameDesktopLyricPlayback,
  });

const isSameDesktopLyricPlayback = (
  next: DesktopLyricPlaybackPayload | null,
  current: DesktopLyricPlaybackPayload | null,
) =>
  isSamePlaybackSnapshot(
    next,
    current,
    (nextPlayback, currentPlayback) =>
      nextPlayback.trackId === currentPlayback.trackId &&
      nextPlayback.lyricHash === currentPlayback.lyricHash,
  );

const acceptRendererPlaybackPayload = (playback: DesktopLyricPlaybackPayload | null) =>
  acceptPlaybackBridgeRendererPayload(desktopLyricPlaybackBridge, playback);

const isUsableDesktopLyricWindow = () => {
  const win = getDesktopLyricWindow();
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed());
};

export const beginDesktopLyricPlaybackBridgeTransition = (trackSeq?: number) => {
  beginPlaybackBridgeTransition(desktopLyricPlaybackBridge, trackSeq);
};

export const patchDesktopLyricPlaybackFromPlayer = (patch: PlaybackSnapshotPatch) => {
  const current = snapshot.playback;
  if (!current || !isUsableDesktopLyricWindow()) return;
  if (!shouldApplyPlaybackBridgePatch(desktopLyricPlaybackBridge, current, patch)) return;

  const nextPlayback = patchPlaybackSnapshot(current, patch);
  snapshot = {
    ...snapshot,
    playback: nextPlayback,
  };
  // 同时回传主渲染器，让其更新播放签名，避免继续提交已被原生播放事件
  // 覆盖的旧样本。
  sendSnapshot('settings', { playback: nextPlayback });
};

export const registerDesktopLyricHandlers = () => {
  ipcRegistry.registerHandler('desktop-lyric:get-snapshot', () => getDesktopLyricSnapshot());
  ipcRegistry.registerHandler('desktop-lyric:get-session-nonce', (event) => {
    return desktopLyricDragController.getSessionNonce(event.sender);
  });

  ipcRegistry.registerHandler('desktop-lyric:get-window', () => {
    const win = getDesktopLyricWindow();
    const storedWindowState = getDesktopLyricWindowState();
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      return desktopLyricUsesWayland
        ? { ...storedWindowState, width: bounds.width, height: bounds.height }
        : bounds;
    }
    return constrainBoundsToDisplay(storedWindowState);
  });

  ipcRegistry.registerHandler('desktop-lyric:get-hover', () => getDesktopLyricHoverState());

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
      if (
        payload.playback !== undefined &&
        shouldAcceptPlaybackPayload(payload.playback, snapshot.playback) &&
        acceptRendererPlaybackPayload(payload.playback)
      ) {
        desktopLyricPlaybackBridge.awaitingRenderer = false;
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
        const nextSettings = sanitizeDesktopLyricSettings(payload.settings, currentSettings);
        const interactionChanged =
          currentSettings.locked !== nextSettings.locked ||
          currentSettings.showUnlockButton !== nextSettings.showUnlockButton;
        const presentationChanged = currentSettings.alwaysOnTop !== nextSettings.alwaysOnTop;
        shouldRefreshMenus =
          currentSettings.enabled !== nextSettings.enabled ||
          currentSettings.locked !== nextSettings.locked;
        snapshot = { ...snapshot, settings: nextSettings };
        persistDesktopLyricSettings(nextSettings);
        if (!currentSettings.locked && nextSettings.locked) {
          const cancelled = cancelDesktopLyricSessions();
          const lyricWin = getDesktopLyricWindow();
          if (lyricWin && !lyricWin.isDestroyed()) {
            lyricWin.webContents.send('desktop-lyric:cancel-drag', cancelled.drag);
            lyricWin.webContents.send('desktop-lyric:cancel-resize', cancelled.resize);
          }
        }
        if (interactionChanged) refreshDesktopLyricInteraction(true);
        if (presentationChanged) refreshDesktopLyricPresentation();
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
      if (
        snapshot.settings.locked &&
        (!snapshot.settings.showUnlockButton || desktopLyricUsesWayland)
      ) {
        applyDesktopLyricIgnoreMouseEvents(true, { force: true });
        return;
      }
      if (ignore) {
        applyDesktopLyricIgnoreMouseEvents(true, { forward: true });
      } else {
        applyDesktopLyricIgnoreMouseEvents(false);
      }
    },
  );

  ipcRegistry.registerListener(
    'desktop-lyric:set-unlock-button-bounds',
    (_event, payload: DesktopLyricClientRect | null) => {
      if (!payload) {
        desktopLyricUnlockButtonBounds = null;
        return;
      }
      const { x, y, width, height } = payload;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        desktopLyricUnlockButtonBounds = null;
        return;
      }
      desktopLyricUnlockButtonBounds = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
    },
  );

  ipcRegistry.registerHandler('desktop-lyric:start-drag', (event, sessionId: string) => {
    return desktopLyricDragController.start(sessionId, event.sender);
  });

  ipcRegistry.registerListener(
    'desktop-lyric:move',
    (event, sessionId: string, x: number, y: number) => {
      desktopLyricDragController.move(sessionId, event.sender, x, y);
    },
  );

  ipcRegistry.registerHandler('desktop-lyric:start-resize', (event, sessionId: string) => {
    return desktopLyricDragController.start(sessionId, event.sender, 'resize');
  });

  ipcRegistry.registerListener(
    'desktop-lyric:resize',
    (event, sessionId: string, payload: Required<DesktopLyricWindowBoundsUpdate>) => {
      desktopLyricDragController.resize(sessionId, event.sender, payload);
    },
  );

  ipcRegistry.registerHandler('desktop-lyric:end-drag', (event, sessionId: string) => {
    if (!desktopLyricDragController.end(sessionId, event.sender)) return null;
    return reconcileDesktopLyricBounds() ?? constrainBoundsToDisplay(getDesktopLyricWindowState());
  });

  ipcRegistry.registerHandler('desktop-lyric:end-resize', (event, sessionId: string) => {
    if (!desktopLyricDragController.end(sessionId, event.sender, 'resize')) return null;
    return reconcileDesktopLyricBounds() ?? constrainBoundsToDisplay(getDesktopLyricWindowState());
  });

  ipcRegistry.registerHandler('desktop-lyric:cancel-resize', (event, sessionId: string) => {
    return desktopLyricDragController.cancel(sessionId, event.sender, 'resize');
  });

  ipcRegistry.registerHandler('desktop-lyric:cancel-drag', (event, sessionId: string) => {
    return desktopLyricDragController.cancel(sessionId, event.sender);
  });

  ipcRegistry.registerListener('desktop-lyric:command', (_event, command: DesktopLyricCommand) => {
    const mainWin = getMainWindow();
    if (DESKTOP_LYRIC_RENDERER_COMMANDS.has(command)) {
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.webContents.send('desktop-lyric:command', command);
      return;
    }
    if (command === 'openLyricSource') {
      if (getActiveWindowMode() === 'mini') {
        closeMiniPlayerWindow();
      }
      showMainWindow();
      if (!mainWin || mainWin.isDestroyed()) return;
      setTimeout(() => {
        if (!mainWin.isDestroyed()) {
          mainWin.webContents.send('shortcut-trigger', command);
        }
      }, 300);
      return;
    }
    // 播放/模式等命令统一由主窗口渲染进程执行；mini 模式下不得转发到迷你窗口
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('shortcut-trigger', command);
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
  desktopLyricDragController.dispose();
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
