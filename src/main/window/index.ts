import { release } from 'node:os';
import { normalizeWindowBackground, type WindowBackground } from '../../shared/window-background';
import {
  BrowserWindow,
  shell,
  app,
  nativeTheme,
  powerSaveBlocker,
  screen,
  type BrowserWindowConstructorOptions,
} from 'electron';
import { join } from 'path';
import type { CloseBehavior, ThemeMode } from '../../shared/app';
import {
  getMainAppSettings,
  setMainAppSetting,
  type MainWindowState as WindowState,
} from '../storage/settings';
import { getActiveWindowMode, setActiveWindowMode } from './mode';
import { isPluginRendererGoneFailureReason, reportPluginRendererFailure } from '../plugins';
import { ipcRegistry } from '../ipc/registry';
import { applyWindowAppIcon, resolveWindowIconPath } from '../appIcons';
import { logMainMemory } from '../diagnostics/memory';
import {
  WindowBoundsPersistenceGate,
  type WindowBoundsChangeKind,
} from '../windowBoundsPersistence';
import { resolveMainWindowMinHeight } from '../windowSizing';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import { buildRoundedWindowShape } from './roundedShape';

const minWidth: number = 1100;
const defaultWidth: number = 1150;
const defaultHeight: number = 750;

const getMinHeight = (): number => {
  const primaryDisplay = screen.getPrimaryDisplay();
  return resolveMainWindowMinHeight(primaryDisplay.workArea.height);
};

const initialSettings = getMainAppSettings();
let closeBehavior: CloseBehavior = initialSettings.closeBehavior;
let currentTheme: ThemeMode = initialSettings.theme;
let windowBackground = normalizeWindowBackground(initialSettings.windowBackground);
const supportsWindowFrost =
  process.platform === 'darwin' ||
  (process.platform === 'win32' && Number(release().split('.')[2]) >= 22621);
if (!supportsWindowFrost) windowBackground.frosted = false;
let rememberWindowSize = initialSettings.rememberWindowSize;
let preventSleep = initialSettings.preventSleep;
let devToolsEnabled = initialSettings.devToolsEnabled;
let isPlaybackActive = false;
let systemSuspended = false;
let powerSaveBlockerId = -1;

// 启动时同步开机自启动状态，确保注册表与设置一致
app.setLoginItemSettings({ openAtLogin: initialSettings.autoLaunch });

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

  // 先 show 再 setSkipTaskbar(false)，确保窗口可见后任务栏条目能正确创建
  if (!wasVisible) {
    win.show();
  }

  win.setSkipTaskbar(false);

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

