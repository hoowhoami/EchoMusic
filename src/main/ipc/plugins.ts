import { ipcRegistry } from './registry';
import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron';
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
  PluginNetworkRequestBody,
  PluginNetworkRequestOptions,
  PluginNetworkResponse,
  PluginOpenDialogOptions,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginReadAudioMetadataResult,
  PluginReadFileBytesOptions,
  PluginReadFileBytesResult,
  PluginReadTextFileOptions,
  PluginReadTextFileResult,
  PluginSetEnabledResult,
  PluginSqliteCloseResult,
  PluginSqliteDeleteResult,
  PluginSqliteExecResult,
  PluginSqliteListResult,
  PluginSqliteOpenOptions,
  PluginSqliteOpenResult,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteQueryResult,
  PluginSqliteRunResult,
  PluginSqliteStatement,
  PluginReportFailureResult,
  PluginSetSafeModeResult,
  PluginUninstallResult,
  PluginWebServerCloseResult,
  PluginWebServerListenOptions,
  PluginWebServerListenResult,
  PluginWebServerResponsePayload,
  PluginWebServerStatusResult,
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
  getPluginWebServerStatusForPlugin,
  installPluginsFromLocal,
  addPluginMarketplaceSource,
  installPluginFromMarketplace,
  listPluginFiles,
  listPluginImageFiles,
  listPluginMarketplace,
  listPluginMarketplaceSources,
  listPluginSqliteDatabasesForPlugin,
  listPlugins,
  launchPluginProcess,
  markPluginStartup,
  normalizePluginId,
  openPluginSqliteDatabaseForPlugin,
  openPluginDirectory,
  patchPluginMarketplaceSource,
  readPluginAudioMetadata,
  readPluginFileBytes,
  readPluginTextAsset,
  readPluginTextFile,
  readPluginWindowTextAsset,
  removePluginMarketplaceSource,
  reportPluginFailure,
  requestPluginNetworkForPlugin,
  respondPluginWebServerRequestForPlugin,
  setPluginData,
  setPluginActiveSession,
  setPluginEnabled,
  setPluginSafeMode,
  terminatePluginProcess,
  transactionPluginSqliteForPlugin,
  uninstallPlugin,
  closePluginWebServerForPlugin,
  closePluginSqliteDatabaseForPlugin,
  deletePluginSqliteDatabaseForPlugin,
  execPluginSqliteForPlugin,
  getPluginSqliteForPlugin,
  listenPluginWebServerForPlugin,
  runPluginSqliteForPlugin,
  writePluginFile,
  allPluginSqliteForPlugin,
} from '../plugins';
import { closePluginWindows } from '../plugins/windows';
import {
  applyDesktopAppIcon,
  applyTaskbarShortcutIcon,
  applyWindowAppIcon,
  getAppIconRefreshResult,
  hasAppIconConfigChanged,
  isPluginAppIconStorageKey,
  markAppIconsApplied,
  refreshAppIconConfig,
  restoreDefaultDesktopIcon,
  restoreDefaultTaskbarIcon,
  setRuntimeWindowIcon,
  restoreDefaultWindowIcon,
} from '../appIcons';
import { refreshTray } from '../tray';
import log from '../logger';
import type { IpcContext } from './types';

interface ActivePluginNetworkRequest {
  ownerId: number;
  pluginId: string;
  controller: AbortController;
}

const activePluginNetworkRequests = new Map<string, ActivePluginNetworkRequest>();
const activePluginNetworkRequestCounts = new Map<string, number>();
const trackedPluginNetworkOwners = new WeakSet<WebContents>();
const MAX_CONCURRENT_PLUGIN_NETWORK_REQUESTS = 64;

const getPluginNetworkRequestKey = (ownerId: number, pluginId: string, requestId: string) =>
  JSON.stringify([ownerId, pluginId, requestId]);

const releasePluginNetworkRequest = (key: string, expectedRequest: ActivePluginNetworkRequest) => {
  if (activePluginNetworkRequests.get(key) !== expectedRequest) return false;
  activePluginNetworkRequests.delete(key);
  const activeRequestCount = activePluginNetworkRequestCounts.get(expectedRequest.pluginId) ?? 0;
  if (activeRequestCount <= 1) {
    activePluginNetworkRequestCounts.delete(expectedRequest.pluginId);
  } else {
    activePluginNetworkRequestCounts.set(expectedRequest.pluginId, activeRequestCount - 1);
  }
  return true;
};

