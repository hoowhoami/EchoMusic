import { globalShortcut, type BrowserWindow, type WebContents } from 'electron';
import { ipcRegistry } from './registry';
import { hideMainWindow, showMainWindow } from '../window';
import { restoreActiveWindowMode } from '../window/modeController';
import { toggleMiniPlayerWindow } from '../miniPlayer';
import type {
  PluginGlobalShortcutRegistrationPayload,
  PluginGlobalShortcutRegistrationResult,
  PluginGlobalShortcutTriggerPayload,
  ShortcutCommand,
  ShortcutMap,
  ShortcutRegistrationFailure,
  ShortcutRegistrationResult,
} from '../../shared/shortcuts';
import type { IpcContext } from './types';

let requestedShortcuts: ShortcutMap | null = null;
const appRegisteredAccelerators = new Set<string>();

type PluginGlobalShortcutRecord = {
  pluginId: string;
  registrationId: string;
  accelerator: string;
  webContents: WebContents;
};

const pluginGlobalShortcuts = new Map<string, PluginGlobalShortcutRecord>();
const pluginGlobalShortcutCleanupWebContentsIds = new Set<number>();

const getPluginGlobalShortcutKey = (pluginId: string, registrationId: string) =>
  `${pluginId}\u0000${registrationId}`;

const normalizeShortcutText = (value: unknown, maxLength = 160) =>
  String(value ?? '')
    .trim()
    .slice(0, maxLength);

const unregisterAppShortcuts = () => {
  for (const accelerator of appRegisteredAccelerators) {
    globalShortcut.unregister(accelerator);
  }
  appRegisteredAccelerators.clear();
};

const unregisterPluginGlobalShortcutByKey = (key: string) => {
  const record = pluginGlobalShortcuts.get(key);
  if (!record) return;
  globalShortcut.unregister(record.accelerator);
  pluginGlobalShortcuts.delete(key);
};

const unregisterPluginGlobalShortcutsForWebContents = (webContentsId: number) => {
  for (const [key, record] of pluginGlobalShortcuts.entries()) {
    if (record.webContents.id === webContentsId) {
      unregisterPluginGlobalShortcutByKey(key);
    }
  }
  pluginGlobalShortcutCleanupWebContentsIds.delete(webContentsId);
};

const ensurePluginGlobalShortcutCleanup = (webContents: WebContents) => {
  if (pluginGlobalShortcutCleanupWebContentsIds.has(webContents.id)) return;
  pluginGlobalShortcutCleanupWebContentsIds.add(webContents.id);
  webContents.once('destroyed', () => {
    unregisterPluginGlobalShortcutsForWebContents(webContents.id);
  });
};

const sendPluginGlobalShortcutTrigger = (record: PluginGlobalShortcutRecord) => {
  if (record.webContents.isDestroyed()) {
    unregisterPluginGlobalShortcutByKey(
      getPluginGlobalShortcutKey(record.pluginId, record.registrationId),
    );
    return;
  }
  const payload: PluginGlobalShortcutTriggerPayload = {
    pluginId: record.pluginId,
    registrationId: record.registrationId,
    accelerator: record.accelerator,
  };
  record.webContents.send('plugin-global-shortcut-trigger', payload);
};

const forwardToRenderer = (command: ShortcutCommand, getMainWindow: () => BrowserWindow | null) => {
  const win = getMainWindow();
  if (!win) return;
  if (command === 'toggleMainLyric') {
    showMainWindow();
  }
  win.webContents.send('shortcut-trigger', command);
};

