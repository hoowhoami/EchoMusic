import { app, BrowserWindow } from 'electron';
import { release } from 'node:os';
import type { WindowFrameState } from '../../shared/window-frame';
import { ipcRegistry } from './registry';
import {
  getMainWindowClientCornerRadius,
  hideMainWindow,
  quitApplication,
  requestMainWindowClose,
} from '../window';
import { restoreActiveWindowMode } from '../window/modeController';
import { showMiniPlayerWindowOnTop } from '../miniPlayer';
import type {
  PluginHostWindowResult,
  PluginHostWindowTarget,
  PluginShowOnTopOptions,
} from '../../shared/plugins';
import type { IpcContext } from './types';

export const registerWindowHandlers = ({ getMainWindow }: IpcContext) => {
  // Subscribe once per native window; renderer reloads query its current state again.
  const observedWindows = new WeakSet<BrowserWindow>();
  ipcRegistry.registerHandler('window:frame-state', (event): WindowFrameState | null => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== getMainWindow()) return null;
    const readState = (): WindowFrameState => ({
      clientCorners: getMainWindowClientCornerRadius() > 0,
      visible:
        !win.isMaximized() &&
        !win.isFullScreen() &&
        !(process.platform === 'win32' && win.isSnapped?.()),
      radius:
        process.platform === 'darwin'
          ? 10
          : process.platform === 'win32' && Number(release().split('.')[2]) >= 22000
            ? 8
            : 0,
    });
    if (!observedWindows.has(win)) {
      let previousState = readState();
      observedWindows.add(win);
      const publish = () => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          const state = readState();
          if (state.visible === previousState.visible && state.radius === previousState.radius)
            return;
          previousState = state;
          win.webContents.send('window:frame-state-changed', state);
        }
      };
      win.on('maximize', publish);
      win.on('unmaximize', publish);
      win.on('enter-full-screen', publish);
      win.on('leave-full-screen', publish);
      win.on('restore', publish);
      win.on('resize', publish);
      win.on('moved', publish);
    }
    return readState();
  });

  ipcRegistry.registerListener(
    'window-control',
    (event, action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!browserWindow) return;
      if (action === 'minimize') browserWindow.minimize();
      else if (action === 'maximize') {
        if (browserWindow.isMaximized()) browserWindow.unmaximize();
        else browserWindow.maximize();
      } else if (action === 'fullscreen') {
        browserWindow.setFullScreen(!browserWindow.isFullScreen());
      } else if (action === 'close') {
        const mainWindow = getMainWindow();
        if (mainWindow && browserWindow.id === mainWindow.id) {
          requestMainWindowClose();
        } else {
          browserWindow.close();
        }
      }
    },
  );

  ipcRegistry.registerListener('window-drag:start', () => {});
  ipcRegistry.registerListener('window-drag:move', () => {});
  ipcRegistry.registerListener('window-drag:end', () => {});

  ipcRegistry.registerListener('window-toggle', () => {
    const browserWindow = getMainWindow();
    if (!browserWindow) return;
    if (browserWindow.isVisible()) {
      hideMainWindow();
    } else {
      void restoreActiveWindowMode();
    }
  });

  ipcRegistry.registerListener('quit-app', () => {
    quitApplication();
  });

  ipcRegistry.registerHandler('app:relaunch', () => {
    setImmediate(() => {
      app.relaunch();
      quitApplication();
    });
    return true;
  });

  ipcRegistry.registerHandler(
    'plugins:host:show-on-top',
    (
      _event,
      target: PluginHostWindowTarget = 'main',
      options?: PluginShowOnTopOptions,
    ): PluginHostWindowResult => {
      const focus = options?.focus !== false;
      if (target === 'mini-player') {
        return showMiniPlayerWindowOnTop(focus)
          ? { ok: true, target }
          : { ok: false, error: 'mini 播放器未开启' };
      }
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不可用' };
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) {
        if (focus) win.show();
        else win.showInactive();
      }
      if (typeof win.moveTop === 'function') win.moveTop();
      if (focus) win.focus();
      return { ok: true, target: 'main' };
    },
  );
};