const trackPluginNetworkOwner = (webContents: WebContents) => {
  if (trackedPluginNetworkOwners.has(webContents)) return;
  trackedPluginNetworkOwners.add(webContents);
  const ownerId = webContents.id;
  webContents.once('destroyed', () => {
    for (const [key, request] of activePluginNetworkRequests) {
      if (request.ownerId !== ownerId) continue;
      request.controller.abort();
      releasePluginNetworkRequest(key, request);
    }
  });
};

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
  const refreshPluginAppIcons = (options?: { force?: boolean }): PluginAppIconRefreshResult => {
    refreshAppIconConfig();
    // 按需：若解析出的图标配置与上次已应用的一致，则跳过昂贵的应用步骤
    // （applyWindowAppIcon / refreshTray / applyDesktopAppIcon / applyTaskbarShortcutIcon）。
    // force 用于「显式图标操作」（手动刷新、写图标文件、改图标存储键）——此时即便路径未变，
    // 图标内容也可能已变，必须重新应用。
    if (!options?.force && !hasAppIconConfigChanged()) {
      return getAppIconRefreshResult();
    }
    applyWindowAppIcon(context.getMainWindow());
    refreshTray();
    applyDesktopAppIcon();
    const result = applyTaskbarShortcutIcon();
    markAppIconsApplied();
    return result;
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
    ): Promise<PluginListImageFilesResult> => listPluginImageFiles(directoryPath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:list-files',
    (
      _event,
      pluginId: string,
      directoryPath: string,
      options?: PluginListFilesOptions,
    ): Promise<PluginListFilesResult> => listPluginFiles(pluginId, directoryPath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:get-file-url',
    (_event, filePath: string): Promise<PluginFileUrlResult> => getPluginFileUrl(filePath),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:read-text-file',
    (
      _event,
      pluginId: string,
      filePath: string,
      options?: PluginReadTextFileOptions,
    ): Promise<PluginReadTextFileResult> => readPluginTextFile(pluginId, filePath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:read-file-bytes',
    (
      _event,
      pluginId: string,
      filePath: string,
      options?: PluginReadFileBytesOptions,
    ): Promise<PluginReadFileBytesResult> => readPluginFileBytes(pluginId, filePath, options),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:read-audio-metadata',
    (_event, pluginId: string, filePath: string): Promise<PluginReadAudioMetadataResult> =>
      readPluginAudioMetadata(pluginId, filePath),
  );
  ipcRegistry.registerHandler(
    'plugins:fs:write-file',
    async (
      _event,
      pluginId: string,
      filePath: string,
      data: PluginWriteFileData,
      options?: PluginWriteFileOptions,
    ): Promise<PluginWriteFileResult> => {
      const result = await writePluginFile(pluginId, filePath, data, options);
      if (result.ok) refreshPluginAppIcons({ force: true });
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:fs:delete-file',
    async (_event, pluginId: string, filePath: string): Promise<PluginDeleteFileResult> => {
      const result = await deletePluginFile(pluginId, filePath);
      if (result.ok) refreshPluginAppIcons({ force: true });
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
    'plugins:net:request',
    async (
      event,
      pluginId: string,
      requestId: string,
      options: Omit<PluginNetworkRequestOptions, 'body'>,
      body?: PluginNetworkRequestBody,
    ): Promise<PluginNetworkResponse> => {
      const normalizedRequestId = String(requestId || '').trim();
      if (!normalizedRequestId || normalizedRequestId.length > 256) {
        throw new Error('网络请求 ID 无效');
      }

      const normalizedPluginId = normalizePluginId(pluginId);
      const ownerId = event.sender.id;
      const key = getPluginNetworkRequestKey(ownerId, normalizedPluginId, normalizedRequestId);
      if (activePluginNetworkRequests.has(key)) throw new Error('网络请求 ID 重复');
      const activeRequestCount = activePluginNetworkRequestCounts.get(normalizedPluginId) ?? 0;
      if (activeRequestCount >= MAX_CONCURRENT_PLUGIN_NETWORK_REQUESTS) {
        throw new Error(
          `插件原生网络并发请求不能超过 ${MAX_CONCURRENT_PLUGIN_NETWORK_REQUESTS} 个`,
        );
      }

      const controller = new AbortController();
      const activeRequest = { ownerId, pluginId: normalizedPluginId, controller };
      activePluginNetworkRequests.set(key, activeRequest);
      activePluginNetworkRequestCounts.set(normalizedPluginId, activeRequestCount + 1);
      trackPluginNetworkOwner(event.sender);
      try {
        return await requestPluginNetworkForPlugin(
          normalizedPluginId,
          { ...options, body },
          controller.signal,
        );
      } finally {
        releasePluginNetworkRequest(key, activeRequest);
      }
    },
  );
  ipcRegistry.registerHandler(
    'plugins:net:cancel',
    (event, pluginId: string, requestId: string): boolean => {
      const key = getPluginNetworkRequestKey(
        event.sender.id,
        normalizePluginId(pluginId),
        String(requestId || '').trim(),
      );
      const request = activePluginNetworkRequests.get(key);
      if (!request) return false;
      request.controller.abort();
      releasePluginNetworkRequest(key, request);
      return true;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:web-server:listen',
    (
      event,
      pluginId: string,
      options?: PluginWebServerListenOptions,
    ): Promise<PluginWebServerListenResult> =>
      listenPluginWebServerForPlugin(pluginId, options, event.sender),
  );
  ipcRegistry.registerHandler(
    'plugins:web-server:status',
    (_event, pluginId: string): PluginWebServerStatusResult =>
      getPluginWebServerStatusForPlugin(pluginId),
  );
  ipcRegistry.registerHandler(
    'plugins:web-server:respond',
    (
      event,
      pluginId: string,
      payload: PluginWebServerResponsePayload,
    ): { ok: boolean; error?: string } =>
      respondPluginWebServerRequestForPlugin(pluginId, payload, event.sender),
  );
  ipcRegistry.registerHandler(
    'plugins:web-server:close',
    (event, pluginId: string): Promise<PluginWebServerCloseResult> =>
      closePluginWebServerForPlugin(pluginId, event.sender),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:open',
    (_event, pluginId: string, options?: PluginSqliteOpenOptions): PluginSqliteOpenResult =>
      openPluginSqliteDatabaseForPlugin(pluginId, options),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:exec',
    (_event, pluginId: string, databaseId: string, sql: string): PluginSqliteExecResult =>
      execPluginSqliteForPlugin(pluginId, databaseId, sql),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:run',
    (
      _event,
      pluginId: string,
      databaseId: string,
      sql: string,
      params?: PluginSqliteParams,
    ): PluginSqliteRunResult => runPluginSqliteForPlugin(pluginId, databaseId, sql, params),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:all',
    (
      _event,
      pluginId: string,
      databaseId: string,
      sql: string,
      params?: PluginSqliteParams,
      options?: PluginSqliteQueryOptions,
    ): PluginSqliteQueryResult =>
      allPluginSqliteForPlugin(pluginId, databaseId, sql, params, options),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:get',
    (
      _event,
      pluginId: string,
      databaseId: string,
      sql: string,
      params?: PluginSqliteParams,
    ): PluginSqliteQueryResult => getPluginSqliteForPlugin(pluginId, databaseId, sql, params),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:transaction',
    (
      _event,
      pluginId: string,
      databaseId: string,
      statements: PluginSqliteStatement[],
    ): PluginSqliteExecResult => transactionPluginSqliteForPlugin(pluginId, databaseId, statements),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:close',
    (_event, pluginId: string, databaseId: string): PluginSqliteCloseResult =>
      closePluginSqliteDatabaseForPlugin(pluginId, databaseId),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:list',
    (_event, pluginId: string): PluginSqliteListResult =>
      listPluginSqliteDatabasesForPlugin(pluginId),
  );
  ipcRegistry.registerHandler(
    'plugins:sqlite:delete',
    (_event, pluginId: string, name?: string): PluginSqliteDeleteResult =>
      deletePluginSqliteDatabaseForPlugin(pluginId, name),
  );
  ipcRegistry.registerHandler(
    'plugins:set-enabled',
    async (_event, pluginId: string, enabled: boolean): Promise<PluginSetEnabledResult> => {
      const result = await setPluginEnabled(pluginId, enabled);
      if (result.ok) {
        if (!enabled) closePluginWindows(pluginId);
        // 不阻塞开关：图标刷新放到下一轮事件循环，且仅在图标配置确有变化时才应用，
        // 普通插件（不提供 app 图标）开关因此瞬间完成。
        setImmediate(() => {
          try {
            refreshPluginAppIcons();
          } catch (error) {
            log.warn('[Plugin] Refresh app icons after set-enabled failed', { pluginId, error });
          }
        });
      }
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:set-safe-mode',
    async (_event, enabled: boolean): Promise<PluginSetSafeModeResult> => {
      const result = await setPluginSafeMode(enabled);
      if (result.ok && enabled) closePluginWindows();
      return result;
    },
  );
  ipcRegistry.registerHandler(
    'plugins:uninstall',
    async (_event, pluginId: string): Promise<PluginUninstallResult> => {
      closePluginWindows(pluginId);
      const result = await uninstallPlugin(pluginId);
      if (result.ok) refreshPluginAppIcons({ force: true });
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
      if (result.ok && isPluginAppIconStorageKey(key)) refreshPluginAppIcons({ force: true });
      return result;
    },
  );
  ipcRegistry.registerHandler('plugins:data:delete', (_event, pluginId: string, key: string) => {
    const result = deletePluginData(pluginId, key);
    if (result.ok && isPluginAppIconStorageKey(key)) refreshPluginAppIcons({ force: true });
    return result;
  });
  ipcRegistry.registerHandler(
    'plugins:icons:refresh',
    (): PluginAppIconRefreshResult => refreshPluginAppIcons({ force: true }),
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
