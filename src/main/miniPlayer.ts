import { ipcRegistry } from './ipc/registry';
import { BrowserWindow, app, nativeTheme, screen, shell } from 'electron';
import { join } from 'path';
import type {
  MiniPlayerCommand,
  MiniPlayerExpandDirection,
  MiniPlayerSnapshot,
  MiniPlayerSnapshotPatch,
} from '../shared/mini-player';
import { MINI_PLAYER_DIMENSIONS } from '../shared/mini-player';
import { getMainWindow, hideMainWindow, showMainWindow } from './window';
import { getActiveWindowMode, setActiveWindowMode } from './windowMode';
import { getMainAppSettings, setMainAppSetting } from './storage/settings';

const MINI_PLAYER_WIDTH = MINI_PLAYER_DIMENSIONS.width;
const MINI_PLAYER_HEIGHT = MINI_PLAYER_DIMENSIONS.collapsedHeight;
const MINI_PLAYER_EXPANDED_HEIGHT = MINI_PLAYER_DIMENSIONS.expandedHeight;
// 收起时延迟还原窗口高度，等待渲染层 CSS 高度过渡（240ms）播完，留出缓冲避免提前裁切卡片
const MINI_PLAYER_COLLAPSE_DELAY_MS = 280;
const MINI_PLAYER_RESTACK_DELAYS_MS =
  process.platform === 'win32'
    ? [0, 120, 800]
    : process.platform === 'darwin'
      ? [120, 320]
      : [0, 120];
const MINI_PLAYER_DOCK_RESTORE_DELAYS_MS = [0, 120, 320];

let miniPlayerWindow: BrowserWindow | null = null;
let miniPlayerExpanded = false;
let miniPlayerAlwaysOnTop = Boolean(getMainAppSettings().miniPlayerWindowState.alwaysOnTop);
let miniPlayerExpandDirection: MiniPlayerExpandDirection = 'down';
let miniPlayerWindowUsesPanel = false;
let suppressNextMiniPlayerReadyToShow = false;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
let miniPlayerRestackTimers: ReturnType<typeof setTimeout>[] = [];
let miniPlayerDockTimers: ReturnType<typeof setTimeout>[] = [];

let snapshot: MiniPlayerSnapshot = {
  playback: null,
  window: {
    alwaysOnTop: miniPlayerAlwaysOnTop,
    expandDirection: miniPlayerExpandDirection,
  },
};

const canUseWindow = (win: BrowserWindow | null): win is BrowserWindow =>
  Boolean(win && !win.isDestroyed());

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const getMiniPlayerWindow = () => miniPlayerWindow;

const shouldUseMiniPlayerPanel = () => process.platform === 'darwin' && miniPlayerAlwaysOnTop;

const getMainRendererWindow = () => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  return mainWindow;
};

const sendSnapshot = () => {
  const win = miniPlayerWindow;
  if (!canUseWindow(win)) return;
  try {
    win.webContents.send('mini-player:snapshot', snapshot);
  } catch {
    // ignore if window destroyed during send
  }
};

const updateWindowSnapshot = (send = false) => {
  snapshot = {
    ...snapshot,
    window: {
      alwaysOnTop: miniPlayerAlwaysOnTop,
      expandDirection: miniPlayerExpandDirection,
    },
  };
  if (send) sendSnapshot();
};

const clearMiniPlayerPresentationTimers = () => {
  if (!miniPlayerRestackTimers.length) return;
  miniPlayerRestackTimers.forEach((timer) => clearTimeout(timer));
  miniPlayerRestackTimers = [];
};

const clearMiniPlayerDockRestoreTimers = () => {
  if (!miniPlayerDockTimers.length) return;
  miniPlayerDockTimers.forEach((timer) => clearTimeout(timer));
  miniPlayerDockTimers = [];
};