// 监听应用准备退出
app.on('before-quit', () => {
  flushPersistWindowState();
  isQuitting = true;
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

const getMainWindowBackgroundColor = () =>
  currentTheme === 'dark' || (currentTheme === 'system' && nativeTheme.shouldUseDarkColors)
    ? '#26262a'
    : '#f5f5f7';

const syncMainWindowBackground = () => {
  if (!canUseMainWindow(win)) return;
  if (nativeTheme.themeSource !== currentTheme) nativeTheme.themeSource = currentTheme;
  win.setBackgroundColor('#00000000');
  if (process.platform === 'darwin') {
    // AppKit derives a transparent window's shadow from its content alpha.
    // Cached silhouettes can remain after cards/lyrics scroll or disappear.
    const hasShadow = !windowBackground.frosted && windowBackground.transparency === 0;
    if (win.hasShadow() !== hasShadow) {
      win.setHasShadow(hasShadow);
      win.invalidateShadow();
    }
    const dark =
      currentTheme === 'dark' || (currentTheme === 'system' && nativeTheme.shouldUseDarkColors);
    win.setVibrancy(windowBackground.frosted ? (dark ? 'hud' : 'under-window') : null);
  } else if (supportsWindowFrost && process.platform === 'win32') {
    syncWindowsBackgroundMaterial(win, windowBackground.frosted);
  }
};

export const registerMainWindowPreferenceHandlers = () => {
  nativeTheme.on('updated', syncMainWindowBackground);
  ipcRegistry.registerHandler('window-background:get', () => ({
    background: windowBackground,
    supportsFrost: supportsWindowFrost,
  }));
  ipcRegistry.registerHandler('window-background:set', (event, value: WindowBackground) => {
    if (event.sender !== win?.webContents) throw new Error('仅主窗口可以调整背景');
    windowBackground = normalizeWindowBackground(value);
    if (!supportsWindowFrost) windowBackground.frosted = false;
    setMainAppSetting('windowBackground', windowBackground);
    syncMainWindowBackground();
    return windowBackground;
  });
  ipcRegistry.registerListener('update-close-behavior', (_event, behavior: CloseBehavior) => {
    closeBehavior = behavior;
    setMainAppSetting('closeBehavior', behavior);
  });

  ipcRegistry.registerListener('update-theme', (_event, theme: ThemeMode) => {
    currentTheme = theme;
    setMainAppSetting('theme', theme);
    syncMainWindowBackground();
  });

  ipcRegistry.registerListener('update-remember-window-size', (_event, enabled: boolean) => {
    rememberWindowSize = enabled;
    setMainAppSetting('rememberWindowSize', enabled);
  });

  ipcRegistry.registerListener('update-start-minimized', (_event, enabled: boolean) => {
    setMainAppSetting('startMinimized', enabled);
  });

  ipcRegistry.registerListener('update-auto-launch', (_event, enabled: boolean) => {
    setMainAppSetting('autoLaunch', enabled);
    app.setLoginItemSettings({ openAtLogin: enabled });
  });

  ipcRegistry.registerListener('update-power-save-blocker', (_event, payload) => {
    preventSleep = Boolean(payload?.enabled);
    isPlaybackActive = Boolean(payload?.isPlaying);
    setMainAppSetting('preventSleep', preventSleep);
    syncPowerSaveBlocker();
  });

  ipcRegistry.registerListener('update-devtools-enabled', (_event, enabled: boolean) => {
    devToolsEnabled = enabled;
    setMainAppSetting('devToolsEnabled', enabled);
  });
};

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

const buildWindowBounds = (): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y' | 'useContentSize'
> => {
  if (!rememberWindowSize) {
    return { width: defaultWidth, height: defaultHeight } as const;
  }

  const state = getPersistedWindowState();
  const minHeight = getMinHeight();
  const bounds = {
    width: Math.max(minWidth, state.width || defaultWidth),
    height: Math.max(minHeight, state.height || defaultHeight),
    ...(typeof state.x === 'number' ? { x: state.x } : {}),
    ...(typeof state.y === 'number' ? { y: state.y } : {}),
    ...(shouldUseContentWindowState() && state.boundsMode === 'content'
      ? { useContentSize: true }
      : {}),
  };

  if ((typeof bounds.x === 'number' || typeof bounds.y === 'number') && !hasVisibleArea(bounds)) {
    return { width: bounds.width, height: bounds.height } as const;
  }

  return bounds;
};

const shouldUseContentWindowState = () => process.platform !== 'win32';
const shouldPersistDirtyWindowStateOnly = () => process.platform === 'win32';

const windowBoundsPersistenceGate = new WindowBoundsPersistenceGate();

const dirtyWindowState = {
  size: false,
  position: false,
};

const markWindowStateDirty = (fields: Partial<typeof dirtyWindowState>) => {
  dirtyWindowState.size = dirtyWindowState.size || Boolean(fields.size);
  dirtyWindowState.position = dirtyWindowState.position || Boolean(fields.position);
};

const markManualWindowResize = () => {
  windowBoundsPersistenceGate.markManualChange('resize');
  // 从左侧或顶部缩放时坐标也会变化。
  markWindowStateDirty({ size: true, position: true });
};

const markManualWindowMove = () => {
  windowBoundsPersistenceGate.markManualChange('move');
  markWindowStateDirty({ position: true });
};

const consumeWindowBoundsChange = (kind: WindowBoundsChangeKind) => {
  if (!windowBoundsPersistenceGate.shouldPersist(kind)) return false;
  markWindowStateDirty(kind === 'resize' ? { size: true, position: true } : { position: true });
  return true;
};

const resetDirtyWindowState = () => {
  dirtyWindowState.size = false;
  dirtyWindowState.position = false;
};

const persistWindowState = (dirtyOnly = false) => {
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
      boundsMode: prev.boundsMode,
    });
    return;
  }
  const prev = getPersistedWindowState();
  const bounds = win.getBounds();
  const contentBounds = win.getContentBounds();
  const nextBoundsMode: WindowState['boundsMode'] = shouldUseContentWindowState()
    ? 'content'
    : 'window';
  const sizeBounds = shouldUseContentWindowState() ? contentBounds : bounds;
  const shouldUpdateSize = !dirtyOnly || dirtyWindowState.size;
  const shouldUpdatePosition = !dirtyOnly || dirtyWindowState.position;

  setMainAppSetting('windowState', {
    width: shouldUpdateSize ? sizeBounds.width : prev.width,
    height: shouldUpdateSize ? sizeBounds.height : prev.height,
    x: shouldUpdatePosition ? bounds.x : prev.x,
    y: shouldUpdatePosition ? bounds.y : prev.y,
    isMaximized: false,
    boundsMode: shouldUpdateSize ? nextBoundsMode : prev.boundsMode,
  });
  resetDirtyWindowState();
};

