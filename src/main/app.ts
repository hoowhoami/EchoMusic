import { app, BrowserWindow, globalShortcut } from 'electron';
import { initLogger } from './logger';
import log from './logger';
import { initApiServer } from './server';
import { registerIpcHandlers } from './ipc';
import { createWindow, getMainWindow } from './window';
import { restoreActiveWindowMode } from './windowModeController';
import { setActiveWindowMode } from './windowMode';
import { createDockMenu, destroyTray, initTray, refreshTray } from './tray';
import { getDesktopLyricWindow } from './desktopLyric';
import { initMpvPlayer, destroyMpvPlayer } from './mpv';
import { registerPlayerIpc } from './ipc/player';
import { registerAudioSpectrumIpc, unregisterAudioSpectrumIpc } from './audioSpectrum';
import { initMediaControls, destroyMediaControls } from './mediaControls';
import { initPowerMonitor } from './powerMonitor';
import { clearPluginRuntimeSession, setPluginSafeMode } from './plugins';

const WM_TASKBARCREATED = 0x031a;

// --- 初始化日志 ---
initLogger();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.hoowhoami.echomusic');
}

const hasSafeModeArg = (argv: string[]) => argv.includes('--safe-mode');

if (hasSafeModeArg(process.argv)) {
  const result = setPluginSafeMode(true);
  if (result.ok) {
    log.warn('[Plugin] Safe mode enabled from command line');
  } else {
    log.error('[Plugin] Failed to enable safe mode from command line', result.error);
  }
}

const installWindowsTrayRecovery = () => {
  if (process.platform !== 'win32') return;
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.hookWindowMessage(WM_TASKBARCREATED, () => {
    refreshTray();
  });
};

// --- 保持应用单例运行 ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (hasSafeModeArg(argv)) {
      void setPluginSafeMode(true);
      setActiveWindowMode('main');
    }
    void restoreActiveWindowMode();
  });

  // IPC handler 必须在窗口创建前注册
  registerIpcHandlers({
    getMainWindow,
  });

  app.whenReady().then(async () => {
    const trayContext = {
      getMainWindow,
      restoreWindow: restoreActiveWindowMode,
    };

    // --- Loading 阶段：在窗口创建前完成核心服务初始化 ---

    // 注册播放器 IPC（渲染进程启动后立即可用）
    const mpvRef: { current: import('./mpv/controller').MpvController | null } = { current: null };
    registerPlayerIpc(mpvRef);
    registerAudioSpectrumIpc();

    // 并行初始化 API 服务器和 mpv 播放引擎
    const [, mpvInstance] = await Promise.all([
      initApiServer().catch((err) => {
        log.error('[Main] Failed to init API server:', err);
      }),
      initMpvPlayer(getMainWindow).catch((err) => {
        log.error('[Main] Failed to init mpv player:', err);
        return null;
      }),
    ]);

    mpvRef.current = mpvInstance ?? null;
    log.info('[Main] Pre-window initialization complete', {
      mpvAvailable: !!mpvRef.current,
      platform: process.platform,
      arch: process.arch,
    });

    // 初始化原生媒体控制（SMTC / MPNowPlaying / MPRIS）
    initMediaControls(getMainWindow);

    // 注册系统挂起/唤醒处理：盒盖睡眠后暂停并释放 blocker，唤醒后重建音频并恢复播放
    initPowerMonitor({ getMainWindow, getController: () => mpvRef.current });

    // --- 创建主窗口 ---
    await createWindow();

    try {
      initTray(trayContext);
    } catch (err) {
      log.error('[Main] Failed to init tray:', err);
    }
    installWindowsTrayRecovery();

    if (process.platform === 'darwin') {
      app.dock?.setMenu(createDockMenu());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', async () => {
    const mainWindow = getMainWindow();

    if (mainWindow) {
      await restoreActiveWindowMode();
    } else {
      await createWindow();
      installWindowsTrayRecovery();
      await restoreActiveWindowMode();
    }
  });

  let isExiting = false;

  app.on('before-quit', (event) => {
    if (isExiting) return;
    isExiting = true;
    event.preventDefault();
    log.info('[Main] before-quit: hiding windows and scheduling cleanup');

    // 第一步：立即隐藏所有窗口 + 销毁托盘，用户视觉上已退出
    destroyTray();
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.hide();
    });

    // 第二步：让主线程完成一轮消息循环（渲染窗口隐藏），再执行阻塞清理
    setImmediate(() => {
      log.info('[Main] before-quit: cleaning up native resources');
      globalShortcut.unregisterAll();
      clearPluginRuntimeSession();
      unregisterAudioSpectrumIpc();
      destroyMediaControls();
      destroyMpvPlayer();
      // 销毁桌面歌词窗口
      try {
        const lyricWin = getDesktopLyricWindow();
        if (lyricWin && !lyricWin.isDestroyed()) lyricWin.destroy();
      } catch {
        // 忽略
      }
      // 销毁所有剩余窗口
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.destroy();
      });
      app.exit(0);
    });
  });
}