const scheduleMiniPlayerDockRestore = () => {
  if (process.platform !== 'darwin') return;
  clearMiniPlayerDockRestoreTimers();
  miniPlayerDockTimers = MINI_PLAYER_DOCK_RESTORE_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      app.dock?.show();
    }, delay),
  );
};

const syncMiniPlayerMacWorkspaceVisibility = (visible = miniPlayerAlwaysOnTop) => {
  const win = getMiniPlayerWindow();
  if (!canUseWindow(win) || process.platform !== 'darwin') return;
  win.setVisibleOnAllWorkspaces(visible, {
    visibleOnFullScreen: visible,
  });
  if (!visible) {
    win.setVisibleOnAllWorkspaces(false, {
      visibleOnFullScreen: false,
    });
  }
  scheduleMiniPlayerDockRestore();
};

const syncMiniPlayerPresentation = (alwaysOnTop = miniPlayerAlwaysOnTop) => {
  const win = getMiniPlayerWindow();
  if (!canUseWindow(win)) return;
  win.setBackgroundColor('#00000000');
  if (alwaysOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (typeof win.moveTop === 'function') win.moveTop();
  } else {
    syncMiniPlayerMacWorkspaceVisibility(false);
    win.setAlwaysOnTop(false, 'normal');
  }
  win.setSkipTaskbar(true);
  // setAlwaysOnTop 会重置 macOS 的 visibleOnFullScreen 状态，
  // 因此每次都必须在其之后重新设置 setVisibleOnAllWorkspaces
  syncMiniPlayerMacWorkspaceVisibility(alwaysOnTop);
};

const scheduleMiniPlayerPresentationSync = () => {
  const win = getMiniPlayerWindow();
  if (!canUseWindow(win)) return;
  clearMiniPlayerPresentationTimers();
  miniPlayerRestackTimers = MINI_PLAYER_RESTACK_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      syncMiniPlayerPresentation();
    }, delay),
  );
};

const applyMiniPlayerAlwaysOnTop = () => {
  clearMiniPlayerPresentationTimers();
  syncMiniPlayerPresentation();
  scheduleMiniPlayerPresentationSync();
  if (process.platform === 'darwin') {
    scheduleMiniPlayerDockRestore();
  }
};

const recreateMiniPlayerWindowForPresentation = async () => {
  const previousWindow = getMiniPlayerWindow();
  if (!canUseWindow(previousWindow)) return;

  const shouldShowRecreatedWindow = miniPlayerAlwaysOnTop || process.platform !== 'darwin';
  const wasVisible = previousWindow.isVisible() && shouldShowRecreatedWindow;
  const wasFocused = previousWindow.isFocused();

  if (persistBoundsTimer) {
    clearTimeout(persistBoundsTimer);
    persistBoundsTimer = null;
  }
  writeMiniPlayerBounds();
  clearMiniPlayerPresentationTimers();
  clearMiniPlayerDockRestoreTimers();
  clearCollapseTimer();
  applyMiniPlayerCollapsedBounds();
  miniPlayerExpanded = false;

  if (process.platform === 'darwin') {
    previousWindow.setVisibleOnAllWorkspaces(false, {
      visibleOnFullScreen: false,
    });
  }
  previousWindow.setAlwaysOnTop(false, 'normal');
  previousWindow.hide();

  miniPlayerWindow = null;
  miniPlayerWindowUsesPanel = false;
  previousWindow.destroy();

  suppressNextMiniPlayerReadyToShow = !shouldShowRecreatedWindow;
  const nextWindow = await ensureMiniPlayerWindow();
  if (wasVisible && !nextWindow.isVisible()) {
    if (wasFocused) nextWindow.show();
    else nextWindow.showInactive();
  }
  if (wasFocused) nextWindow.focus();
};

