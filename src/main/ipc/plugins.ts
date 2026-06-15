import { ipcRegistry } from './registry';
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import type {
  PluginAssetSourceResult,
  PluginAppIconRefreshResult,
  PluginDialogResult,
  PluginFileUrlResult,
  PluginFailureRecord,
  PluginListFilesOptions,
  PluginListFilesResult,
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
  PluginListResult,
  PluginLocalInstallOptions,
  PluginLocalInstallResult,
  PluginMarketplaceInstallOptions,
  PluginMarketplaceInstallResult,
  PluginMarketplaceListResult,
  PluginMarketplaceRemoveSourceResult,
  PluginMarketplaceRequestOptions,
  PluginMarketplaceSourceInput,
  PluginMarketplaceSourceListResult,
  PluginMarketplaceSourceMutationResult,
  PluginMarketplaceSourcePatch,
  PluginOpenDialogOptions,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginReadFileBytesOptions,
  PluginReadFileBytesResult,
  PluginReadTextFileOptions,
  PluginReadTextFileResult,
  PluginSetEnabledResult,
  PluginReportFailureResult,
  PluginSetSafeModeResult,
  PluginUninstallResult,
  PluginWriteFileData,
  PluginWriteFileOptions,
  PluginWriteFileResult,
  PluginDeleteFileResult,
  PluginRestoreIconResult,
} from '../../shared/plugins';
import {
  clearPluginFailureRecord,
  clearPluginStartup,
  deletePluginData,
  deletePluginFile,
  getPluginData,
  getPluginDirectory,
  getPluginFileUrl,
  installPluginsFromLocal,
  addPluginMarketplaceSource,
  installPluginFromMarketplace,
  listPluginFiles,
  listPluginImageFiles,
  listPluginMarketplace,
  listPluginMarketplaceSources,
  listPlugins,
  launchPluginProcess,
  markPluginStartup,
  openPluginDirectory,
  patchPluginMarketplaceSource,
  readPluginFileBytes,
  readPluginTextAsset,
  readPluginTextFile,
  readPluginWindowTextAsset,
  removePluginMarketplaceSource,
  reportPluginFailure,
  setPluginData,
  setPluginActiveSession,
  setPluginEnabled,
  setPluginSafeMode,
  terminatePluginProcess,
  uninstallPlugin,
  writePluginFile,
} from '../plugins';
import { closePluginWindows } from '../pluginWindows';
import {
  applyDesktopAppIcon,
  applyTaskbarShortcutIcon,
  applyWindowAppIcon,
  isPluginAppIconStorageKey,
  refreshAppIconConfig,
  restoreDefaultDesktopIcon,
  restoreDefaultTaskbarIcon,
  setRuntimeWindowIcon,
  restoreDefaultWindowIcon,
} from '../appIcons';
import { refreshTray } from '../tray';
import type { IpcContext } from './types';

const sanitizeDialogOptions = (
  options: PluginOpenDialogOptions | undefined,
  properties: OpenDialogOptions['properties'],
): OpenDialogOptions => ({
  title: typeof options?.title === 'string' ? options.title : undefined,
  defaultPath: typeof options?.defaultPath === 'string' ? options.defaultPath : undefined,
  buttonLabel: typeof options?.buttonLabel === 'string' ? options.buttonLabel : undefined,
  filters: Array.isArray(options?.filters)
    ? options.filters
        .map((filter) => ({
          name: String(filter?.name || 'Files'),
          extensions: Array.isArray(filter?.extensions)
            ? filter.extensions.map((extension) => String(extension).replace(/^\./, ''))
            : ['*'],
        }))
        .filter((filter) => filter.extensions.length > 0)
    : undefined,
  properties,
});

const showPluginOpenDialog = async (
  context: IpcContext,
  options: OpenDialogOptions,
): Promise<PluginDialogResult> => {
  const win = context.getMainWindow();
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return {
    canceled: result.canceled,
    paths: result.filePaths,
  };
};

