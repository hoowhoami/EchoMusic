import { app, BrowserWindow, globalShortcut } from 'electron';
import { initLogger } from './logger';
import { startApiServer, stopApiServer } from './server';
import { registerIpcHandlers } from './ipc';
import { createWindow, getMainWindow, restoreWindow, showMainWindow } from './window';
import { createDockMenu, destroyTray, initTray, refreshTray } from './tray';
import { getDesktopLyricWindow } from './desktopLyric';

const WM_TASKBARCREATED = 0x031a;

// --- 初始化日志 ---
initLogger();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.hoowhoami.echomusic');
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
  app.on('second-instance', () => {
    restoreWindow();
  });

  // 注册 IPC 处理器
  registerIpcHandlers({
    getMainWindow,
  });

  app.whenReady().then(async () => {
    const trayContext = {
      getMainWindow,
      restoreWindow,
    };

    await createWindow();
    try {
      initTray(trayContext);
    } catch (err) {
      console.error('[Main] Failed to init tray:', err);
    }
    installWindowsTrayRecovery();

    void startApiServer().catch((err) => {
      console.error('[Main] Failed to start API server:', err);
    });

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
      showMainWindow();
    } else {
      await createWindow();
      installWindowsTrayRecovery();
    }
  });

  let isExiting = false;

  app.on('before-quit', (event) => {
    if (isExiting) return;
    isExiting = true;
    event.preventDefault();
    console.log('[Main] before-quit: cleaning up and exiting...');
    globalShortcut.unregisterAll();
    destroyTray();
    stopApiServer();
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
}