const setMiniPlayerAlwaysOnTop = async (alwaysOnTop: boolean) => {
  const nextAlwaysOnTop = Boolean(alwaysOnTop);
  const shouldRecreate =
    process.platform === 'darwin' &&
    canUseWindow(miniPlayerWindow) &&
    miniPlayerWindowUsesPanel !== nextAlwaysOnTop;

  miniPlayerAlwaysOnTop = nextAlwaysOnTop;
  const saved = getMainAppSettings().miniPlayerWindowState;
  setMainAppSetting('miniPlayerWindowState', {
    ...saved,
    alwaysOnTop: miniPlayerAlwaysOnTop,
  });

  if (shouldRecreate) {
    updateWindowSnapshot(false);
    void recreateMiniPlayerWindowForPresentation().catch(() => {
      // ignore presentation rebuild failures; snapshot already reflects the requested state
    });
  } else {
    applyMiniPlayerAlwaysOnTop();
  }

  updateWindowSnapshot(true);
  return snapshot;
};

const loadMiniPlayerWindow = async (win: BrowserWindow) => {
  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) {
    const target = new URL(url);
    target.hash = '/mini-player';
    await win.loadURL(target.toString());
    return;
  }

  await win.loadFile(join(__dirname, '../../dist/index.html'), {
    hash: '/mini-player',
  });
};

const resolveMiniPlayerBounds = () => {
  const saved = getMainAppSettings().miniPlayerWindowState;
  const width = MINI_PLAYER_WIDTH;
  const height = MINI_PLAYER_HEIGHT;
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const fallback = {
    width,
    height,
    x: Math.round(primaryArea.x + (primaryArea.width - width) / 2),
    y: Math.round(primaryArea.y + (primaryArea.height - height) / 2),
  };

  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return fallback;

  const isVisible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlap = 48;
    return (
      saved.x! + width > area.x + overlap &&
      saved.x! < area.x + area.width - overlap &&
      saved.y! + height > area.y + overlap &&
      saved.y! < area.y + area.height - overlap
    );
  });
  if (!isVisible) return fallback;

  const display = screen.getDisplayNearestPoint({
    x: Math.round(saved.x + width / 2),
    y: Math.round(saved.y + height / 2),
  });
  const area = display.workArea;
  return {
    width,
    height,
    x: clamp(Math.round(saved.x), area.x, area.x + area.width - width),
    y: clamp(Math.round(saved.y), area.y, area.y + area.height - height),
  };
};

let persistBoundsTimer: ReturnType<typeof setTimeout> | null = null;

const writeMiniPlayerBounds = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const isWindowExpanded = bounds.height > MINI_PLAYER_HEIGHT + 1;
  const collapsedY =
    isWindowExpanded && miniPlayerExpandDirection === 'up'
      ? bounds.y + bounds.height - MINI_PLAYER_HEIGHT
      : bounds.y;
  const saved = getMainAppSettings().miniPlayerWindowState;
  // 保存折叠态控制条位置；向上展开时窗口顶部在面板顶端，需要换算回控制条顶部。
  setMainAppSetting('miniPlayerWindowState', {
    ...saved,
    width: MINI_PLAYER_WIDTH,
    height: MINI_PLAYER_HEIGHT,
    x: Math.round(bounds.x),
    y: Math.round(collapsedY),
    alwaysOnTop: miniPlayerAlwaysOnTop,
  });
};

// 拖动时 move 事件高频触发，去抖后再写设置，避免每像素同步落盘导致拖动卡顿
const persistMiniPlayerBounds = () => {
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    writeMiniPlayerBounds();
  }, 250);
};

const resolveCollapsedAnchorY = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return 0;
  const bounds = win.getBounds();
  const isWindowExpanded = bounds.height > MINI_PLAYER_HEIGHT + 1;
  if (isWindowExpanded && miniPlayerExpandDirection === 'up') {
    return bounds.y + bounds.height - MINI_PLAYER_HEIGHT;
  }
  return bounds.y;
};