export const registerPluginHandlers = (context: IpcContext) => {
  const refreshPluginAppIcons = (): PluginAppIconRefreshResult => {
    refreshAppIconConfig();
    applyWindowAppIcon(context.getMainWindow());
    refreshTray();
    applyDesktopAppIcon();
    return applyTaskbarShortcutIcon();
  };

  ipcRegistry.registerHandler('plugins:list', (): PluginListResult => listPlugins());
  ipcRegistry.registerHandler('plugins:get-directory', (): string => getPluginDirectory());
  ipcRegistry.registerHandler('plugins:open-directory', (): string => openPluginDirectory());
  ipcRegistry.registerHandler(
    'plugins:marketplace:sources:list',
    (): PluginMarketplaceSourceListResult => ({
      sources: listPluginMarketplaceSources(),
    }),
  );
  ipcRegistry.registerHandler(
    'plugins:marketplace:sources:add',
    (
      _event,
      input: PluginMarketplaceSourceInput,
      options?: PluginMarketplaceRequestOptions,
    ): Promise<PluginMarketplaceSourceMutationResult> => addPluginMarketplaceSource(input, options),
  );
  ipcRegistry.registerHandler(
    'plugins:marketplace:sources:patch',
    (
      _event,
      sourceId: string,
      patch: PluginMarketplaceSourcePatch,
    ): PluginMarketplaceSourceMutationResult => patchPluginMarketplaceSource(sourceId, patch),
  );
  ipcRegistry.registerHandler(
    'plugins:marketplace:sources:remove',
    (_event, sourceId: string): PluginMarketplaceRemoveSourceResult =>
      removePluginMarketplaceSource(sourceId),
  );
  ipcRegistry.registerHandler(
    'plugins:marketplace:list',
    (_event, options?: PluginMarketplaceRequestOptions): Promise<PluginMarketplaceListResult> =>
      listPluginMarketplace(options),
  );
  ipcRegistry.registerHandler(
    'plugins:marketplace:install',
    (
      _event,
      sourceId: string,
      pluginId: string,
      options?: PluginMarketplaceInstallOptions,
    ): Promise<PluginMarketplaceInstallResult> =>
      installPluginFromMarketplace(sourceId, pluginId, options),
  );
  ipcRegistry.registerHandler(
    'plugins:install-local',
    (
      _event,
      paths: string[],
      options?: PluginLocalInstallOptions,
    ): Promise<PluginLocalInstallResult> => installPluginsFromLocal(paths, options),
  );
  ipcRegistry.registerHandler('plugins:runtime-reload', (event): void => {
    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        if (win.webContents.id === event.sender.id) return;
        win.webContents.send('plugins:runtime-reload-requested');
      } catch {
        // ignore windows that are closing while broadcasting
      }
    });
  });
  ipcRegistry.registerHandler(
    'plugins:dialog:select-directory',
    (_event, options?: PluginOpenDialogOptions): Promise<PluginDialogResult> =>
      showPluginOpenDialog(
        context,
        sanitizeDialogOptions(options, [
          'openDirectory',
          ...(options?.multiple ? ['multiSelections' as const] : []),
        ]),
      ),
  );
  ipcRegistry.registerHandler(
    'plugins:dialog:select-files',
    (_event, options?: PluginOpenDialogOptions): Promise<PluginDialogResult> =>
      showPluginOpenDialog(
        context,
        sanitizeDialogOptions(options, [
          'openFile',
          ...(options?.multiple ? ['multiSelections' as const] : []),
        ]),
      ),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:list-image-files',
    (
      _event,
      directoryPath: string,
      options?: PluginListImageFilesOptions,
    ): PluginListImageFilesResult => listPluginImageFiles(directoryPath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:list-files',
    (
      _event,
      pluginId: string,
      directoryPath: string,
      options?: PluginListFilesOptions,
    ): PluginListFilesResult => listPluginFiles(pluginId, directoryPath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:get-file-url',
    (_event, filePath: string): PluginFileUrlResult => getPluginFileUrl(filePath),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:read-text-file',
    (
      _event,
      pluginId: string,
      filePath: string,
      options?: PluginReadTextFileOptions,
    ): PluginReadTextFileResult => readPluginTextFile(pluginId, filePath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:read-file-bytes',
    (
      _event,
      pluginId: string,
      filePath: string,
      options?: PluginReadFileBytesOptions,
    ): PluginReadFileBytesResult => readPluginFileBytes(pluginId, filePath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:write-file',
    (
      _event,
      pluginId: string,
      filePath: string,
      data: PluginWriteFileData,
      options?: PluginWriteFileOptions,
    ): PluginWriteFileResult => {
      const result = writePluginFile(pluginId, filePath, data, options);
      if (result.ok) refreshPluginAppIcons();
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:fs:delete-file',
    (_event, pluginId: string, filePath: string): PluginDeleteFileResult => {
      const result = deletePluginFile(pluginId, filePath);
      if (result.ok) refreshPluginAppIcons();
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:process:launch',
    (
      event,
      pluginId: string,
      options: PluginProcessLaunchOptions,
    ): Promise<PluginProcessLaunchResult> =>
      launchPluginProcess(
        pluginId,
        options,
        BrowserWindow.fromWebContents(event.sender) ?? context.getMainWindow(),
      ),
  );
  ipcRegistry.registerHandler(
    'plugins:process:terminate',
    (_event, pluginId: string, pid: number): PluginProcessTerminateResult =>
      terminatePluginProcess(pluginId, pid),
  );
  ipcRegistry.registerHandler(
    'plugins:set-enabled',
    (_event, pluginId: string, enabled: boolean): PluginSetEnabledResult => {
      const result = setPluginEnabled(pluginId, enabled);
      if (result.ok) {
        if (!enabled) closePluginWindows(pluginId);
        refreshPluginAppIcons();
      }
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:set-safe-mode',
    (_event, enabled: boolean): PluginSetSafeModeResult => {
      const result = setPluginSafeMode(enabled);
      if (result.ok && enabled) closePluginWindows();
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:uninstall',
    (_event, pluginId: string): PluginUninstallResult => {
      closePluginWindows(pluginId);
      const result = uninstallPlugin(pluginId);
      if (result.ok) refreshPluginAppIcons();
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:startup:mark',
    (_event, pluginIds: string[]): PluginReportFailureResult => markPluginStartup(pluginIds),
  );
  ipcRegistry.registerHandler(
    'plugins:startup:clear',
    (): PluginReportFailureResult => clearPluginStartup(),
  );
  ipcRegistry.registerHandler(
    'plugins:active-session:set',
    (_event, pluginIds: string[]): PluginReportFailureResult => setPluginActiveSession(pluginIds),
  );
  ipcRegistry.registerHandler(
    'plugins:failure:report',
    (
      _event,
      failure: Omit<PluginFailureRecord, 'createdAt'> & {
        createdAt?: number;
        safeMode?: boolean;
      },
    ): PluginReportFailureResult => reportPluginFailure(failure),
  );
  ipcRegistry.registerHandler(
    'plugins:failure:clear',
    (_event, pluginId?: string): PluginReportFailureResult => clearPluginFailureRecord(pluginId),
  );
  ipcRegistry.registerHandler(
    'plugins:read-asset',
    (_event, pluginId: string, asset: 'main' | 'style'): PluginAssetSourceResult =>
      readPluginTextAsset(pluginId, asset),
  );
  ipcRegistry.registerHandler(
    'plugins:window:read-asset',
    (
      _event,
      pluginId: string,
      windowId: string,
      asset: 'main' | 'style',
    ): PluginAssetSourceResult => readPluginWindowTextAsset(pluginId, windowId, asset),
  );
  ipcRegistry.registerHandler('plugins:data:get', (_event, pluginId: string, key: string) =>
    getPluginData(pluginId, key),
  );
  ipcRegistry.registerHandler(
    'plugins:data:set',
    (_event, pluginId: string, key: string, value: unknown) => {
      const result = setPluginData(pluginId, key, value);
      if (result.ok && isPluginAppIconStorageKey(key)) refreshPluginAppIcons();
      return result;
    },
  );
  ipcRegistry.registerHandler('plugins:data:delete', (_event, pluginId: string, key: string) => {
    const result = deletePluginData(pluginId, key);
    if (result.ok && isPluginAppIconStorageKey(key)) refreshPluginAppIcons();
    return result;
  });
  ipcRegistry.registerHandler(
    'plugins:icons:refresh',
    (): PluginAppIconRefreshResult => refreshPluginAppIcons(),
  );
  ipcRegistry.registerHandler(
    'plugins:icons:restore-default-desktop',
    (): PluginRestoreIconResult => restoreDefaultDesktopIcon(),
  );
  ipcRegistry.registerHandler(
    'plugins:icons:restore-default-taskbar',
    (): PluginRestoreIconResult => restoreDefaultTaskbarIcon(),
  );
  ipcRegistry.registerHandler(
    'plugins:icons:set-runtime-window-icon',
    (_event, iconPath: string): PluginRestoreIconResult =>
      setRuntimeWindowIcon(context.getMainWindow(), iconPath),
  );
  ipcRegistry.registerHandler(
    'plugins:icons:restore-default-window-icon',
    (): PluginRestoreIconResult => restoreDefaultWindowIcon(context.getMainWindow()),
  );
};
