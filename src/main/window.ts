import {
  BrowserWindow,
  shell,
  app,
  nativeTheme,
  ipcMain,
  powerSaveBlocker,
  screen,
} from 'electron';
import { join } from 'path';
import type { CloseBehavior, ThemeMode } from '../shared/app';
import {
  getMainAppSettings,
  setMainAppSetting,
  type MainWindowState as WindowState,
} from './storage/settings';
import { getActiveWindowMode, setActiveWindowMode } from './windowMode';

const minWidth: number = 1100;
const minHeight: number = 720;
const defaultWidth: number = 1150;
const defaultHeight: number = 750;

const initialSettings = getMainAppSettings();
let closeBehavior: CloseBehavior = initialSettings.closeBehavior;
let currentTheme: ThemeMode = initialSettings.theme;
let rememberWindowSize = initialSettings.rememberWindowSize;
let preventSleep = initialSettings.preventSleep;
let isPlaybackActive = false;
let systemSuspended = false;
let powerSaveBlockerId = -1;

let win: BrowserWindow | null = null;
let isQuitting = false;

const canUseMainWindow = (mainWindow: BrowserWindow | null): mainWindow is BrowserWindow => {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
};

export function hideMainWindow() {
  if (!canUseMainWindow(win)) return;

  if (win.isFullScreen()) {
    win.setFullScreen(false);
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.setSkipTaskbar(true);
  win.hide();
}

export function showMainWindow() {
  if (!canUseMainWindow(win)) return;
  setActiveWindowMode('main');

  const wasVisible = win.isVisible();
  const wasMinimized = win.isMinimized();
  const wasFocused = win.isFocused();

  if (wasMinimized) {
    win.restore();
  }

  win.setSkipTaskbar(false);

  if (!wasVisible) {
    win.show();
  }

  if (!wasVisible || wasMinimized || !wasFocused) {
    win.moveTop();
    win.focus();
  }
}

export function quitApplication() {
  isQuitting = true;
  app.quit();
}

export function requestMainWindowClose() {
  if (!canUseMainWindow(win)) return;

  if (isQuitting || closeBehavior === 'exit') {
    quitApplication();
    return;
  }

  hideMainWindow();
}

const resolveDevWindowIcon = () => join(process.cwd(), 'build/icons/icon.png');

// 监听应用准备退出
app.on('before-quit', () => {
  isQuitting = true;
});

// 监听关闭行为更新
ipcMain.on('update-close-behavior', (_event, behavior: CloseBehavior) => {
  closeBehavior = behavior;
  setMainAppSetting('closeBehavior', behavior);
});

// 监听主题更新，用于同步主进程背景色判断
ipcMain.on('update-theme', (_event, theme: ThemeMode) => {
  currentTheme = theme;
  setMainAppSetting('theme', theme);
});

ipcMain.on('update-remember-window-size', (_event, enabled: boolean) => {
  rememberWindowSize = enabled;
  setMainAppSetting('rememberWindowSize', enabled);
});

const syncPowerSaveBlocker = () => {
  const shouldBlock = preventSleep && isPlaybackActive && !systemSuspended;
  if (shouldBlock) {
    if (powerSaveBlockerId === -1 || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return;
  }

  if (powerSaveBlockerId !== -1 && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = -1;
};

// 系统挂起期间强制释放 power-save-blocker；唤醒后允许按播放状态重新获取。
// 由 powerMonitor 的 suspend/resume 调用，避免唤醒后残留一个失效的 blocker。
export function setSystemSuspended(suspended: boolean) {
  systemSuspended = suspended;
  syncPowerSaveBlocker();
}

ipcMain.on(
  'update-power-save-blocker',
  (_event, payload: { enabled: boolean; isPlaying: boolean }) => {
    preventSleep = Boolean(payload?.enabled);
    isPlaybackActive = Boolean(payload?.isPlaying);
    setMainAppSetting('preventSleep', preventSleep);
    syncPowerSaveBlocker();
  },
);

const getPersistedWindowState = (): WindowState => {
  return getMainAppSettings().windowState;
};

const hasVisibleArea = (bounds: { x?: number; y?: number; width: number; height: number }) => {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const x = bounds.x ?? area.x;
    const y = bounds.y ?? area.y;
    return (
      x < area.x + area.width &&
      x + bounds.width > area.x &&
      y < area.y + area.height &&
      y + bounds.height > area.y
    );
  });
};

const buildWindowBounds = () => {
  if (!rememberWindowSize) {
    return { width: defaultWidth, height: defaultHeight } as const;
  }

  const state = getPersistedWindowState();
  const bounds = {
    width: Math.max(minWidth, state.width || defaultWidth),
    height: Math.max(minHeight, state.height || defaultHeight),
    ...(typeof state.x === 'number' ? { x: state.x } : {}),
    ...(typeof state.y === 'number' ? { y: state.y } : {}),
  };

  if ((typeof bounds.x === 'number' || typeof bounds.y === 'number') && !hasVisibleArea(bounds)) {
    return { width: bounds.width, height: bounds.height } as const;
  }

  return bounds;
};

const persistWindowState = () => {
  if (!win || !rememberWindowSize || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  // 最大化时 getBounds 返回的是全屏尺寸，会污染窗口化后恢复的大小
  // 因此最大化状态下只更新 isMaximized 标记，保留上一次窗口化时的 width/height/x/y
  if (maximized) {
    const prev = getPersistedWindowState();
    setMainAppSetting('windowState', {
      width: prev.width,
      height: prev.height,
      x: prev.x,
      y: prev.y,
      isMaximized: true,
    });
    return;
  }
  const bounds = win.getBounds();
  setMainAppSetting('windowState', {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: false,
  });
};

export function getMainWindow() {
  return win;
}

export async function createWindow() {
  const preload = join(__dirname, '../preload/index.js');
  const url = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = join(__dirname, '../../dist/index.html');

  // 根据设置或系统偏好决定初始背景色
  let initialBgColor = '#ffffff';
  if (currentTheme === 'dark') {
    initialBgColor = '#1a1a1c';
  } else if (currentTheme === 'light') {
    initialBgColor = '#ffffff';
  } else {
    // 跟随系统
    initialBgColor = nativeTheme.shouldUseDarkColors ? '#1a1a1c' : '#ffffff';
  }

  const initialBounds = buildWindowBounds();
  const initialWindowState = getPersistedWindowState();

  win = new BrowserWindow({
    title: 'EchoMusic',
    ...(!app.isPackaged ? { icon: resolveDevWindowIcon() } : {}),
    ...initialBounds,
    minWidth: minWidth,
    minHeight: minHeight,
    show: false, // 初始不显示，防止白屏
    backgroundColor: initialBgColor, // 动态设置背景色
    frame: false,
    transparent: false,
    hasShadow: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 5, y: 14 },
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // 禁用 CORS 限制
      allowRunningInsecureContent: true, // 允许混合内容
      zoomFactor: 1.0,
      backgroundThrottling: false, // 最小化后不节流，保证播放状态和歌词同步
    },
  });

  if (rememberWindowSize && initialWindowState.isMaximized) {
    win.maximize();
  }

  // 当窗口准备好显示时再展示，优雅解决启动白屏
  win.once('ready-to-show', () => {
    win?.show();
  });

  // 禁止视觉缩放 + 强制 zoomFactor，兜底防止 Windows 高 DPI 下意外缩放。
  // Windows 高 DPI（如 200%）下，全屏 / 最大化等窗口状态切换会意外重置 zoomFactor，
  // 使页面被整体放大，右上角窗口控制按钮被挤出可视区域而“消失”。
  // 因此除首次加载外，每次窗口状态切换后都重新强制一次。
  const enforceNoZoom = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.setZoomFactor(1.0);
    win.webContents.setVisualZoomLevelLimits(1, 1);
  };

  // 部分高 DPI 设备上 zoomFactor 重置发生在事件回调之后，增加延时兜底
  const enforceNoZoomDeferred = () => {
    enforceNoZoom();
    setTimeout(enforceNoZoom, 80);
  };

  win.webContents.on('did-finish-load', enforceNoZoom);
  win.on('enter-full-screen', enforceNoZoomDeferred);
  win.on('leave-full-screen', enforceNoZoomDeferred);
  win.on('maximize', enforceNoZoomDeferred);
  win.on('unmaximize', enforceNoZoomDeferred);

  if (url) {
    win.loadURL(url);
  } else {
    win.loadFile(indexHtml);
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 拦截关闭事件
  win.on('close', (event) => {
    if (isQuitting) return;

    if (closeBehavior === 'tray') {
      event.preventDefault();
      hideMainWindow();
    } else {
      quitApplication();
    }
  });

  win.on('resize', () => {
    if (!win?.isMaximized()) persistWindowState();
  });

  win.on('move', () => {
    if (!win?.isMaximized()) persistWindowState();
  });

  win.on('maximize', () => {
    persistWindowState();
  });

  win.on('unmaximize', () => {
    persistWindowState();
  });

  win.on('closed', () => {
    syncPowerSaveBlocker();
    win = null;
  });

  const hideMainIfMiniMode = () => {
    if (!win || win.isDestroyed()) return;
    if (getActiveWindowMode() !== 'mini') return;
    hideMainWindow();
  };

  win.on('show', hideMainIfMiniMode);
  win.on('focus', hideMainIfMiniMode);

  return win;
}

export function restoreWindow() {
  showMainWindow();
}