const resolveMiniPlayerDirectionForHeight = (
  collapsedY: number,
  targetHeight: number,
): MiniPlayerExpandDirection => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return 'down';
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(collapsedY + MINI_PLAYER_HEIGHT / 2),
  });
  const area = display.workArea;
  const extraHeight = targetHeight - MINI_PLAYER_HEIGHT;
  const spaceAbove = collapsedY - area.y;
  const spaceBelow = area.y + area.height - (collapsedY + MINI_PLAYER_HEIGHT);

  if (spaceBelow >= extraHeight) return 'down';
  if (spaceAbove >= extraHeight) return 'up';
  return spaceBelow >= spaceAbove ? 'down' : 'up';
};

const resolveMiniPlayerExpandDirection = (collapsedY: number): MiniPlayerExpandDirection =>
  resolveMiniPlayerDirectionForHeight(collapsedY, MINI_PLAYER_EXPANDED_HEIGHT);

// 一次性把窗口设为展开高度，并根据当前位置选择向上或向下展开。
// 高度动画交给渲染层 CSS，避免逐帧 setBounds 造成透明窗口闪烁。
const applyMiniPlayerExpandedBounds = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const collapsedY = resolveCollapsedAnchorY();
  miniPlayerExpandDirection = resolveMiniPlayerExpandDirection(collapsedY);

  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(collapsedY + MINI_PLAYER_HEIGHT / 2),
  });
  const area = display.workArea;
  const targetY =
    miniPlayerExpandDirection === 'up'
      ? collapsedY + MINI_PLAYER_HEIGHT - MINI_PLAYER_EXPANDED_HEIGHT
      : collapsedY;
  const y = clamp(Math.round(targetY), area.y, area.y + area.height - MINI_PLAYER_EXPANDED_HEIGHT);

  if (
    bounds.width === MINI_PLAYER_WIDTH &&
    bounds.height === MINI_PLAYER_EXPANDED_HEIGHT &&
    bounds.y === y
  ) {
    updateWindowSnapshot(true);
    return;
  }

  win.setBounds(
    {
      x: bounds.x,
      y,
      width: MINI_PLAYER_WIDTH,
      height: MINI_PLAYER_EXPANDED_HEIGHT,
    },
    false,
  );
  updateWindowSnapshot(true);
};

const applyMiniPlayerCollapsedBounds = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const collapsedY =
    miniPlayerExpandDirection === 'up' ? bounds.y + bounds.height - MINI_PLAYER_HEIGHT : bounds.y;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(collapsedY + MINI_PLAYER_HEIGHT / 2),
  });
  const area = display.workArea;
  const y = clamp(Math.round(collapsedY), area.y, area.y + area.height - MINI_PLAYER_HEIGHT);

  if (
    bounds.width === MINI_PLAYER_WIDTH &&
    bounds.height === MINI_PLAYER_HEIGHT &&
    bounds.y === y
  ) {
    return;
  }

  win.setBounds(
    {
      x: bounds.x,
      y,
      width: MINI_PLAYER_WIDTH,
      height: MINI_PLAYER_HEIGHT,
    },
    false,
  );
};

const clearCollapseTimer = () => {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
};

const setMiniPlayerExpanded = (expanded: boolean) => {
  clearCollapseTimer();
  if (expanded) {
    miniPlayerExpanded = true;
    const win = getMiniPlayerWindow();
    if (!win || win.isDestroyed()) return;
    const collapsedY = resolveCollapsedAnchorY();
    miniPlayerExpandDirection = resolveMiniPlayerExpandDirection(collapsedY);
    updateWindowSnapshot(false);
    // 由渲染层先锁定展开方向，再触发 setBounds，避免向上展开时控制条跳到扩窗后的顶部。
    return;
  }
  miniPlayerExpanded = false;
  if (miniPlayerExpandDirection === 'up') {
    // 向上收起时窗口顶部需要下移接近整个面板高度；延迟移动会在透明窗口里抖动。
    // 直接裁回折叠窗口，只保留控制条，避免原生窗口位移参与收起动画。
    applyMiniPlayerCollapsedBounds();
  } else {
    // 向下收起：先让渲染层卡片 CSS 下收，过渡结束后再缩小窗口
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      applyMiniPlayerCollapsedBounds();
    }, MINI_PLAYER_COLLAPSE_DELAY_MS);
  }
};

