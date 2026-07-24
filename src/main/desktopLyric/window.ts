import { BrowserWindow, app } from 'electron';
import { join } from 'path';
import {
  getDesktopLyricWindowLimits,
  type DesktopLyricWindowState,
  getDesktopLyricSettings,
  persistDesktopLyricWindowState,
  resolveInitialBounds,
} from './store';

const getBackgroundColor = () => '#00000000';
const desktopLyricUrl = process.env.VITE_DEV_SERVER_URL;
const desktopLyricHtml = join(__dirname, '../../dist/desktop-lyric.html');
const DESKTOP_LYRIC_RESTACK_DELAYS_MS =
  process.platform === 'win32'
    ? [0, 120, 800]
    : process.platform === 'darwin'
      ? [120, 320]
      : [0, 120];
const DESKTOP_LYRIC_INTERACTION_SYNC_DELAYS_MS = [0, 80, 220];
const DESKTOP_LYRIC_DOCK_RESTORE_DELAYS_MS = [0, 120, 320];

let desktopLyricWindow: BrowserWindow | null = null;
let desktopLyricRestackTimers: NodeJS.Timeout[] = [];
let desktopLyricInteractionTimers: NodeJS.Timeout[] = [];
let desktopLyricDockTimers: NodeJS.Timeout[] = [];
let desktopLyricPersistBoundsTimer: NodeJS.Timeout | null = null;
let desktopLyricWorkspaceVisibility: boolean | null = null;

export const getDesktopLyricWindow = () => desktopLyricWindow;

export const withDesktopLyricWindow = (window: BrowserWindow | null) => {
  desktopLyricWindow = window;
  if (!window) {
    desktopLyricWorkspaceVisibility = null;
    clearPersistBoundsTimer();
    clearDockRestoreTimers();
  }
};

export const isDesktopLyricWindowAvailable = () =>
  Boolean(desktopLyricWindow && !desktopLyricWindow.isDestroyed());

export const persistWindowBounds = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const bounds = desktopLyricWindow.getBounds();
  persistDesktopLyricWindowState(bounds);
};

const clearPersistBoundsTimer = () => {
  if (!desktopLyricPersistBoundsTimer) return;
  clearTimeout(desktopLyricPersistBoundsTimer);
  desktopLyricPersistBoundsTimer = null;
};

export const schedulePersistWindowBounds = () => {
  clearPersistBoundsTimer();
  desktopLyricPersistBoundsTimer = setTimeout(() => {
    desktopLyricPersistBoundsTimer = null;
    persistWindowBounds();
  }, 160);
};

export const flushPersistWindowBounds = () => {
  clearPersistBoundsTimer();
  persistWindowBounds();
};

export const clearWindowPresentationTimers = () => {
  if (!desktopLyricRestackTimers.length) return;
  desktopLyricRestackTimers.forEach((timer) => clearTimeout(timer));
  desktopLyricRestackTimers = [];
};

export const clearWindowInteractionTimers = () => {
  if (!desktopLyricInteractionTimers.length) return;
  desktopLyricInteractionTimers.forEach((timer) => clearTimeout(timer));
  desktopLyricInteractionTimers = [];
};

const clearDockRestoreTimers = () => {
  if (!desktopLyricDockTimers.length) return;
  desktopLyricDockTimers.forEach((timer) => clearTimeout(timer));
  desktopLyricDockTimers = [];
};

const scheduleDockRestore = () => {
  if (process.platform !== 'darwin') return;
  clearDockRestoreTimers();
  desktopLyricDockTimers = DESKTOP_LYRIC_DOCK_RESTORE_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      app.dock?.show();
    }, delay),
  );
};

const syncMacWorkspaceVisibility = (alwaysOnTop: boolean, force = false) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || process.platform !== 'darwin')
    return;
  if (!force && desktopLyricWorkspaceVisibility === alwaysOnTop) return;
  desktopLyricWorkspaceVisibility = alwaysOnTop;
  desktopLyricWindow.setVisibleOnAllWorkspaces(alwaysOnTop, {
    visibleOnFullScreen: alwaysOnTop,
  });
  scheduleDockRestore();
};

export const syncWindowPresentation = (alwaysOnTop = true, forceWorkspaceSync = false) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBackgroundColor(getBackgroundColor());
  // Linux 下使用 type: 'toolbar' 配合 setAlwaysOnTop 实现置顶控制。
  // 注意：Wayland 原生模式下 setAlwaysOnTop 无效（协议限制），
  // 但 Electron 默认使用 XWayland，此时 setAlwaysOnTop 正常工作。
  desktopLyricWindow.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'screen-saver' : 'normal');
  desktopLyricWindow.setSkipTaskbar(true);
  syncMacWorkspaceVisibility(alwaysOnTop, forceWorkspaceSync);
};