let persistWindowStateTimer: ReturnType<typeof setTimeout> | null = null;

const clearPersistWindowStateTimer = () => {
  if (!persistWindowStateTimer) return;
  clearTimeout(persistWindowStateTimer);
  persistWindowStateTimer = null;
};

const schedulePersistWindowState = () => {
  clearPersistWindowStateTimer();
  persistWindowStateTimer = setTimeout(() => {
    persistWindowStateTimer = null;
    persistWindowState(shouldPersistDirtyWindowStateOnly());
  }, 180);
};

const flushPersistWindowState = () => {
  clearPersistWindowStateTimer();
  persistWindowState(shouldPersistDirtyWindowStateOnly());
};

export function getMainWindow() {
  return win;
}

export async function createWindow() {
  await logMainMemory('createWindow:start');
  const preload = join(__dirname, '../preload/index.js');
  const url = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = join(__dirname, '../../dist/index.html');

  const initialBgColor = getMainWindowBackgroundColor();

  const initialBounds = buildWindowBounds();
  const initialWindowState = getPersistedWindowState();
  const windowIconPath = process.platform === 'darwin' ? '' : resolveWindowIconPath();
  const minHeight = getMinHeight();
  await logMainMemory('createWindow:before BrowserWindow');

  win = new BrowserWindow({
    title: 'EchoMusic',
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    ...initialBounds,
    minWidth: minWidth,
    minHeight: minHeight,
    show: false, // 初始不显示，防止白屏
    backgroundColor: '#00000000', // 动态设置背景色
    frame: false,
    transparent: true,
    ...(process.platform === 'darwin' ? { visualEffectState: 'active' as const } : {}),
    hasShadow: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload,
      additionalArguments: [
        `--echo-initial-dark=${initialBgColor === '#26262a'}`,
        `--echo-window-background=${JSON.stringify(windowBackground)}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      enableWebSQL: false,
      webSecurity: false, // 禁用 CORS 限制
      allowRunningInsecureContent: true, // 允许混合内容
      backgroundThrottling: false, // 最小化后不节流，保证播放状态和歌词同步
      zoomFactor: 1.0,
      devTools: devToolsEnabled, // 控制是否允许打开开发者工具
    },
  });
  syncMainWindowBackground();
  if (process.platform === 'win32' && Number(release().split('.')[2]) >= 22000) {
    // Transparent HWNDs lose Electron's native rounded frame. Clip the native
    // window itself so both web content and Acrylic respect the same corners.
    const roundedWindow = win;
    let lastShape = '';
    const syncShape = () => {
      if (roundedWindow.isDestroyed() || roundedWindow.isMinimized()) return;
      const [width, height] = roundedWindow.getSize();
      const square =
        roundedWindow.isMaximized() || roundedWindow.isFullScreen() || roundedWindow.isSnapped();
      const key = square ? 'square' : `${width}:${height}`;
      if (key === lastShape) return;
      roundedWindow.setShape(square ? [] : buildRoundedWindowShape(width, height));
      lastShape = key;
    };
    roundedWindow.on('resize', syncShape);
    roundedWindow.on('moved', syncShape);
    roundedWindow.on('maximize', syncShape);
    roundedWindow.on('unmaximize', syncShape);
    roundedWindow.on('restore', syncShape);
    roundedWindow.on('enter-full-screen', syncShape);
    roundedWindow.on('leave-full-screen', syncShape);
    syncShape();
  }
  await logMainMemory('createWindow:after BrowserWindow');

  applyWindowAppIcon(win);
  await logMainMemory('createWindow:after window icon');

  if (rememberWindowSize && initialWindowState.isMaximized) {
    win.maximize();
    await logMainMemory('createWindow:after maximize');
  }

  // 当窗口准备好显示时再展示，优雅解决启动白屏
  // 如果启用了启动时最小化，则不自动显示窗口，由用户通过托盘恢复
  win.once('ready-to-show', () => {
    void logMainMemory('main window:ready-to-show');
    if (!initialSettings.startMinimized) {
      win?.show();
      void logMainMemory('main window:after show');
    }
  });

  win.webContents.once('dom-ready', () => {
    void logMainMemory('main window:dom-ready');
  });

  win.webContents.once('did-finish-load', () => {
    void logMainMemory('main window:did-finish-load');
    const memoryLogTimer = setTimeout(
      () => void logMainMemory('main window:did-finish-load +2s'),
      2000,
    );
    if (typeof memoryLogTimer.unref === 'function') memoryLogTimer.unref();
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (!isPluginRendererGoneFailureReason(details.reason)) {
      if (details.reason === 'killed' && !isQuitting && win && !win.isDestroyed()) {
        win.reload();
      }
      return;
    }

    const pluginFailureRecorded = reportPluginRendererFailure(
      'render-process-gone',
      `主界面渲染进程异常退出：${details.reason}`,
    );
    if (pluginFailureRecorded && win && !win.isDestroyed()) {
      win.reload();
    }
  });
  win.on('unresponsive', () => {
    reportPluginRendererFailure('unresponsive', '主界面渲染进程无响应，已记录插件救援信息。');
  });

  if (url) {
    win.loadURL(url);
  } else {
    win.loadFile(indexHtml);
  }
  await logMainMemory('createWindow:after load request');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  const handleSystemSessionEnd = () => {
    isQuitting = true;
    flushPersistWindowState();
  };

  if (process.platform === 'win32') {
    // Windows 关机/重启/注销不会触发 app.before-quit，必须在窗口会话结束事件里落盘。
    win.on('query-session-end', handleSystemSessionEnd);
    win.on('session-end', handleSystemSessionEnd);
  }

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

  const handleWindowBoundsChanged = (kind: WindowBoundsChangeKind) => {
    if (!win || win.isDestroyed() || win.isMaximized()) return;
    if (!consumeWindowBoundsChange(kind)) return;
    schedulePersistWindowState();
  };

  if (process.platform === 'win32') {
    win.on('will-resize', markManualWindowResize);
    win.on('will-move', markManualWindowMove);
    win.on('resized', () => handleWindowBoundsChanged('resize'));
    win.on('moved', () => handleWindowBoundsChanged('move'));
  } else {
    win.on('resize', () => handleWindowBoundsChanged('resize'));
    win.on('move', () => handleWindowBoundsChanged('move'));
  }

  win.on('maximize', () => {
    flushPersistWindowState();
  });

  win.on('unmaximize', () => {
    flushPersistWindowState();
  });

  win.on('closed', () => {
    clearPersistWindowStateTimer();
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
