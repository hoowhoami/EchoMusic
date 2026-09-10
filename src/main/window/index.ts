import { release } from 'node:os';
import {
  getWindowComposition,
  resolveWindowBackground,
  resolveRunningWindowBackground,
  normalizeWindowBackground,
  type WindowBackground,
} from '../../shared/window-background';
import { BrowserWindow, shell, app, nativeTheme, powerSaveBlocker, screen } from 'electron';
import { join } from 'path';
import type { CloseBehavior, ThemeMode } from '../../shared/app';
import { getMainAppSettings, setMainAppSetting } from '../storage/settings';
import { getActiveWindowMode, setActiveWindowMode } from './mode';
import { isPluginRendererGoneFailureReason, reportPluginRendererFailure } from '../plugins';
import { ipcRegistry } from '../ipc/registry';
import { applyWindowAppIcon, resolveWindowIconPath } from '../appIcons';
import { logMainMemory } from '../diagnostics/memory';
import { resolveMainWindowPlacement, resolveWaylandWindowSize } from '../windowSizing';
import { isWaylandWindowingBackend } from '../../shared/windowing';
import { trackMainWindowState } from './state';
import { installWindowPointerEvents } from './pointer';
import {
  applyWindowsComposition,
  getWindowsCompositionOptions,
  readWindowsCompositionDiagnostics,
  supportsWindowsAccent,
} from './windowsComposition';
import { applyMacWindowBackground } from './macComposition';
import { createTitleBarController } from './titleBar';
import { installWindowZoom, registerWindowZoomHandlers } from './zoom';
import {
  installWindowFullscreen,
  installWindowFullscreenShortcut,
  isWindowFullscreen,
  isWindowFullscreenTransitioning,
  setWindowFullscreen,
} from './fullscreen';
import { normalizeZoomLevel, titleBarHeight, zoomLevelToFactor } from '../../shared/window-zoom';

const initialSettings = getMainAppSettings();
let closeBehavior: CloseBehavior = initialSettings.closeBehavior;
let currentTheme: ThemeMode = initialSettings.theme;
let windowBackground = normalizeWindowBackground(initialSettings.windowBackground);
let windowBackgroundActiveEnabled = windowBackground.enabled;
const supportsWindowFrost =
  process.platform === 'darwin' ||
  (process.platform === 'win32' &&
    (Number(release().split('.')[2]) >= 22621 || supportsWindowsAccent()));

if (!supportsWindowFrost && process.platform !== 'win32') windowBackground.frosted = false;
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
let zoomController: ReturnType<typeof installWindowZoom> | null = null;
let backgroundUnavailableReason = '';
let titleBarController: ReturnType<typeof createTitleBarController> | null = null;
const usesNativeOverlay = process.platform === 'win32' || process.platform === 'linux';
const usesWayland = isWaylandWindowingBackend();
const syncTitleBar = (level = normalizeZoomLevel(getMainAppSettings().windowZoomLevel)) => {
  titleBarController?.sync(level);
};

const canUseMainWindow = (mainWindow: BrowserWindow | null): mainWindow is BrowserWindow => {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
};