export const scheduleWindowPresentationSync = (alwaysOnTop = true) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  clearWindowPresentationTimers();
  desktopLyricRestackTimers = DESKTOP_LYRIC_RESTACK_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      syncWindowPresentation(alwaysOnTop, delay === 0 && process.platform === 'darwin');
    }, delay),
  );
};

export const scheduleWindowInteractionSync = (applyState: () => void) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  clearWindowInteractionTimers();
  desktopLyricInteractionTimers = DESKTOP_LYRIC_INTERACTION_SYNC_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      applyState();
    }, delay),
  );
};

export const createDesktopLyricWindow = () => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) return desktopLyricWindow;

  const preload = join(__dirname, '../preload/index.js');
  const bounds = resolveInitialBounds();
  const settings = getDesktopLyricSettings();
  const limits = getDesktopLyricWindowLimits();

  const win = new BrowserWindow({
    title: 'EchoMusic Desktop Lyric',
    ...(!app.isPackaged ? { icon: join(process.cwd(), 'build/icons/icon.png') } : {}),
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: limits.minWidth,
    minHeight: limits.minHeight,
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
    frame: false,
    transparent: true,
    backgroundColor: getBackgroundColor(),
    show: false,
    resizable: true,
    movable: true,
    ...(process.platform === 'darwin'
      ? { type: 'panel', acceptFirstMouse: false }
      : process.platform === 'linux'
        ? { type: 'toolbar' }
        : {}),
    hasShadow: false,
    hiddenInMissionControl: process.platform === 'darwin',
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      enableWebSQL: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      zoomFactor: 1.0,
      partition: 'persist:desktop-lyric',
    },
  });

  desktopLyricWindow = win;

  win.once('ready-to-show', () => {
    // 只有在内容准备就绪后才显示，避免灰色/黑色闪烁
    if (win.isMinimized()) {
      if (typeof win.restore === 'function') win.restore();
      win.showInactive();
    } else {
      win.showInactive();
    }
  });

  // Windows 上用 moved/resized 事件保存位置（仅在操作结束后触发一次），
  // 避免 move/resize 高频触发时 DPI 缩放导致的坐标舍入偏移累积。
  // macOS/Linux 保持 move/resize（macOS 的 moved 行为不一致，Linux 不支持 moved）。
  if (process.platform === 'win32') {
    win.on('moved', persistWindowBounds);
    win.on('resized', persistWindowBounds);
  } else {
    win.on('move', schedulePersistWindowBounds);
    win.on('resize', schedulePersistWindowBounds);
  }

  return win;
};

export const loadDesktopLyricWindow = async () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;

  if (desktopLyricUrl) {
    await desktopLyricWindow.loadURL(new URL('desktop-lyric.html', desktopLyricUrl).toString());
  } else {
    await desktopLyricWindow.loadFile(desktopLyricHtml);
  }
};

export const applyWindowBounds = (bounds: DesktopLyricWindowState) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBounds({
    x: Math.round(bounds.x ?? 0),
    y: Math.round(bounds.y ?? 0),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
};

export const updateWindowHeight = (height: number) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || !height) return;
  const bounds = desktopLyricWindow.getBounds();
  desktopLyricWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.round(height),
  });
  persistDesktopLyricWindowState({
    ...bounds,
    height,
  });
};

export const updateWindowBounds = (bounds: DesktopLyricWindowState) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return bounds;
  applyWindowBounds(bounds);
  persistDesktopLyricWindowState(bounds);
  return desktopLyricWindow.getBounds();
};

export const applyWindowSizeLimits = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const limits = getDesktopLyricWindowLimits();
  desktopLyricWindow.setMinimumSize(1, 1);
  desktopLyricWindow.setMaximumSize(100000, 100000);
  desktopLyricWindow.setMinimumSize(limits.minWidth, limits.minHeight);
  desktopLyricWindow.setMaximumSize(limits.maxWidth, limits.maxHeight);
};

export const setDesktopLyricFixedSize = (options: {
  width: number;
  height: number;
  fixed: boolean;
}) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  if (options.fixed) {
    desktopLyricWindow.setMaximumSize(options.width, options.height);
  } else {
    const limits = getDesktopLyricWindowLimits();
    desktopLyricWindow.setMaximumSize(limits.maxWidth, limits.maxHeight);
  }
};
