import { ipcRegistry } from './registry';
import { registerApiServerHandlers } from './server';
import { registerWindowHandlers } from './window';
import { registerPlayerIpc } from './player';
import { registerSettingsHandlers } from './settings';
import { registerShortcutHandlers } from './shortcuts';
import { registerTrayHandlers } from './tray';
import { registerDesktopLyricHandlers } from '../desktopLyric';
import { registerMainWindowPreferenceHandlers } from '../window';
import { registerMiniPlayerHandlers } from '../miniPlayer';
import { registerNowPlayingHandlers } from '../nowPlaying';
import { registerExternalHandlers } from './external';
import { registerStorageHandlers } from './storage';
import { registerPluginHandlers } from './plugins';
import { registerPluginWindowHandlers } from '../pluginWindows';
import { registerShareHandlers } from './share';
import type { IpcContext } from './types';

let registered = false;

export const registerIpcHandlers = (context: IpcContext) => {
  if (registered) return;
  registerWindowHandlers(context);
  registerMainWindowPreferenceHandlers();
  registerApiServerHandlers();
  registerPlayerIpc(context.mpvRef);
  registerSettingsHandlers(context);
  registerShortcutHandlers(context);
  registerTrayHandlers();
  registerNowPlayingHandlers(context);
  registerDesktopLyricHandlers();
  registerMiniPlayerHandlers();
  registerExternalHandlers();
  registerStorageHandlers();
  registerPluginHandlers(context);
  registerPluginWindowHandlers();
  registerShareHandlers();
  registered = true;
};

export const unregisterIpcHandlers = () => {
  ipcRegistry.unregisterAll();
  registered = false;
};