const collapseMiniPlayer = () => {
  clearCollapseTimer();
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  if (!miniPlayerExpanded && win.getBounds().height <= MINI_PLAYER_HEIGHT + 1) return;
  // 窗口即将隐藏，立即收起，无需动画
  applyMiniPlayerCollapsedBounds();
  miniPlayerExpanded = false;
};

export const ensureMiniPlayerWindow = async () => {
  if (canUseWindow(miniPlayerWindow)) {
    if (miniPlayerWindow.isMinimized()) miniPlayerWindow.restore();
    if (!miniPlayerWindow.isVisible()) miniPlayerWindow.show();
    miniPlayerWindow.focus();
    sendSnapshot();
    return miniPlayerWindow;
  }

  const preload = join(__dirname, '../preload/index.js');
  const bounds = resolveMiniPlayerBounds();
  const win = new BrowserWindow({
    title: 'EchoMusic Mini Player',
    ...(!app.isPackaged ? { icon: join(process.cwd(), 'build/icons/icon.png') } : {}),
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: true,
    ...(process.platform === 'darwin'
      ? {
          ...(shouldUseMiniPlayerPanel() ? { type: 'panel' as const } : {}),
          acceptFirstMouse: true,
          hiddenInMissionControl: shouldUseMiniPlayerPanel(),
        }
      : {}),
    // 透明窗口用原生阴影会在内容缩放时残留黑色条纹，改由渲染层 CSS 投影
    hasShadow: false,
    alwaysOnTop: miniPlayerAlwaysOnTop,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      zoomFactor: 1.0,
    },
  });

  miniPlayerWindow = win;
  miniPlayerWindowUsesPanel = shouldUseMiniPlayerPanel();
  miniPlayerExpanded = false;
  miniPlayerExpandDirection = 'down';
  updateWindowSnapshot();
  applyMiniPlayerAlwaysOnTop();

  win.webContents.on('did-finish-load', () => {
    sendSnapshot();
  });

  win.once('ready-to-show', () => {
    syncMiniPlayerPresentation();
    scheduleMiniPlayerPresentationSync();
    const shouldSuppressShow = suppressNextMiniPlayerReadyToShow;
    suppressNextMiniPlayerReadyToShow = false;
    if (!shouldSuppressShow) win.show();
    sendSnapshot();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    if (miniPlayerWindow !== win) return;
    clearMiniPlayerPresentationTimers();
    clearMiniPlayerDockRestoreTimers();
    clearCollapseTimer();
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer);
      persistBoundsTimer = null;
    }
    miniPlayerWindow = null;
    miniPlayerWindowUsesPanel = false;
    miniPlayerExpanded = false;
  });

  if (process.platform === 'win32') {
    win.on('moved', persistMiniPlayerBounds);
  } else {
    win.on('move', persistMiniPlayerBounds);
  }

  await loadMiniPlayerWindow(win);
  return win;
};

export const showMiniPlayerWindow = async () => {
  setActiveWindowMode('mini');
  const win = await ensureMiniPlayerWindow();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  hideMainWindow();
  if (process.platform === 'darwin') {
    setTimeout(() => {
      hideMainWindow();
      if (!win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        syncMiniPlayerPresentation();
        scheduleMiniPlayerPresentationSync();
        scheduleMiniPlayerDockRestore();
        win.focus();
      }
    }, 80);
  }
  syncMiniPlayerPresentation();
  scheduleMiniPlayerPresentationSync();
  scheduleMiniPlayerDockRestore();
  sendSnapshot();
  return snapshot;
};