const registerShortcuts = (
  shortcutMap: ShortcutMap,
  getMainWindow: () => BrowserWindow | null,
): ShortcutRegistrationResult => {
  unregisterAppShortcuts();
  const registered = {} as ShortcutMap;
  const failures: ShortcutRegistrationFailure[] = [];
  requestedShortcuts = shortcutMap;

  (Object.entries(shortcutMap) as Array<[ShortcutCommand, string]>).forEach(
    ([command, accelerator]) => {
      if (!accelerator) return;
      try {
        const didRegister = globalShortcut.register(accelerator, () => {
          if (command === 'toggleWindow') {
            const win = getMainWindow();
            if (!win) return;
            if (win.isVisible()) hideMainWindow();
            else void restoreActiveWindowMode();
            return;
          }
          if (command === 'toggleMiniPlayer') {
            void toggleMiniPlayerWindow();
            return;
          }
          forwardToRenderer(command, getMainWindow);
        });
        if (didRegister && globalShortcut.isRegistered(accelerator)) {
          registered[command] = accelerator;
          appRegisteredAccelerators.add(accelerator);
        } else {
          failures.push({ command, accelerator, reason: 'conflict' });
        }
      } catch {
        failures.push({ command, accelerator, reason: 'invalid' });
      }
    },
  );
  return { registered, failures };
};

const registerPluginGlobalShortcut = (
  webContents: WebContents,
  payload: PluginGlobalShortcutRegistrationPayload,
): PluginGlobalShortcutRegistrationResult => {
  const pluginId = normalizeShortcutText(payload?.pluginId, 80);
  const registrationId = normalizeShortcutText(payload?.registrationId, 120);
  const accelerator = normalizeShortcutText(payload?.accelerator, 120);
  const failureBase = { ok: false as const, pluginId, registrationId, accelerator };

  if (!pluginId || !registrationId || !accelerator) {
    return {
      ...failureBase,
      reason: 'invalid',
      message: 'pluginId, registrationId and accelerator are required',
    };
  }

  const key = getPluginGlobalShortcutKey(pluginId, registrationId);
  unregisterPluginGlobalShortcutByKey(key);

  try {
    const didRegister = globalShortcut.register(accelerator, () => {
      const record = pluginGlobalShortcuts.get(key);
      if (record) sendPluginGlobalShortcutTrigger(record);
    });
    if (!didRegister || !globalShortcut.isRegistered(accelerator)) {
      return {
        ...failureBase,
        reason: 'conflict',
        message: 'Shortcut is already registered or reserved by the system',
      };
    }
  } catch (error) {
    return {
      ...failureBase,
      reason: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  pluginGlobalShortcuts.set(key, {
    pluginId,
    registrationId,
    accelerator,
    webContents,
  });
  ensurePluginGlobalShortcutCleanup(webContents);

  return { ok: true, pluginId, registrationId, accelerator };
};

export const registerShortcutHandlers = ({ getMainWindow }: IpcContext) => {
  ipcRegistry.registerHandler(
    'shortcuts:register',
    (_event, payload: { enabled: boolean; shortcutMap: ShortcutMap }) => {
      if (!payload?.enabled) {
        unregisterAppShortcuts();
        requestedShortcuts = null;
        return { registered: {} as ShortcutMap, failures: [] };
      }
      return registerShortcuts(payload.shortcutMap, getMainWindow);
    },
  );

  ipcRegistry.registerHandler('shortcuts:refresh', () => {
    if (!requestedShortcuts) {
      return { registered: {} as ShortcutMap, failures: [] };
    }
    return registerShortcuts(requestedShortcuts, getMainWindow);
  });

  ipcRegistry.registerHandler(
    'shortcuts:register-plugin-global',
    (event, payload: PluginGlobalShortcutRegistrationPayload) =>
      registerPluginGlobalShortcut(event.sender, payload),
  );

  ipcRegistry.registerHandler(
    'shortcuts:unregister-plugin-global',
    (
      _event,
      payload: Pick<PluginGlobalShortcutRegistrationPayload, 'pluginId' | 'registrationId'>,
    ) => {
      const pluginId = normalizeShortcutText(payload?.pluginId, 80);
      const registrationId = normalizeShortcutText(payload?.registrationId, 120);
      if (!pluginId || !registrationId) return false;
      unregisterPluginGlobalShortcutByKey(getPluginGlobalShortcutKey(pluginId, registrationId));
      return true;
    },
  );
};
