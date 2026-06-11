import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import type {
  PluginAssetSourceResult,
  PluginDialogResult,
  PluginFileUrlResult,
  PluginFailureRecord,
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
  PluginSetEnabledResult,
  PluginReportFailureResult,
  PluginSetSafeModeResult,
  PluginUninstallResult,
} from '../../shared/plugins';
import {
  clearPluginFailureRecord,
  clearPluginStartup,
  deletePluginData,
  getPluginData,
  getPluginDirectory,
  getPluginFileUrl,
  installPluginsFromLocal,
  addPluginMarketplaceSource,
  installPluginFromMarketplace,
  listPluginImageFiles,
  listPluginMarketplace,
  listPluginMarketplaceSources,
  listPlugins,
  launchPluginProcess,
  markPluginStartup,
  openPluginDirectory,
  patchPluginMarketplaceSource,
  readPluginTextAsset,
  readPluginWindowTextAsset,
  removePluginMarketplaceSource,
  reportPluginFailure,
  setPluginData,
  setPluginActiveSession,
  setPluginEnabled,
  setPluginSafeMode,
  terminatePluginProcess,
  uninstallPlugin,
} from '../plugins';
import { closePluginWindows } from '../pluginWindows';
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
  ipcMain.handle('plugins:list', (): PluginListResult => listPlugins());
  ipcMain.handle('plugins:get-directory', (): string => getPluginDirectory());
  ipcMain.handle('plugins:open-directory', (): string => openPluginDirectory());
  ipcMain.handle(
    'plugins:marketplace:sources:list',
    (): PluginMarketplaceSourceListResult => ({
      sources: listPluginMarketplaceSources(),
    }),
  );
  ipcMain.handle(
    'plugins:marketplace:sources:add',
    (
      _event,
      input: PluginMarketplaceSourceInput,
      options?: PluginMarketplaceRequestOptions,
    ): Promise<PluginMarketplaceSourceMutationResult> => addPluginMarketplaceSource(input, options),
  );
  ipcMain.handle(
    'plugins:marketplace:sources:patch',
    (
      _event,
      sourceId: string,
      patch: PluginMarketplaceSourcePatch,
    ): PluginMarketplaceSourceMutationResult => patchPluginMarketplaceSource(sourceId, patch),
  );
  ipcMain.handle(
    'plugins:marketplace:sources:remove',
    (_event, sourceId: string): PluginMarketplaceRemoveSourceResult =>
      removePluginMarketplaceSource(sourceId),
  );
  ipcMain.handle(
    'plugins:marketplace:list',
    (_event, options?: PluginMarketplaceRequestOptions): Promise<PluginMarketplaceListResult> =>
      listPluginMarketplace(options),
  );
  ipcMain.handle(
    'plugins:marketplace:install',
    (
      _event,
      sourceId: string,
      pluginId: string,
      options?: PluginMarketplaceInstallOptions,
    ): Promise<PluginMarketplaceInstallResult> =>
      installPluginFromMarketplace(sourceId, pluginId, options),
  );
  ipcMain.handle(
    'plugins:install-local',
    (
      _event,
      paths: string[],
      options?: PluginLocalInstallOptions,
    ): Promise<PluginLocalInstallResult> => installPluginsFromLocal(paths, options),
  );
  ipcMain.handle('plugins:runtime-reload', (event): void => {
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
    'plugins:fs:list-image-files',
    (
      _event,
      directoryPath: string,
      options?: PluginListImageFilesOptions,
    ): PluginListImageFilesResult => listPluginImageFiles(directoryPath, options),
  );
  ipcMain.handle(
    'plugins:fs:get-file-url',
    (_event, filePath: string): PluginFileUrlResult => getPluginFileUrl(filePath),
  );
  ipcMain.handle(
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
  ipcMain.handle(
    'plugins:process:terminate',
    (_event, pluginId: string, pid: number): PluginProcessTerminateResult =>
      terminatePluginProcess(pluginId, pid),
  );
  ipcMain.handle(
    'plugins:set-enabled',
    (_event, pluginId: string, enabled: boolean): PluginSetEnabledResult => {
      const result = setPluginEnabled(pluginId, enabled);
      if (result.ok && !enabled) closePluginWindows(pluginId);
      return result;
    },
  );
  ipcMain.handle('plugins:set-safe-mode', (_event, enabled: boolean): PluginSetSafeModeResult => {
    const result = setPluginSafeMode(enabled);
    if (result.ok && enabled) closePluginWindows();
    return result;
  });
  ipcMain.handle('plugins:uninstall', (_event, pluginId: string): PluginUninstallResult => {
    closePluginWindows(pluginId);
    return uninstallPlugin(pluginId);
  });
  ipcMain.handle(
    'plugins:startup:mark',
    (_event, pluginIds: string[]): PluginReportFailureResult => markPluginStartup(pluginIds),
  );
  ipcMain.handle('plugins:startup:clear', (): PluginReportFailureResult => clearPluginStartup());
  ipcMain.handle(
    'plugins:active-session:set',
    (_event, pluginIds: string[]): PluginReportFailureResult => setPluginActiveSession(pluginIds),
  );
  ipcMain.handle(
    'plugins:failure:report',
    (
      _event,
      failure: Omit<PluginFailureRecord, 'createdAt'> & {
        createdAt?: number;
        safeMode?: boolean;
      },
    ): PluginReportFailureResult => reportPluginFailure(failure),
  );
  ipcMain.handle(
    'plugins:failure:clear',
    (_event, pluginId?: string): PluginReportFailureResult => clearPluginFailureRecord(pluginId),
  );
  ipcMain.handle(
    'plugins:read-asset',
    (_event, pluginId: string, asset: 'main' | 'style'): PluginAssetSourceResult =>
      readPluginTextAsset(pluginId, asset),
  );
  ipcMain.handle(
    'plugins:window:read-asset',
    (
      _event,
      pluginId: string,
      windowId: string,
      asset: 'main' | 'style',
    ): PluginAssetSourceResult => readPluginWindowTextAsset(pluginId, windowId, asset),
  );
  ipcMain.handle('plugins:data:get', (_event, pluginId: string, key: string) =>
    getPluginData(pluginId, key),
  );
  ipcMain.handle('plugins:data:set', (_event, pluginId: string, key: string, value: unknown) =>
    setPluginData(pluginId, key, value),
  );
  ipcMain.handle('plugins:data:delete', (_event, pluginId: string, key: string) =>
    deletePluginData(pluginId, key),
  );
};

export const unregisterPluginHandlers = () => {
  ipcMain.removeHandler('plugins:list');
  ipcMain.removeHandler('plugins:get-directory');
  ipcMain.removeHandler('plugins:open-directory');
  ipcMain.removeHandler('plugins:marketplace:sources:list');
  ipcMain.removeHandler('plugins:marketplace:sources:add');
  ipcMain.removeHandler('plugins:marketplace:sources:patch');
  ipcMain.removeHandler('plugins:marketplace:sources:remove');
  ipcMain.removeHandler('plugins:marketplace:list');
  ipcMain.removeHandler('plugins:marketplace:install');
  ipcMain.removeHandler('plugins:install-local');
  ipcMain.removeHandler('plugins:runtime-reload');
  ipcMain.removeHandler('plugins:dialog:select-directory');
  ipcMain.removeHandler('plugins:dialog:select-files');
  ipcMain.removeHandler('plugins:fs:list-image-files');
  ipcMain.removeHandler('plugins:fs:get-file-url');
  ipcMain.removeHandler('plugins:process:launch');
  ipcMain.removeHandler('plugins:process:terminate');
  ipcMain.removeHandler('plugins:set-enabled');
  ipcMain.removeHandler('plugins:set-safe-mode');
  ipcMain.removeHandler('plugins:uninstall');
  ipcMain.removeHandler('plugins:startup:mark');
  ipcMain.removeHandler('plugins:startup:clear');
  ipcMain.removeHandler('plugins:active-session:set');
  ipcMain.removeHandler('plugins:failure:report');
  ipcMain.removeHandler('plugins:failure:clear');
  ipcMain.removeHandler('plugins:read-asset');
  ipcMain.removeHandler('plugins:window:read-asset');
  ipcMain.removeHandler('plugins:data:get');
  ipcMain.removeHandler('plugins:data:set');
  ipcMain.removeHandler('plugins:data:delete');
};