export const closeMiniPlayerWindow = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  if (persistBoundsTimer) {
    clearTimeout(persistBoundsTimer);
    persistBoundsTimer = null;
  }
  writeMiniPlayerBounds();
  collapseMiniPlayer();
  win.hide();
  scheduleMiniPlayerDockRestore();
};

export const toggleMiniPlayerWindow = async () => {
  const win = getMiniPlayerWindow();
  const miniVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
  const shouldRestoreMain = getActiveWindowMode() === 'mini' || miniVisible;

  if (shouldRestoreMain) {
    setActiveWindowMode('main');
    showMainWindow();
    closeMiniPlayerWindow();
    return snapshot;
  }

  return showMiniPlayerWindow();
};

export const destroyMiniPlayerWindow = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  clearMiniPlayerPresentationTimers();
  clearMiniPlayerDockRestoreTimers();
  clearCollapseTimer();
  miniPlayerWindow = null;
  miniPlayerWindowUsesPanel = false;
  win.destroy();
};

const forwardCommandToMainRenderer = (command: MiniPlayerCommand) => {
  const mainWindow = getMainRendererWindow();
  if (!mainWindow) return;
  mainWindow.webContents.send('mini-player:command', command);
};

export const getMiniPlayerSnapshot = () => snapshot;

export const showMiniPlayerWindowOnTop = (focus = true): boolean => {
  const win = getMiniPlayerWindow();
  if (!canUseWindow(win)) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) {
    if (focus) win.show();
    else win.showInactive();
  }
  if (typeof win.moveTop === 'function') win.moveTop();
  if (focus) win.focus();
  return true;
};