export function hideMainWindow() {
  if (!canUseMainWindow(win)) return;

  if (isWindowFullscreen(win)) {
    setWindowFullscreen(win, false);
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

let activeComposition = getWindowComposition(
  windowBackground,
  process.platform,
  Number(release().split('.')[2]),
);
let windowBackgroundActiveFrosted: boolean | null = windowBackground.frosted;
let windowBackgroundRestartRequired = false;
export const getMainWindowClientCornerRadius = () => activeComposition.clientCornerRadius;

const syncMainWindowBackground = () => {
  if (!canUseMainWindow(win)) return;
  if (nativeTheme.themeSource !== currentTheme) nativeTheme.themeSource = currentTheme;
  syncTitleBar();
  if (process.platform === 'win32') {
    backgroundUnavailableReason = '';
    try {
      applyWindowsComposition(win, windowBackground, Number(release().split('.')[2]));
      win.setBackgroundColor(
        windowBackground.enabled ? '#00000000' : getMainWindowBackgroundColor(),
      );
      windowBackgroundActiveEnabled = windowBackground.enabled;
      windowBackgroundActiveFrosted = windowBackground.frosted;
    } catch (error) {
      windowBackgroundActiveEnabled = false;
      windowBackgroundActiveFrosted = false;
      backgroundUnavailableReason = error instanceof Error ? error.message : '系统背景效果不可用';
      win.setBackgroundColor(getMainWindowBackgroundColor());
    }
  }
  if (process.platform !== 'win32') {
    const state = resolveRunningWindowBackground(
      windowBackground,
      process.platform,
      activeComposition.transparent,
    );
    windowBackgroundRestartRequired = state.restartRequired;
    windowBackgroundActiveEnabled = state.background.enabled;
    windowBackgroundActiveFrosted = state.background.frosted;
    if (process.platform === 'darwin') {
      const dark =
        currentTheme === 'dark' || (currentTheme === 'system' && nativeTheme.shouldUseDarkColors);
      applyMacWindowBackground(win, state.background, activeComposition.transparent, dark);
    } else {
      win.setBackgroundColor(
        state.background.enabled ? '#00000000' : getMainWindowBackgroundColor(),
      );
    }
  }
  // Publish only after native materials and surface colors agree with the renderer state.
  win.webContents.send('window-background:changed', readBackgroundState());
};

const readBackgroundState = () => ({
  background: windowBackground,
  activeEnabled: windowBackgroundActiveEnabled,
  activeFrosted: windowBackgroundActiveFrosted,
  supportsFrost: supportsWindowFrost,
  frostBackend: !supportsWindowFrost
    ? 'none'
    : process.platform === 'darwin'
      ? 'vibrancy'
      : Number(release().split('.')[2]) >= 22621
        ? 'acrylic'
        : 'blur-behind',
  live: process.platform === 'win32',
  frostLive: process.platform === 'darwin' || process.platform === 'win32',
  restartRequired: windowBackgroundRestartRequired,
  unavailableReason: backgroundUnavailableReason,
});

export const registerMainWindowPreferenceHandlers = () => {
  registerWindowZoomHandlers(
    () => win,
    () => zoomController,
  );
  nativeTheme.on('updated', syncMainWindowBackground);
  ipcRegistry.registerListener('window:lyric-visibility', (event, visible: unknown) => {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      typeof visible !== 'boolean'
    )
      return;
    titleBarController?.setLyricVisible(visible);
  });
  ipcRegistry.registerHandler('window-background:get', readBackgroundState);
  ipcRegistry.registerHandler('window-background:diagnostics', (event) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('仅主窗口可以读取窗口诊断信息');
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      platform: process.platform,
      osRelease: release(),
      packaged: app.isPackaged,
      gpuFeatures: app.getGPUFeatureStatus(),
      background: readBackgroundState(),
      nativeWindowBackground: win.getBackgroundColor(),
      composition: activeComposition,
      windows: process.platform === 'win32' ? readWindowsCompositionDiagnostics(win) : undefined,
    };
  });
  ipcRegistry.registerHandler('window-background:set', (event, value: WindowBackground) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('仅主窗口可以调整背景');
    windowBackground = normalizeWindowBackground(value);
    if (!supportsWindowFrost && process.platform !== 'win32') windowBackground.frosted = false;

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
    windowStateTracker?.flush();
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

let windowStateTracker: ReturnType<typeof trackMainWindowState> | null = null;
const flushPersistWindowState = () => windowStateTracker?.flush();

export function getMainWindow() {
  return win;
}

export async function createWindow() {
  await logMainMemory('createWindow:start');
  const preload = join(__dirname, '../preload/index.js');
  const url = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = join(__dirname, '../../dist/index.html');

  const initialBgColor = getMainWindowBackgroundColor();

  const initialWindowState = getMainAppSettings().windowState;
  const displays = screen.getAllDisplays();
  const placement = usesWayland
    ? resolveWaylandWindowSize(rememberWindowSize ? initialWindowState : null)
    : resolveMainWindowPlacement(
        rememberWindowSize ? initialWindowState : null,
        displays,
        screen.getPrimaryDisplay().id,
      );
  const windowIconPath = process.platform === 'darwin' ? '' : resolveWindowIconPath();
  await logMainMemory('createWindow:before BrowserWindow');

  windowBackgroundActiveEnabled = windowBackground.enabled;
  activeComposition = getWindowComposition(
    windowBackground,
    process.platform,
    Number(release().split('.')[2]),
  );
  windowBackgroundActiveFrosted = windowBackground.frosted;
  windowBackgroundRestartRequired = false;
  win = new BrowserWindow({
    title: 'EchoMusic',
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    ...placement.bounds,
    minWidth: placement.minWidth,
    minHeight: placement.minHeight,
    show: false, // 初始不显示，防止白屏
    backgroundColor: windowBackgroundActiveEnabled ? '#00000000' : initialBgColor,
    frame: process.platform === 'darwin',
    // Electron's WS_THICKFRAME option is Windows-only, independent of materials.
    ...(process.platform === 'win32' ? { thickFrame: true } : {}),
    ...(process.platform === 'win32'
      ? getWindowsCompositionOptions(Number(release().split('.')[2]))
      : {}),
    transparent: activeComposition.transparent,
    roundedCorners: activeComposition.clientCornerRadius === 0,
    ...(process.platform === 'darwin'
      ? {
          // Electron chooses the translucent compositor during Widget initialization.
          // Prime Vibrancy even when effects are off so later live toggles clear old frames.
          // syncMainWindowBackground removes the material before loading/showing in off mode.
          // Keep transparent:false for ordinary/frosted windows and their native frame.
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          acceptFirstMouse: true,
          titleBarOverlay: true,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    hasShadow: true,
    titleBarStyle: 'hidden',
    ...(usesNativeOverlay
      ? {
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: initialBgColor === '#26262a' ? '#ffffff' : '#202020',
            height: titleBarHeight(normalizeZoomLevel(getMainAppSettings().windowZoomLevel)),
          },
        }
      : {}),
    webPreferences: {
      preload,
      additionalArguments: [
        `--echo-initial-dark=${initialBgColor === '#26262a'}`,
        `--echo-window-background=${JSON.stringify({ ...resolveWindowBackground(windowBackground, windowBackgroundActiveEnabled), clientCornerRadius: rememberWindowSize && initialWindowState.isMaximized ? 0 : activeComposition.clientCornerRadius })}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      enableWebSQL: false,
      webSecurity: false, // 禁用 CORS 限制
      allowRunningInsecureContent: true, // 允许混合内容
      backgroundThrottling: false, // 最小化后不节流，保证播放状态和歌词同步
      zoomFactor: zoomLevelToFactor(normalizeZoomLevel(getMainAppSettings().windowZoomLevel)),
      devTools: devToolsEnabled, // 控制是否允许打开开发者工具
    },
  });
  installWindowFullscreen(win);
  if (process.platform === 'darwin') {
    // Keep sheets below the same fixed native strip as the traffic lights.
    win.setSheetOffset(46);
  }
  if (displays.length > 1 && process.platform !== 'linux') {
    // VS Code's Electron workaround: the constructor can clamp a secondary
    // display's larger bounds to the primary display before the HWND is placed.
    win.setBounds(placement.bounds);
  }
  const mainWindow = win;
  installWindowPointerEvents(mainWindow);
  titleBarController = usesNativeOverlay
    ? createTitleBarController(
        win,
        () =>
          currentTheme === 'dark' || (currentTheme === 'system' && nativeTheme.shouldUseDarkColors),
        () => normalizeZoomLevel(getMainAppSettings().windowZoomLevel),
      )
    : null;
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) titleBarController?.setLyricVisible(false);
  });
  windowStateTracker = trackMainWindowState(win, {
    initial: initialWindowState,
    enabled: () => rememberWindowSize,
    save: (state) => setMainAppSetting('windowState', state),
    supportsPosition: !usesWayland,
    macOS: process.platform === 'darwin',
    transitioning: () => isWindowFullscreenTransitioning(mainWindow),
  });
  zoomController = installWindowZoom(win, syncTitleBar);
  installWindowFullscreenShortcut(win);
  syncMainWindowBackground();
  await logMainMemory('createWindow:after BrowserWindow');

  applyWindowAppIcon(win);
  await logMainMemory('createWindow:after window icon');

  if (rememberWindowSize && initialWindowState.isMaximized === true) {
    win.maximize();
    await logMainMemory('createWindow:after maximize');
  }

  // 当窗口准备好显示时再展示，优雅解决启动白屏
  // 如果启用了启动时最小化，则不自动显示窗口，由用户通过托盘恢复
  win.once('ready-to-show', () => {
    flushPersistWindowState();
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
    flushPersistWindowState();
    if (isQuitting) return;

    if (closeBehavior === 'tray') {
      event.preventDefault();
      hideMainWindow();
    } else {
      quitApplication();
    }
  });

  win.on('closed', () => {
    windowStateTracker?.dispose();
    windowStateTracker = null;
    syncPowerSaveBlocker();
    zoomController = null;
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
