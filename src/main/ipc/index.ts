import { ipcMain } from 'electron';
import { registerApiServerHandlers } from './server';
import { registerWindowHandlers } from './window';
import { registerSettingsHandlers } from './settings';
import { registerShortcutHandlers } from './shortcuts';
import { registerTrayHandlers } from './tray';
import { registerDesktopLyricHandlers } from '../desktopLyric';
import type { IpcContext } from './types';

let registered = false;

export const registerIpcHandlers = (context: IpcContext) => {
  if (registered) return;
  registerWindowHandlers(context);
  registerApiServerHandlers();
  registerSettingsHandlers(context);
  registerShortcutHandlers(context);
  registerTrayHandlers();
  registerDesktopLyricHandlers();
  registered = true;
};

export const unregisterIpcHandlers = () => {
  ipcMain.removeAllListeners('window-control');
  ipcMain.removeAllListeners('window-toggle');
  ipcMain.removeAllListeners('quit-app');
  ipcMain.removeAllListeners('shortcuts:register');
  ipcMain.removeAllListeners('shortcuts:refresh');
  ipcMain.removeAllListeners('tray:sync-playback');
  ipcMain.removeAllListeners('api-server:stop');
  ipcMain.removeAllListeners('open-log-directory');
  ipcMain.removeAllListeners('check-for-updates');
  ipcMain.removeAllListeners('open-external');
  ipcMain.removeAllListeners('open-disclaimer');
  ipcMain.removeAllListeners('clear-app-data');
  ipcMain.removeAllListeners('desktop-lyric:set-ignore-mouse-events');
  ipcMain.removeAllListeners('desktop-lyric:move');
  ipcMain.removeAllListeners('desktop-lyric:resize');
  ipcMain.removeAllListeners('desktop-lyric:set-height');
  ipcMain.removeAllListeners('desktop-lyric:toggle-fixed-size');
  ipcMain.removeAllListeners('desktop-lyric:command');
  ipcMain.removeHandler('api-server:start');
  ipcMain.removeHandler('api-server:status');
  ipcMain.removeHandler('app:get-info');
  ipcMain.removeHandler('desktop-lyric:get-snapshot');
  ipcMain.removeHandler('desktop-lyric:get-bounds');
  ipcMain.removeHandler('desktop-lyric:get-virtual-screen-bounds');
  ipcMain.removeHandler('desktop-lyric:show');
  ipcMain.removeHandler('desktop-lyric:hide');
  ipcMain.removeHandler('desktop-lyric:toggle-lock');
  ipcMain.removeHandler('desktop-lyric:update-settings');
  ipcMain.removeAllListeners('desktop-lyric:sync-snapshot');
};