export const registerMiniPlayerHandlers = () => {
  ipcRegistry.registerHandler('mini-player:get-snapshot', () => getMiniPlayerSnapshot());

  ipcRegistry.registerHandler('mini-player:show', async () => showMiniPlayerWindow());

  ipcRegistry.registerHandler('mini-player:hide', () => {
    closeMiniPlayerWindow();
    return snapshot;
  });

  ipcRegistry.registerHandler('mini-player:toggle', () => toggleMiniPlayerWindow());

  ipcRegistry.registerListener(
    'mini-player:sync-snapshot',
    (_event, payload: MiniPlayerSnapshotPatch) => {
      if (!payload) return;
      if (payload.playback !== undefined) {
        snapshot = {
          ...snapshot,
          playback: payload.playback,
        };
      }
      if (payload.appearance !== undefined) {
        snapshot = {
          ...snapshot,
          appearance: payload.appearance,
        };
      }
      if (payload.queue !== undefined) {
        snapshot = {
          ...snapshot,
          queue: payload.queue,
        };
      }
      if (payload.lyric !== undefined) {
        const previousLyric = snapshot.lyric;
        const shouldKeepPreviousLyricLines =
          Array.isArray(payload.lyric.lines) &&
          payload.lyric.lines.length === 0 &&
          (previousLyric?.lines.length ?? 0) > 0 &&
          Boolean(payload.lyric.trackId) &&
          payload.lyric.trackId === previousLyric?.trackId;
        const nextLyric = {
          trackId: null,
          lines: [],
          currentIndex: -1,
          timeOffset: 0,
          wantTranslation: false,
          wantRomanization: false,
          hasTranslation: false,
          hasRomanization: false,
          desktopLyricEnabled: false,
          ...(previousLyric ?? {}),
          ...payload.lyric,
        };
        snapshot = {
          ...snapshot,
          lyric: shouldKeepPreviousLyricLines
            ? {
                ...nextLyric,
                lines: previousLyric?.lines ?? [],
                hasTranslation: previousLyric?.hasTranslation ?? nextLyric.hasTranslation,
                hasRomanization: previousLyric?.hasRomanization ?? nextLyric.hasRomanization,
                tips: previousLyric?.tips ?? nextLyric.tips,
              }
            : nextLyric,
        };
      }
      sendSnapshot();
    },
  );

  ipcRegistry.registerHandler('mini-player:set-expanded', (_event, expanded: boolean) => {
    setMiniPlayerExpanded(Boolean(expanded));
    return snapshot;
  });

  ipcRegistry.registerHandler('mini-player:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setMiniPlayerAlwaysOnTop(Boolean(alwaysOnTop)),
  );

  ipcRegistry.registerHandler('mini-player:get-bounds', () => {
    const win = getMiniPlayerWindow();
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    return win.getBounds();
  });

  // 渲染层锁定展开方向后通知主进程扩窗，再触发卡片动画。
  ipcRegistry.registerHandler('mini-player:apply-expand-bounds', () => {
    if (miniPlayerExpanded) {
      applyMiniPlayerExpandedBounds();
    }
    return snapshot;
  });

  // 自定义拖动：渲染层用 pointer 事件计算新坐标后下发（取代 -webkit-app-region: drag，
  // 后者会吞掉拖拽区的 pointer 事件导致 hover 闪烁）
  ipcRegistry.registerListener('mini-player:move', (_event, x: number, y: number) => {
    const win = getMiniPlayerWindow();
    if (!win || win.isDestroyed()) return;
    // 使用固定宽高避免 Windows DPI 缩放导致的尺寸舍入累积
    const height = miniPlayerExpanded ? MINI_PLAYER_EXPANDED_HEIGHT : MINI_PLAYER_HEIGHT;
    win.setBounds(
      {
        x: Math.round(x),
        y: Math.round(y),
        width: MINI_PLAYER_WIDTH,
        height,
      },
      false,
    );
    persistMiniPlayerBounds();
  });

  ipcRegistry.registerListener('mini-player:command', (_event, command: MiniPlayerCommand) => {
    if (command === 'showMainWindow') {
      setActiveWindowMode('main');
      showMainWindow();
      closeMiniPlayerWindow();
      return;
    }
    if (command === 'closeMiniPlayer') {
      closeMiniPlayerWindow();
      return;
    }
    forwardCommandToMainRenderer(command);
  });

  // mini 窗口通知歌词面板可见状态，转发给主渲染进程以调整同步频率
  ipcRegistry.registerListener('mini-player:lyric-visibility', (_event, visible: boolean) => {
    const mainWindow = getMainRendererWindow();
    if (!mainWindow) return;
    mainWindow.webContents.send('mini-player:lyric-visibility', visible);
  });
};

let miniPlayerNativeThemeHandler: (() => void) | null = null;

const installMiniPlayerNativeThemeListener = () => {
  if (miniPlayerNativeThemeHandler) return;
  miniPlayerNativeThemeHandler = () => {
    if (!canUseWindow(miniPlayerWindow)) return;
    if (!snapshot.appearance) return;
    const theme = getMainAppSettings().theme;
    const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
    if (snapshot.appearance.isDark === isDark) return;
    snapshot = {
      ...snapshot,
      appearance: { ...snapshot.appearance, isDark },
    };
    sendSnapshot();
  };
  nativeTheme.on('updated', miniPlayerNativeThemeHandler);
};

const uninstallMiniPlayerNativeThemeListener = () => {
  if (!miniPlayerNativeThemeHandler) return;
  nativeTheme.removeListener('updated', miniPlayerNativeThemeHandler);
  miniPlayerNativeThemeHandler = null;
};

export const cleanupMiniPlayer = () => {
  uninstallMiniPlayerNativeThemeListener();
  clearMiniPlayerPresentationTimers();
  clearMiniPlayerDockRestoreTimers();
  clearCollapseTimer();
  if (persistBoundsTimer) {
    clearTimeout(persistBoundsTimer);
    persistBoundsTimer = null;
  }
};

// 系统主题变化时，根据应用设置决定是否更新 mini player 的深浅色状态
installMiniPlayerNativeThemeListener();
