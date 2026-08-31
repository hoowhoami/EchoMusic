import { shell, type WebContents } from 'electron';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { extname, isAbsolute, join, resolve } from 'path';
import { coerce as semverCoerce, gt as semverGt, valid as semverValid } from 'semver';
import type {
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginAssetSourceResult,
  PluginFailureRecord,
  PluginListResult,
  PluginMarketplaceInstallOptions,
  PluginMarketplaceInstallResult,
  PluginMarketplaceListResult,
  PluginMarketplacePlugin,
  PluginMarketplaceRemoveSourceResult,
  PluginMarketplaceRequestOptions,
  PluginMarketplaceSource,
  PluginMarketplaceSourceInput,
  PluginMarketplaceSourceMutationResult,
  PluginMarketplaceSourcePatch,
  PluginMarketplaceStats,
  PluginNetworkRequestOptions,
  PluginNetworkResponse,
  PluginReportFailureResult,
  PluginSetSafeModeResult,
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
  PluginUninstallResult,
  PluginWebServerCloseResult,
  PluginWebServerListenOptions,
  PluginWebServerListenResult,
  PluginWebServerResponsePayload,
  PluginWebServerStatusResult,
} from '../../shared/plugins';
import { isBlockedObjectKey } from '../../shared/objectSafety';
import { getKvStorage } from '../storage/kv';
import log from '../logger';
import {
  DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID,
  DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL,
  DEFAULT_PLUGIN_MARKETPLACE_STATS_API_URL,
  MAX_PLUGIN_PACKAGE_SIZE_BYTES,
  PLUGIN_ACTIVE_SESSION_KEY,
  PLUGIN_INSTALL_TIMES_KEY,
  PLUGIN_LAST_FAILURE_KEY,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MARKETPLACE_CACHE_KEY,
  PLUGIN_MARKETPLACE_CACHE_VERSION,
  PLUGIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS,
  PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS,
  PLUGIN_MARKETPLACE_INDEX_FILE,
  PLUGIN_MARKETPLACE_SOURCES_KEY,
  PLUGIN_SAFE_MODE_KEY,
  PLUGIN_STARTUP_SESSION_KEY,
  PLUGIN_STATE_KEY,
  comparePluginText,
  normalizePluginId,
} from './common';
import {
  appendUrlCacheKey,
  getEchoMusicCompatibility,
  getManifestIconSource,
  isSupportedPluginImage,
  toDescriptor,
  validateManifest,
} from './descriptor';
import { ensurePluginRoot, isPathInside } from './path';
import { createPluginFileApi } from './fs';
import { createPluginProcessApi } from './process';
import { createPluginInstaller } from './installer';
import { requestPluginNetwork } from './network';
import {
  closePluginWebServer,
  closePluginWebServers,
  getPluginWebServerStatus,
  listenPluginWebServer,
  respondPluginWebServerRequest,
} from './webServer';
import {
  allPluginSqlite,
  closePluginSqliteDatabase,
  closePluginSqliteDatabases,
  deletePluginSqliteDatabase,
  deletePluginSqliteDatabases,
  execPluginSqlite,
  getPluginSqlite,
  listPluginSqliteDatabases,
  openPluginSqliteDatabase,
  runPluginSqlite,
  transactionPluginSqlite,
} from './sqlite';

export { normalizePluginId } from './common';

type PluginEnabledState = Record<string, boolean>;
type PluginRuntimeSession = {
  pluginIds: string[];
  startedAt: number;
  sessionId?: string;
};
type PluginInstallTimes = Record<string, number>;
type GithubRepository = {
  owner: string;
  repo: string;
};
type PluginMarketplaceIndex = {
  name?: string;
  homepage?: string;
  plugins?: PluginMarketplaceIndexEntry[];
};
type PluginMarketplaceIndexEntry = {
  id?: string;
  tags?: unknown;
  repo?: string;
  homepage?: string;
  path?: string;
  packagePath?: string;
  downloadUrl?: unknown;
  checksum?: unknown;
};
type PluginMarketplaceCatalogPlugin = Omit<
  PluginMarketplacePlugin,
  'installed' | 'installedVersion' | 'updateAvailable' | 'compatibility' | 'stats'
>;
type PluginMarketplaceCache = {
  schemaVersion?: number;
  plugins: PluginMarketplaceCatalogPlugin[];
  fetchedAt: number;
};
type PluginMarketplaceIndexPluginsResult = {
  plugins: PluginMarketplaceCatalogPlugin[];
  failedCount: number;
  recoveredCount: number;
};

const compareInstalledPlugins = (
  left: EchoPluginDescriptor,
  right: EchoPluginDescriptor,
  installTimes: PluginInstallTimes,
) => {
  const timeCompare = (installTimes[right.id] || 0) - (installTimes[left.id] || 0);
  if (timeCompare !== 0) return timeCompare;
  return (
    comparePluginText(left.name, right.name) ||
    comparePluginText(left.id, right.id) ||
    comparePluginText(left.directoryName, right.directoryName)
  );
};

const pluginProcessSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const getEnabledState = (): PluginEnabledState =>
  getKvStorage().get<PluginEnabledState>(PLUGIN_STATE_KEY) ?? {};

const setEnabledState = (state: PluginEnabledState) => {
  getKvStorage().set(PLUGIN_STATE_KEY, state);
};

const normalizePluginTimestamp = (value: unknown) => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
};

const getPluginInstallTimes = (): PluginInstallTimes => {
  const saved = getKvStorage().get<PluginInstallTimes>(PLUGIN_INSTALL_TIMES_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};

  return Object.entries(saved).reduce<PluginInstallTimes>((times, [pluginId, value]) => {
    const normalizedPluginId = normalizePluginId(pluginId);
    const timestamp = normalizePluginTimestamp(value);
    if (normalizedPluginId && timestamp) times[normalizedPluginId] = timestamp;
    return times;
  }, {});
};

const setPluginInstallTimes = (times: PluginInstallTimes) => {
  getKvStorage().set(PLUGIN_INSTALL_TIMES_KEY, times);
};

const getPluginDirectoryInstallTime = (directory: string) => {
  try {
    const stats = statSync(directory);
    return (
      normalizePluginTimestamp(stats.birthtimeMs) ||
      normalizePluginTimestamp(stats.ctimeMs) ||
      normalizePluginTimestamp(stats.mtimeMs) ||
      Date.now()
    );
  } catch {
    return Date.now();
  }
};

const setPluginInstalledAt = (pluginId: string, installedAt: number) => {
  const normalizedPluginId = normalizePluginId(pluginId);
  const timestamp = normalizePluginTimestamp(installedAt);
  if (!normalizedPluginId || !timestamp) return;
  const installTimes = getPluginInstallTimes();
  installTimes[normalizedPluginId] = timestamp;
  setPluginInstallTimes(installTimes);
};

const removePluginInstalledAt = (pluginId: string) => {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) return;
  const installTimes = getPluginInstallTimes();
  if (!(normalizedPluginId in installTimes)) return;
  delete installTimes[normalizedPluginId];
  setPluginInstallTimes(installTimes);
};

const getPluginStorageKey = (pluginId: string, key: string) =>
  `plugin:${normalizePluginId(pluginId)}:${String(key)}`;

const getPluginStorageIndexKey = (pluginId: string) =>
  `plugins:storage-index:${normalizePluginId(pluginId)}`;

const getPluginStorageKeys = (pluginId: string) => {
  const saved = getKvStorage().get<unknown>(getPluginStorageIndexKey(pluginId));
  if (!Array.isArray(saved)) return [];
  return Array.from(new Set(saved.map((key) => String(key ?? '')).filter((key) => key.length > 0)));
};

const trackPluginStorageKey = (pluginId: string, key: string) => {
  const normalizedKey = String(key);
  const indexKey = getPluginStorageIndexKey(pluginId);
  const keys = Array.from(new Set([...getPluginStorageKeys(pluginId), normalizedKey]));
  getKvStorage().set(indexKey, keys);
};

const untrackPluginStorageKey = (pluginId: string, key: string) => {
  const indexKey = getPluginStorageIndexKey(pluginId);
  const keys = getPluginStorageKeys(pluginId).filter((item) => item !== String(key));
  if (keys.length > 0) {
    getKvStorage().set(indexKey, keys);
  } else {
    getKvStorage().delete(indexKey);
  }
};

const clearPluginStorage = (pluginId: string) => {
  const indexKey = getPluginStorageIndexKey(pluginId);
  for (const key of getPluginStorageKeys(pluginId)) {
    getKvStorage().delete(getPluginStorageKey(pluginId, key));
  }
  getKvStorage().delete(indexKey);
};

export const exportPluginStorage = (pluginId: string): Record<string, unknown> =>
  Object.fromEntries(
    getPluginStorageKeys(pluginId).map((key) => [
      key,
      getKvStorage().get(getPluginStorageKey(pluginId, key)),
    ]),
  );

export const replacePluginStorage = (pluginId: string, data: unknown) => {
  clearPluginStorage(pluginId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const [key, value] of Object.entries(data)) {
    if (!key || key.length > 256 || isBlockedObjectKey(key)) {
      continue;
    }
    setPluginData(pluginId, key, value);
  }
};

export const exportPluginEnabledPreference = (pluginId: string): boolean | undefined => {
  const id = normalizePluginId(pluginId);
  const state = getEnabledState();
  return id && Object.prototype.hasOwnProperty.call(state, id) ? Boolean(state[id]) : undefined;
};

export const replacePluginEnabledPreference = (pluginId: string, enabled: boolean | undefined) => {
  const id = normalizePluginId(pluginId);
  if (!id) return;
  const state = getEnabledState();
  if (enabled === undefined) delete state[id];
  else state[id] = enabled;
  setEnabledState(state);
};

export const getPluginSafeMode = () => Boolean(getKvStorage().get<boolean>(PLUGIN_SAFE_MODE_KEY));

const normalizePluginIds = (pluginIds: unknown) => {
  if (!Array.isArray(pluginIds)) return [];
  return Array.from(new Set(pluginIds.map(normalizePluginId).filter(Boolean)));
};

const NON_FAILURE_RENDERER_GONE_REASONS = new Set(['clean-exit', 'killed']);

export const isPluginRendererGoneFailureReason = (reason: string) =>
  !NON_FAILURE_RENDERER_GONE_REASONS.has(reason);

const getRuntimeSession = (key: string): PluginRuntimeSession | null => {
  const session = getKvStorage().get<PluginRuntimeSession>(key);
  if (!session || !Array.isArray(session.pluginIds) || session.pluginIds.length === 0) return null;
  return {
    pluginIds: normalizePluginIds(session.pluginIds),
    startedAt: Number(session.startedAt) || Date.now(),
    sessionId: typeof session.sessionId === 'string' ? session.sessionId : undefined,
  };
};

const setRuntimeSession = (key: string, pluginIds: string[]) => {
  const normalizedIds = normalizePluginIds(pluginIds);
  if (normalizedIds.length === 0) {
    getKvStorage().delete(key);
    return;
  }
  getKvStorage().set(key, {
    pluginIds: normalizedIds,
    startedAt: Date.now(),
    sessionId: pluginProcessSessionId,
  });
};

const setLastFailure = (failure: PluginFailureRecord) => {
  getKvStorage().set(PLUGIN_LAST_FAILURE_KEY, failure);
};

export const getPluginLastFailure = () =>
  getKvStorage().get<PluginFailureRecord>(PLUGIN_LAST_FAILURE_KEY);

const removePluginIdFromFailure = (
  failure: PluginFailureRecord,
  pluginId: string,
): PluginFailureRecord | null => {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) return failure;

  const failurePluginIds = Array.from(
    new Set(
      [failure.pluginId, ...(failure.pluginIds ?? [])].map(normalizePluginId).filter(Boolean),
    ),
  );
  if (!failurePluginIds.includes(normalizedPluginId)) return failure;

  const remainingPluginIds = failurePluginIds.filter((id) => id !== normalizedPluginId);
  if (remainingPluginIds.length === 0) return null;

  return {
    pluginIds: remainingPluginIds,
    reason: failure.reason,
    message: failure.message,
    createdAt: failure.createdAt,
  };
};

const recoverPreviousPluginCrash = () => {
  if (getPluginSafeMode()) return;

  const startupSession = getRuntimeSession(PLUGIN_STARTUP_SESSION_KEY);
  if (startupSession && startupSession.sessionId !== pluginProcessSessionId) {
    setLastFailure({
      pluginIds: startupSession.pluginIds,
      reason: 'render-process-gone',
      message: '上次启动时插件加载未正常完成，已自动进入安全模式。',
      createdAt: Date.now(),
    });
    setPluginSafeMode(true);
    getKvStorage().delete(PLUGIN_STARTUP_SESSION_KEY);
    getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
    return;
  }

  const activeSession = getRuntimeSession(PLUGIN_ACTIVE_SESSION_KEY);
  if (activeSession && activeSession.sessionId !== pluginProcessSessionId) {
    log.info('[Plugin] Clearing stale active plugin session from previous app run', {
      pluginIds: activeSession.pluginIds,
      startedAt: activeSession.startedAt,
    });
    getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
  }
};

export const setPluginSafeMode = async (enabled: boolean): Promise<PluginSetSafeModeResult> => {
  try {
    getKvStorage().set(PLUGIN_SAFE_MODE_KEY, Boolean(enabled));
    if (enabled) {
      getKvStorage().delete(PLUGIN_STARTUP_SESSION_KEY);
      getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
      await closePluginWebServers();
      closePluginSqliteDatabases();
      await terminatePluginProcesses();
    }
    return { ok: true, safeMode: Boolean(enabled) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件安全模式切换失败',
    };
  }
};

export const markPluginStartup = (pluginIds: string[]): PluginReportFailureResult => {
  setRuntimeSession(PLUGIN_STARTUP_SESSION_KEY, pluginIds);
  return { ok: true };
};

export const clearPluginStartup = (): PluginReportFailureResult => {
  getKvStorage().delete(PLUGIN_STARTUP_SESSION_KEY);
  return { ok: true };
};

export const setPluginActiveSession = (pluginIds: string[]): PluginReportFailureResult => {
  setRuntimeSession(PLUGIN_ACTIVE_SESSION_KEY, pluginIds);
  return { ok: true };
};

export const clearPluginRuntimeSession = () => {
  getKvStorage().delete(PLUGIN_STARTUP_SESSION_KEY);
  getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
};

export const reportPluginFailure = (
  failure: Omit<PluginFailureRecord, 'createdAt'> & { createdAt?: number; safeMode?: boolean },
): PluginReportFailureResult => {
  const pluginId = normalizePluginId(failure.pluginId);
  const pluginIds = normalizePluginIds(failure.pluginIds);
  setLastFailure({
    ...(pluginId ? { pluginId } : {}),
    ...(pluginIds.length > 0 ? { pluginIds } : {}),
    reason: failure.reason,
    message: String(failure.message || '插件运行异常'),
    createdAt: Number(failure.createdAt) || Date.now(),
  });
  if (failure.safeMode) {
    void setPluginSafeMode(true);
  }
  return { ok: true };
};

export const clearPluginFailureRecord = (pluginId?: string): PluginReportFailureResult => {
  const failure = getPluginLastFailure();
  if (!failure) return { ok: true };

  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) {
    getKvStorage().delete(PLUGIN_LAST_FAILURE_KEY);
    return { ok: true };
  }

  const nextFailure = removePluginIdFromFailure(failure, normalizedPluginId);
  if (!nextFailure) {
    getKvStorage().delete(PLUGIN_LAST_FAILURE_KEY);
  } else if (nextFailure !== failure) {
    setLastFailure(nextFailure);
  }
  return { ok: true };
};

export const reportPluginRendererFailure = (
  reason: 'render-process-gone' | 'unresponsive',
  message: string,
) => {
  const session =
    getRuntimeSession(PLUGIN_STARTUP_SESSION_KEY) ?? getRuntimeSession(PLUGIN_ACTIVE_SESSION_KEY);
  if (!session) return false;
  reportPluginFailure({
    pluginIds: session.pluginIds,
    reason,
    message,
    safeMode: true,
  });
  clearPluginRuntimeSession();
  return true;
};

export const listPlugins = (): PluginListResult => {
  recoverPreviousPluginCrash();
  const root = ensurePluginRoot();
  const enabledState = getEnabledState();
  const installTimes = getPluginInstallTimes();
  const seenPluginIds = new Set<string>();
  let installTimesChanged = false;
  const plugins: EchoPluginDescriptor[] = [];

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const manifestPath = join(directory, PLUGIN_MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    try {
      const descriptor = toDescriptor(directory, entry.name, enabledState);
      plugins.push(descriptor);
      seenPluginIds.add(descriptor.id);
      if (!installTimes[descriptor.id]) {
        installTimes[descriptor.id] = getPluginDirectoryInstallTime(directory);
        installTimesChanged = true;
      }
    } catch (error) {
      log.warn('[Plugin] Failed to read plugin descriptor', { directory, error });
    }
  }

  for (const pluginId of Object.keys(installTimes)) {
    if (seenPluginIds.has(pluginId)) continue;
    delete installTimes[pluginId];
    installTimesChanged = true;
  }
  if (installTimesChanged) setPluginInstallTimes(installTimes);

  plugins.sort((left, right) => compareInstalledPlugins(left, right, installTimes));
  return {
    plugins,
    directory: root,
    safeMode: getPluginSafeMode(),
    lastFailure: getPluginLastFailure() ?? null,
  };
};

const findPlugin = (pluginId: string) =>
  listPlugins().plugins.find((plugin) => plugin.id === normalizePluginId(pluginId)) ?? null;

const getPluginCompatibilityError = (plugin: EchoPluginDescriptor) =>
  plugin.compatibility.compatible
    ? ''
    : plugin.compatibility.message || '插件与当前 EchoMusic 主程序版本不兼容';

export const {
  terminatePluginProcess,
  terminatePluginProcesses,
  launchPluginProcess,
  clearPluginProcessConsents,
} = createPluginProcessApi({
  findPlugin,
  getPluginCompatibilityError,
  getPluginSafeMode,
});

export const getPluginDescriptor = (pluginId: string) => findPlugin(pluginId);

export const requestPluginNetworkForPlugin = (
  pluginId: string,
  options: PluginNetworkRequestOptions,
  signal?: AbortSignal,
): Promise<PluginNetworkResponse> => {
  if (getPluginSafeMode()) return Promise.reject(new Error('插件安全模式已开启'));

  const plugin = findPlugin(pluginId);
  if (!plugin) return Promise.reject(new Error('插件不存在'));
  if (plugin.invalid) return Promise.reject(new Error(plugin.error || '插件无效'));
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return Promise.reject(new Error(compatibilityError));
  if (!plugin.enabled) return Promise.reject(new Error('插件未启用'));
  if (plugin.manifest.capabilities?.unrestrictedNetwork !== true) {
    return Promise.reject(new Error('插件未声明不受限网络能力'));
  }

  return requestPluginNetwork(options, signal);
};

const getPluginWebServerAccessError = (plugin: EchoPluginDescriptor) => {
  if (plugin.invalid) return plugin.error || '插件无效';
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return compatibilityError;
  if (!plugin.enabled) return '插件未启用';
  if (plugin.manifest.capabilities?.webServer !== true) {
    return '插件未声明 Web 服务能力';
  }
  return '';
};

const getPluginSqliteAccessError = (plugin: EchoPluginDescriptor) => {
  if (plugin.invalid) return plugin.error || '插件无效';
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return compatibilityError;
  if (!plugin.enabled) return '插件未启用';
  if (plugin.manifest.capabilities?.sqlite !== true) {
    return '插件未声明 SQLite 能力';
  }
  return '';
};

const withPluginSqliteAccess = <T>(
  pluginId: string,
  fallback: string,
  callback: (plugin: EchoPluginDescriptor) => T,
): T | { ok: false; error: string } => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };

  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };

  const accessError = getPluginSqliteAccessError(plugin);
  if (accessError) return { ok: false, error: accessError };

  try {
    return callback(plugin);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : fallback,
    };
  }
};

export const openPluginSqliteDatabaseForPlugin = (
  pluginId: string,
  options?: PluginSqliteOpenOptions,
): PluginSqliteOpenResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 数据库打开失败', (plugin) =>
    openPluginSqliteDatabase(plugin, options),
  ) as PluginSqliteOpenResult;

export const execPluginSqliteForPlugin = (
  pluginId: string,
  databaseId: string,
  sql: string,
): PluginSqliteExecResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 执行失败', (plugin) =>
    execPluginSqlite(plugin.id, databaseId, sql),
  ) as PluginSqliteExecResult;

export const runPluginSqliteForPlugin = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteRunResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 写入失败', (plugin) =>
    runPluginSqlite(plugin.id, databaseId, sql, params),
  ) as PluginSqliteRunResult;

export const allPluginSqliteForPlugin = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
  options?: PluginSqliteQueryOptions,
): PluginSqliteQueryResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 查询失败', (plugin) =>
    allPluginSqlite(plugin.id, databaseId, sql, params, options),
  ) as PluginSqliteQueryResult;

export const getPluginSqliteForPlugin = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteQueryResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 查询失败', (plugin) =>
    getPluginSqlite(plugin.id, databaseId, sql, params),
  ) as PluginSqliteQueryResult;

export const transactionPluginSqliteForPlugin = (
  pluginId: string,
  databaseId: string,
  statements: PluginSqliteStatement[],
): PluginSqliteExecResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 事务执行失败', (plugin) =>
    transactionPluginSqlite(plugin.id, databaseId, statements),
  ) as PluginSqliteExecResult;

export const closePluginSqliteDatabaseForPlugin = (
  pluginId: string,
  databaseId: string,
): PluginSqliteCloseResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 数据库关闭失败', (plugin) =>
    closePluginSqliteDatabase(plugin.id, databaseId),
  ) as PluginSqliteCloseResult;

export const listPluginSqliteDatabasesForPlugin = (pluginId: string): PluginSqliteListResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 数据库列表读取失败', (plugin) =>
    listPluginSqliteDatabases(plugin.id),
  ) as PluginSqliteListResult;

export const deletePluginSqliteDatabaseForPlugin = (
  pluginId: string,
  name?: string,
): PluginSqliteDeleteResult =>
  withPluginSqliteAccess(pluginId, '插件 SQLite 数据库删除失败', (plugin) =>
    deletePluginSqliteDatabase(plugin.id, name),
  ) as PluginSqliteDeleteResult;

export const listenPluginWebServerForPlugin = async (
  pluginId: string,
  options: PluginWebServerListenOptions | undefined,
  webContents: WebContents,
): Promise<PluginWebServerListenResult> => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };

  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };

  const accessError = getPluginWebServerAccessError(plugin);
  if (accessError) return { ok: false, error: accessError };

  try {
    return await listenPluginWebServer(plugin, options, webContents);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件 Web 服务启动失败',
    };
  }
};

export const getPluginWebServerStatusForPlugin = (pluginId: string): PluginWebServerStatusResult =>
  getPluginWebServerStatus(normalizePluginId(pluginId));

export const respondPluginWebServerRequestForPlugin = (
  pluginId: string,
  payload: PluginWebServerResponsePayload,
  webContents?: WebContents,
) => respondPluginWebServerRequest(normalizePluginId(pluginId), payload, webContents);

export const closePluginWebServerForPlugin = async (
  pluginId: string,
  webContents?: WebContents,
): Promise<PluginWebServerCloseResult> =>
  closePluginWebServer(normalizePluginId(pluginId), webContents);

const createDefaultMarketplaceSource = (): PluginMarketplaceSource => ({
  id: DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID,
  name: 'EchoMusic 官方插件源',
  url: DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL,
  enabled: true,
  official: true,
  indexUrl: `${DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL}/blob/HEAD/${PLUGIN_MARKETPLACE_INDEX_FILE}`,
  homepage: DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL,
  pluginCount: 0,
  addedAt: Date.now(),
  updatedAt: Date.now(),
  lastFetchedAt: 0,
  lastError: '',
});

const getSavedMarketplaceSources = () => {
  const saved = getKvStorage().get<PluginMarketplaceSource[]>(PLUGIN_MARKETPLACE_SOURCES_KEY);
  if (!Array.isArray(saved)) return [createDefaultMarketplaceSource()];
  const sources = saved
    .map(normalizeMarketplaceSource)
    .filter(Boolean) as PluginMarketplaceSource[];
  if (!sources.some((source) => source.id === DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID)) {
    return [createDefaultMarketplaceSource(), ...sources];
  }
  return sources;
};

const saveMarketplaceSources = (sources: PluginMarketplaceSource[]) => {
  getKvStorage().set(
    PLUGIN_MARKETPLACE_SOURCES_KEY,
    sources.map((source) => normalizeMarketplaceSource(source)).filter(Boolean),
  );
};

const getMarketplaceCache = (): PluginMarketplaceCache => {
  const cache = getKvStorage().get<PluginMarketplaceCache>(PLUGIN_MARKETPLACE_CACHE_KEY);
  if (
    !cache ||
    cache.schemaVersion !== PLUGIN_MARKETPLACE_CACHE_VERSION ||
    !Array.isArray(cache.plugins)
  ) {
    return { schemaVersion: PLUGIN_MARKETPLACE_CACHE_VERSION, plugins: [], fetchedAt: 0 };
  }
  return {
    schemaVersion: PLUGIN_MARKETPLACE_CACHE_VERSION,
    plugins: cache.plugins,
    fetchedAt: Number(cache.fetchedAt) || 0,
  };
};

const setMarketplaceCache = (cache: PluginMarketplaceCache) => {
  getKvStorage().set(PLUGIN_MARKETPLACE_CACHE_KEY, cache);
};

const parseGithubRepository = (value: unknown): GithubRepository | null => {
  const text = String(value ?? '')
    .trim()
    .replace(/\.git$/i, '');
  if (!text) return null;

  const shorthandMatch = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthandMatch) {
    return {
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
    };
  }

  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return null;
    return {
      owner,
      repo: repo.replace(/\.git$/i, ''),
    };
  } catch {
    return null;
  }
};

const toGithubRepositoryUrl = (repo: GithubRepository) =>
  `https://github.com/${repo.owner}/${repo.repo}`;

const toMarketplaceSourceId = (repo: GithubRepository) =>
  `github:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;

const normalizeGithubRepositoryUrl = (value: unknown) => {
  const repo = parseGithubRepository(value);
  if (!repo) return null;
  return {
    repo,
    id: toMarketplaceSourceId(repo),
    url: toGithubRepositoryUrl(repo),
  };
};

const toRawGithubUrl = (repo: GithubRepository, filePath: string, ref = 'HEAD') => {
  const normalizedPath = normalizeMarketplacePackagePath(filePath);
  const normalizedRef = String(ref || 'HEAD').trim() || 'HEAD';
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(normalizedRef)}/${normalizedPath}`;
};

const toGithubArchiveUrl = (repo: GithubRepository) =>
  `https://github.com/${repo.owner}/${repo.repo}/archive/HEAD.zip`;

const toGithubBlobUrl = (repo: GithubRepository, filePath: string) => {
  const normalizedPath = normalizeMarketplacePackagePath(filePath);
  return `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/${normalizedPath}`;
};

const isGithubHostedUrl = (value: string) => {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === 'github.com' ||
      hostname === 'raw.githubusercontent.com' ||
      hostname === 'codeload.github.com' ||
      hostname.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
};

const normalizeGithubProxyUrl = (githubProxyUrl?: string) =>
  String(githubProxyUrl || '')
    .trim()
    .replace(/\/+$/, '');

const toGithubProxyUrl = (url: string, githubProxyUrl: string) =>
  `${normalizeGithubProxyUrl(githubProxyUrl)}/${url}`;

const applyGithubProxyUrl = (url: string, githubProxyUrl?: string) => {
  const target = String(url || '').trim();
  const proxy = normalizeGithubProxyUrl(githubProxyUrl);
  if (!target || !proxy || !/^https?:\/\//i.test(target) || !isGithubHostedUrl(target)) {
    return target;
  }
  return toGithubProxyUrl(target, proxy);
};

const normalizeMarketplaceStatsApiUrl = (value?: string) =>
  String(
    value || process.env.ECHOMUSIC_PLUGIN_STATS_API_URL || DEFAULT_PLUGIN_MARKETPLACE_STATS_API_URL,
  )
    .trim()
    .replace(/\/+$/, '');

const getUniqueUrls = (urls: string[]) =>
  urls.filter((url, index, list) => url && list.findIndex((item) => item === url) === index);

const getMarketplaceStatsApiUrlCandidates = (path: string) => {
  const baseUrl = normalizeMarketplaceStatsApiUrl();
  if (!baseUrl) return [];
  const targetUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  return getUniqueUrls([targetUrl]);
};

const getHttpFailureMessage = async (response: Response, fallback: string) => {
  const body = await response.text().catch(() => '');
  if (!body) return `${fallback} (${response.status})`;
  try {
    const payload = JSON.parse(body) as { error?: unknown };
    const error = String(payload?.error || '').trim();
    if (error) return `${fallback} (${response.status}): ${error}`;
  } catch {
    // keep raw body below
  }
  return `${fallback} (${response.status}): ${body.slice(0, 240)}`;
};

const getEmptyMarketplaceStats = (): PluginMarketplaceStats => ({
  installCount: 0,
  updateCount: 0,
  failureCount: 0,
  score: 0,
  lastInstalledAt: '',
  lastUpdatedAt: '',
});

const normalizeMarketplaceStats = (value: unknown): PluginMarketplaceStats => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return getEmptyMarketplaceStats();
  }
  const stats = value as Partial<PluginMarketplaceStats>;
  return {
    installCount: Math.max(0, Math.floor(Number(stats.installCount) || 0)),
    updateCount: Math.max(0, Math.floor(Number(stats.updateCount) || 0)),
    failureCount: Math.max(0, Math.floor(Number(stats.failureCount) || 0)),
    score: Math.max(0, Number(stats.score) || 0),
    lastInstalledAt: String(stats.lastInstalledAt || ''),
    lastUpdatedAt: String(stats.lastUpdatedAt || ''),
  };
};

const getMarketplaceStatsKey = (sourceId: string, pluginId: string) => `${sourceId}:${pluginId}`;

const fetchMarketplacePluginStats = async (
  plugins: PluginMarketplacePlugin[],
): Promise<Map<string, PluginMarketplaceStats>> => {
  const urlCandidates = getMarketplaceStatsApiUrlCandidates('/v1/plugins/stats');
  if (urlCandidates.length === 0 || plugins.length === 0) return new Map();

  try {
    let response: Response | null = null;
    let lastError: unknown = null;
    for (const url of urlCandidates) {
      try {
        const result = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': 'EchoMusic-Plugin-Marketplace',
            },
            body: JSON.stringify({
              plugins: plugins.map((plugin) => ({
                sourceId: plugin.sourceId,
                pluginId: plugin.id,
                version: plugin.version,
                sourceUrl: plugin.sourceUrl,
                sourceName: plugin.sourceName,
                repo: plugin.repo,
                packagePath: plugin.packagePath,
                downloadUrl: plugin.downloadUrl,
                checksum: plugin.checksum,
              })),
            }),
          },
          PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS,
          '插件热度统计请求超时',
        );
        if (!result.ok) throw new Error(await getHttpFailureMessage(result, '统计请求失败'));
        response = result;
        break;
      } catch (error) {
        lastError = error;
        log.warn('[PluginMarketplace] stats request attempt failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error('统计请求失败');
    }
    const payload = (await response.json()) as { plugins?: unknown };
    const rows = Array.isArray(payload.plugins) ? payload.plugins : [];
    const statsByKey = new Map<string, PluginMarketplaceStats>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const item = row as { sourceId?: unknown; pluginId?: unknown; stats?: unknown };
      const sourceId = String(item.sourceId || '').trim();
      const pluginId = normalizePluginId(item.pluginId);
      if (!sourceId || !pluginId) continue;
      statsByKey.set(
        getMarketplaceStatsKey(sourceId, pluginId),
        normalizeMarketplaceStats(item.stats),
      );
    }
    return statsByKey;
  } catch (error) {
    log.warn('[PluginMarketplace] stats request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
};

const reportMarketplacePluginInstallEvent = async (
  plugin: PluginMarketplacePlugin,
  event: 'install' | 'update' | 'failure',
  error?: unknown,
) => {
  const urlCandidates = getMarketplaceStatsApiUrlCandidates('/v1/plugins/events');
  if (urlCandidates.length === 0) return;
  try {
    let lastError: unknown = null;
    for (const url of urlCandidates) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': 'EchoMusic-Plugin-Marketplace',
            },
            body: JSON.stringify({
              event,
              plugin: {
                sourceId: plugin.sourceId,
                pluginId: plugin.id,
                version: plugin.version,
                sourceUrl: plugin.sourceUrl,
                sourceName: plugin.sourceName,
                repo: plugin.repo,
                packagePath: plugin.packagePath,
                downloadUrl: plugin.downloadUrl,
                checksum: plugin.checksum,
              },
              error:
                error instanceof Error ? error.message : typeof error === 'string' ? error : '',
            }),
          },
          PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS,
          '插件安装统计上报超时',
        );
        if (!response.ok) throw new Error(await getHttpFailureMessage(response, '统计上报失败'));
        return;
      } catch (reportError) {
        lastError = reportError;
        log.warn('[PluginMarketplace] install event report attempt failed', {
          pluginId: plugin.id,
          event,
          error: reportError instanceof Error ? reportError.message : String(reportError),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('插件安装统计上报失败');
  } catch (reportError) {
    log.warn('[PluginMarketplace] install event report failed', {
      pluginId: plugin.id,
      event,
      error: reportError instanceof Error ? reportError.message : String(reportError),
    });
  }
};

const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const runWithTimeout = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  lateFailureSource: string,
) => {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guardedTask = task.catch((error) => {
    if (timedOut) {
      log.warn('[PluginMarketplace] late async failure after timeout', {
        source: lateFailureSource,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  });

  try {
    return await Promise.race([
      guardedTask,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const normalizeMarketplaceSource = (
  source: Partial<PluginMarketplaceSource> | null | undefined,
): PluginMarketplaceSource | null => {
  const normalized = normalizeGithubRepositoryUrl(source?.url);
  if (!normalized) return null;
  const now = Date.now();
  const isOfficial = normalized.id === DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID;
  return {
    id: normalized.id,
    name: String(
      source?.name || (isOfficial ? 'EchoMusic 官方插件源' : normalized.repo.repo),
    ).trim(),
    url: normalized.url,
    enabled: source?.enabled !== false,
    official: Boolean(source?.official) || isOfficial,
    indexUrl: toGithubBlobUrl(normalized.repo, PLUGIN_MARKETPLACE_INDEX_FILE),
    homepage: String(source?.homepage || normalized.url),
    pluginCount: Math.max(0, Number(source?.pluginCount) || 0),
    addedAt: Number(source?.addedAt) || now,
    updatedAt: Number(source?.updatedAt) || now,
    lastFetchedAt: Number(source?.lastFetchedAt) || 0,
    lastError: String(source?.lastError || ''),
  };
};

const normalizeMarketplacePackagePath = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const isSafeMarketplacePackagePath = (value: string) =>
  value === '' ||
  (value !== '.' &&
    !value.split('/').includes('..') &&
    !value.startsWith('..') &&
    !isAbsolute(value));

const pluginInstaller = createPluginInstaller({
  findPlugin,
  getEnabledState,
  isSafePackagePath: isSafeMarketplacePackagePath,
  normalizePackagePath: normalizeMarketplacePackagePath,
  runWithTimeout,
  setEnabledState,
  setPluginInstalledAt,
  terminatePluginProcesses,
});

const {
  extractMarketplacePackage,
  findPluginInstallSourceDirectory,
  installPluginDirectory,
  installPluginsFromLocal,
} = pluginInstaller;

export { installPluginsFromLocal };

const normalizeMarketplaceTags = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );
};

const getMarketplaceRepositoryKey = (value: unknown) => {
  const normalized = normalizeGithubRepositoryUrl(value);
  return (
    normalized?.id ??
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
};

const getMarketplacePluginIdKey = (sourceId: string, pluginId: string) =>
  `${sourceId}:id:${pluginId}`;

const getMarketplacePluginPathKey = (sourceId: string, repo: unknown, packagePath: string) =>
  `${sourceId}:path:${getMarketplaceRepositoryKey(repo)}:${normalizeMarketplacePackagePath(packagePath)}`;

const getMarketplaceEntryRepository = (
  sourceRepo: GithubRepository,
  entry: PluginMarketplaceIndexEntry,
) => parseGithubRepository(entry.repo) ?? sourceRepo;

const normalizeMarketplaceDownloadUrl = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const normalizeMarketplaceChecksum = (value: unknown) => String(value ?? '').trim();

const getMarketplaceEntryDownloadUrl = (
  pluginRepo: GithubRepository,
  entry: PluginMarketplaceIndexEntry,
  manifest: EchoPluginManifest,
) =>
  normalizeMarketplaceDownloadUrl(entry.downloadUrl) ||
  normalizeMarketplaceDownloadUrl(manifest.downloadUrl) ||
  toGithubArchiveUrl(pluginRepo);

const resolveMarketplaceAssetUrl = (
  sourceRepo: GithubRepository,
  packagePath: string,
  assetPath: unknown,
) => {
  const source = String(assetPath ?? '').trim();
  if (!source) return '';
  if (/^(https?:\/\/|data:image\/)/i.test(source)) return source;
  if (!isSupportedPluginImage(source)) return '';
  const normalizedAssetPath = normalizeMarketplacePackagePath(
    packagePath ? `${packagePath}/${source}` : source,
  );
  if (!isSafeMarketplacePackagePath(normalizedAssetPath)) return '';
  return toRawGithubUrl(sourceRepo, normalizedAssetPath);
};

const getMarketplaceManifestUrl = (pluginRepo: GithubRepository, packagePath: string) =>
  toRawGithubUrl(
    pluginRepo,
    packagePath ? `${packagePath}/${PLUGIN_MANIFEST_FILE}` : PLUGIN_MANIFEST_FILE,
  );

const fetchMarketplaceManifest = async (
  pluginRepo: GithubRepository,
  packagePath: string,
  githubProxyUrl?: string,
  forceNetwork = false,
) => {
  const raw = await fetchMarketplaceText(
    getMarketplaceManifestUrl(pluginRepo, packagePath),
    githubProxyUrl,
    forceNetwork,
  );
  return JSON.parse(raw) as EchoPluginManifest;
};

const normalizeMarketplaceIndexPlugin = async (
  source: PluginMarketplaceSource,
  sourceRepo: GithubRepository,
  rawEntry: PluginMarketplaceIndexEntry,
  githubProxyUrl?: string,
  forceNetwork = false,
): Promise<PluginMarketplaceCatalogPlugin | null> => {
  const packagePath = normalizeMarketplacePackagePath(rawEntry?.packagePath ?? rawEntry?.path);
  if (!isSafeMarketplacePackagePath(packagePath)) return null;
  const pluginRepo = getMarketplaceEntryRepository(sourceRepo, rawEntry);
  const manifest = await fetchMarketplaceManifest(
    pluginRepo,
    packagePath,
    githubProxyUrl,
    forceNetwork,
  );
  if (validateManifest(manifest, '')) return null;

  const pluginId = normalizePluginId(manifest.id);
  const expectedPluginId = normalizePluginId(rawEntry?.id);
  if (!pluginId || (expectedPluginId && pluginId !== expectedPluginId)) return null;

  const name = String(manifest.name || '').trim();
  const version = String(manifest.version || '').trim();
  if (!name || !version) return null;

  const repo = String(rawEntry.repo || '').trim() || source.url;
  const homepage = String(rawEntry.homepage || '').trim() || repo;
  const icon = getManifestIconSource(manifest);
  const iconUrl = appendUrlCacheKey(
    resolveMarketplaceAssetUrl(pluginRepo, packagePath, icon),
    `${pluginId}-${version}`,
  );

  return {
    id: pluginId,
    name,
    version,
    description: String(manifest.description || ''),
    author: String(manifest.author || ''),
    icon,
    iconUrl,
    tags: normalizeMarketplaceTags(rawEntry.tags),
    repo,
    homepage,
    downloadUrl: getMarketplaceEntryDownloadUrl(pluginRepo, rawEntry, manifest),
    packagePath,
    checksum: normalizeMarketplaceChecksum(rawEntry.checksum),
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    manifest: {
      ...manifest,
      id: pluginId,
      name,
      version,
    },
  };
};

const normalizeMarketplaceIndexPlugins = async (
  source: PluginMarketplaceSource,
  index: PluginMarketplaceIndex,
  githubProxyUrl?: string,
  previousPlugins: PluginMarketplaceCatalogPlugin[] = [],
  forceNetwork = false,
): Promise<PluginMarketplaceIndexPluginsResult> => {
  const sourceRepo = parseGithubRepository(source.url);
  if (!sourceRepo || !Array.isArray(index.plugins)) {
    return { plugins: [], failedCount: 0, recoveredCount: 0 };
  }

  const cachedById = new Map<string, PluginMarketplaceCatalogPlugin>();
  const cachedByPath = new Map<string, PluginMarketplaceCatalogPlugin>();
  for (const plugin of previousPlugins) {
    if (plugin.sourceId !== source.id) continue;
    cachedById.set(getMarketplacePluginIdKey(plugin.sourceId, plugin.id), plugin);
    cachedByPath.set(
      getMarketplacePluginPathKey(
        plugin.sourceId,
        plugin.repo || plugin.sourceUrl,
        plugin.packagePath,
      ),
      plugin,
    );
  }

  const entryCacheKeys = index.plugins.map((entry) => {
    const packagePath = normalizeMarketplacePackagePath(entry?.packagePath ?? entry?.path);
    const expectedPluginId = normalizePluginId(entry?.id);
    const pluginRepo = getMarketplaceEntryRepository(sourceRepo, entry);
    return {
      idKey: expectedPluginId ? getMarketplacePluginIdKey(source.id, expectedPluginId) : '',
      pathKey: isSafeMarketplacePackagePath(packagePath)
        ? getMarketplacePluginPathKey(source.id, toGithubRepositoryUrl(pluginRepo), packagePath)
        : '',
    };
  });

  const settled = await Promise.allSettled(
    index.plugins.map((entry) =>
      normalizeMarketplaceIndexPlugin(source, sourceRepo, entry, githubProxyUrl, forceNetwork),
    ),
  );
  const plugins: PluginMarketplaceCatalogPlugin[] = [];
  let failedCount = 0;
  let recoveredCount = 0;

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) plugins.push(result.value);
      return;
    }

    failedCount += 1;
    const keys = entryCacheKeys[index];
    const cached =
      (keys.idKey && cachedById.get(keys.idKey)) ||
      (keys.pathKey && cachedByPath.get(keys.pathKey)) ||
      null;
    if (!cached) return;

    recoveredCount += 1;
    plugins.push({
      ...cached,
      sourceName: source.name,
      sourceUrl: source.url,
    });
  });

  const dedupedPlugins = new Map<string, PluginMarketplaceCatalogPlugin>();
  for (const plugin of plugins) {
    const key = getMarketplacePluginIdKey(plugin.sourceId, plugin.id);
    if (!dedupedPlugins.has(key)) dedupedPlugins.set(key, plugin);
  }

  return {
    plugins: Array.from(dedupedPlugins.values()),
    failedCount,
    recoveredCount,
  };
};

const fetchMarketplaceText = async (url: string, githubProxyUrl?: string, forceNetwork = false) => {
  // forceNetwork（用户手动刷新）时附加唯一查询参数破除 GitHub CDN/本地 HTTP 缓存，
  // 并带上 no-cache 请求头，确保拿到仓库最新内容。
  const bustedUrl = forceNetwork ? appendUrlCacheKey(url, `cb-${Date.now()}`) : url;
  const targetUrl = applyGithubProxyUrl(bustedUrl, githubProxyUrl);
  const headers: Record<string, string> = {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'EchoMusic-Plugin-Marketplace',
  };
  if (forceNetwork) {
    headers['Cache-Control'] = 'no-cache';
    headers.Pragma = 'no-cache';
  }
  const response = await fetchWithTimeout(
    targetUrl,
    { headers },
    PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS,
    '插件源请求超时，请检查网络或 GitHub 代理',
  );
  if (!response.ok) {
    throw new Error(`请求失败 (${response.status})`);
  }
  return response.text();
};

const fetchMarketplaceIndex = async (
  source: PluginMarketplaceSource,
  githubProxyUrl?: string,
  previousPlugins: PluginMarketplaceCatalogPlugin[] = [],
  forceNetwork = false,
) => {
  const sourceRepo = parseGithubRepository(source.url);
  if (!sourceRepo) throw new Error('仅支持 GitHub 仓库地址');
  const indexUrl = toRawGithubUrl(sourceRepo, PLUGIN_MARKETPLACE_INDEX_FILE);
  const raw = await fetchMarketplaceText(indexUrl, githubProxyUrl, forceNetwork);
  const index = JSON.parse(raw) as PluginMarketplaceIndex;
  const result = await normalizeMarketplaceIndexPlugins(
    source,
    index,
    githubProxyUrl,
    previousPlugins,
    forceNetwork,
  );
  const plugins = result.plugins;
  if (plugins.length === 0) {
    throw new Error(`${PLUGIN_MARKETPLACE_INDEX_FILE} 未提供可用插件`);
  }
  return {
    index,
    plugins,
    failedCount: result.failedCount,
    recoveredCount: result.recoveredCount,
    indexUrl: toGithubBlobUrl(sourceRepo, PLUGIN_MARKETPLACE_INDEX_FILE),
  };
};

const fetchMarketplaceSourceCatalog = async (
  source: PluginMarketplaceSource,
  githubProxyUrl?: string,
  previousPlugins: PluginMarketplaceCatalogPlugin[] = [],
  forceNetwork = false,
) => {
  try {
    const result = await fetchMarketplaceIndex(
      source,
      githubProxyUrl,
      previousPlugins,
      forceNetwork,
    );
    const now = Date.now();
    const sourceRepo = parseGithubRepository(source.url);
    const inferredName =
      source.id === DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID
        ? 'EchoMusic 官方插件源'
        : sourceRepo?.repo || source.name;
    const sourceName =
      source.name && source.name !== inferredName
        ? source.name
        : String(result.index.name || source.name || '').trim() || source.name;
    return {
      source: {
        ...source,
        name: sourceName,
        homepage: String(result.index.homepage || source.homepage || source.url),
        indexUrl: result.indexUrl,
        pluginCount: result.plugins.length,
        lastFetchedAt: now,
        updatedAt: now,
        lastError:
          result.failedCount > 0
            ? `部分插件刷新失败，已使用缓存 ${result.recoveredCount}/${result.failedCount}`
            : '',
      },
      plugins: result.plugins.map((plugin) => ({
        ...plugin,
        sourceName,
      })),
    };
  } catch (error) {
    return {
      source: {
        ...source,
        lastError: error instanceof Error ? error.message : '插件源刷新失败',
        updatedAt: Date.now(),
      },
      plugins: previousPlugins
        .filter((plugin) => plugin.sourceId === source.id)
        .map((plugin) => ({
          ...plugin,
          sourceName: source.name,
          sourceUrl: source.url,
        })),
    };
  }
};

const getComparableVersion = (value: string) =>
  semverValid(value) ?? semverCoerce(value)?.version ?? '';

const isMarketplaceVersionGreater = (candidate: string, current: string) => {
  const nextVersion = getComparableVersion(candidate);
  const currentVersion = getComparableVersion(current);
  if (nextVersion && currentVersion) return semverGt(nextVersion, currentVersion);
  return candidate.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0;
};

const hydrateMarketplacePlugins = async (
  plugins: PluginMarketplaceCatalogPlugin[],
  sources: PluginMarketplaceSource[],
  githubProxyUrl?: string,
): Promise<PluginMarketplacePlugin[]> => {
  const installedById = new Map(listPlugins().plugins.map((plugin) => [plugin.id, plugin]));
  const enabledSourceIds = new Set(
    sources.filter((source) => source.enabled).map((source) => source.id),
  );

  const hydrated = plugins
    .filter((plugin) => enabledSourceIds.has(plugin.sourceId))
    .map((plugin) => {
      const installed = installedById.get(plugin.id);
      return {
        ...plugin,
        iconUrl: applyGithubProxyUrl(plugin.iconUrl, githubProxyUrl),
        installed: Boolean(installed),
        installedVersion: installed?.version ?? '',
        updateAvailable: installed
          ? isMarketplaceVersionGreater(plugin.version, installed.version)
          : false,
        compatibility: getEchoMusicCompatibility(plugin.manifest),
        stats: getEmptyMarketplaceStats(),
      };
    });
  const statsByKey = await fetchMarketplacePluginStats(hydrated);
  return hydrated
    .map((plugin) => ({
      ...plugin,
      stats: statsByKey.get(getMarketplaceStatsKey(plugin.sourceId, plugin.id)) ?? plugin.stats,
    }))
    .sort(
      (left, right) =>
        right.stats.score - left.stats.score ||
        right.stats.installCount +
          right.stats.updateCount -
          (left.stats.installCount + left.stats.updateCount),
    );
};

const refreshMarketplaceCatalog = async (
  sources: PluginMarketplaceSource[],
  githubProxyUrl?: string,
  previousPlugins: PluginMarketplaceCatalogPlugin[] = [],
  forceNetwork = false,
) => {
  const enabledSources = sources.filter((source) => source.enabled);
  const fetched = await Promise.all(
    enabledSources.map((source) =>
      fetchMarketplaceSourceCatalog(source, githubProxyUrl, previousPlugins, forceNetwork),
    ),
  );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const plugins: PluginMarketplaceCatalogPlugin[] = [];

  for (const item of fetched) {
    sourceById.set(item.source.id, item.source);
    plugins.push(...item.plugins);
  }

  const nextSources = sources.map((source) => sourceById.get(source.id) ?? source);
  saveMarketplaceSources(nextSources);
  const cache = {
    schemaVersion: PLUGIN_MARKETPLACE_CACHE_VERSION,
    plugins,
    fetchedAt: Date.now(),
  };
  setMarketplaceCache(cache);
  return { sources: nextSources, cache };
};

export const listPluginMarketplaceSources = (): PluginMarketplaceSource[] =>
  getSavedMarketplaceSources();

export const addPluginMarketplaceSource = async (
  input: PluginMarketplaceSourceInput,
  options: PluginMarketplaceRequestOptions = {},
): Promise<PluginMarketplaceSourceMutationResult> => {
  const normalized = normalizeGithubRepositoryUrl(input?.url);
  const sources = getSavedMarketplaceSources();
  if (!normalized) return { ok: false, error: '请输入有效的 GitHub 仓库地址', sources };

  const now = Date.now();
  const candidate = normalizeMarketplaceSource({
    id: normalized.id,
    name: input.name,
    url: normalized.url,
    enabled: input.enabled !== false,
    addedAt: now,
    updatedAt: now,
  });
  if (!candidate) return { ok: false, error: '插件源地址无效', sources };

  const fetched = await fetchMarketplaceSourceCatalog(candidate, options.githubProxyUrl);
  if (fetched.source.lastError) {
    return { ok: false, error: fetched.source.lastError, sources };
  }

  const nextSource = {
    ...fetched.source,
    name: String(input.name || fetched.source.name || candidate.name).trim(),
    enabled: input.enabled !== false,
    addedAt: sources.find((source) => source.id === candidate.id)?.addedAt ?? now,
  };
  const nextSources = [nextSource, ...sources.filter((source) => source.id !== nextSource.id)].sort(
    (left, right) => Number(right.official) - Number(left.official),
  );
  saveMarketplaceSources(nextSources);
  getKvStorage().delete(PLUGIN_MARKETPLACE_CACHE_KEY);
  return { ok: true, source: nextSource, sources: nextSources };
};

export const patchPluginMarketplaceSource = (
  sourceId: string,
  patch: PluginMarketplaceSourcePatch,
): PluginMarketplaceSourceMutationResult => {
  const sources = getSavedMarketplaceSources();
  const target = sources.find((source) => source.id === sourceId);
  if (!target) return { ok: false, error: '插件源不存在', sources };

  const nextSource = normalizeMarketplaceSource({
    ...target,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : target.name,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : target.enabled,
    updatedAt: Date.now(),
  });
  if (!nextSource) return { ok: false, error: '插件源更新失败', sources };
  const nextSources = sources.map((source) => (source.id === sourceId ? nextSource : source));
  saveMarketplaceSources(nextSources);
  getKvStorage().delete(PLUGIN_MARKETPLACE_CACHE_KEY);
  return { ok: true, source: nextSource, sources: nextSources };
};

export const removePluginMarketplaceSource = (
  sourceId: string,
): PluginMarketplaceRemoveSourceResult => {
  const sources = getSavedMarketplaceSources();
  const target = sources.find((source) => source.id === sourceId);
  if (!target) {
    return { ok: false, error: '插件源不存在', sources };
  }
  if (target.official) {
    return { ok: false, error: '官方插件源可停用，但不能删除', sources };
  }
  const nextSources = sources.filter((source) => source.id !== sourceId);
  saveMarketplaceSources(nextSources);
  getKvStorage().delete(PLUGIN_MARKETPLACE_CACHE_KEY);
  return { ok: true, sourceId, sources: nextSources };
};

export const listPluginMarketplace = async (
  options: PluginMarketplaceRequestOptions = {},
): Promise<PluginMarketplaceListResult> => {
  const sources = getSavedMarketplaceSources();
  const enabledSources = sources.filter((source) => source.enabled);
  let cache = getMarketplaceCache();
  let nextSources = sources;

  if (options.refresh || (enabledSources.length > 0 && cache.plugins.length === 0)) {
    const refreshed = await refreshMarketplaceCatalog(
      sources,
      options.githubProxyUrl,
      cache.plugins,
      // 仅用户手动刷新时强制破缓存；缓存为空的自动拉取走常规请求即可
      Boolean(options.refresh),
    );
    nextSources = refreshed.sources;
    cache = refreshed.cache;
  }

  const plugins = await hydrateMarketplacePlugins(
    cache.plugins,
    nextSources,
    options.githubProxyUrl,
  );
  const enabledSourceErrors = nextSources
    .filter((source) => source.enabled && source.lastError)
    .map((source) => `${source.name}: ${source.lastError}`);
  const shouldReportFailure =
    enabledSources.length > 0 && plugins.length === 0 && enabledSourceErrors.length > 0;

  if (shouldReportFailure) {
    return {
      ok: false,
      error: enabledSourceErrors.join('\n'),
      sources: nextSources,
      plugins,
      fetchedAt: cache.fetchedAt,
    };
  }

  return {
    ok: true,
    sources: nextSources,
    plugins,
    fetchedAt: cache.fetchedAt,
  };
};

const downloadMarketplacePackage = async (
  plugin: PluginMarketplacePlugin,
  directory: string,
  githubProxyUrl?: string,
) => {
  const downloadUrl = applyGithubProxyUrl(plugin.downloadUrl, githubProxyUrl);
  log.info('[PluginMarketplace] package download started', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
  });
  const response = await fetchWithTimeout(
    downloadUrl,
    {
      headers: {
        Accept: 'application/zip,application/octet-stream,*/*',
        'User-Agent': 'EchoMusic-Plugin-Marketplace',
      },
    },
    PLUGIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS,
    '插件安装包下载超时，请检查网络或 GitHub 代理',
  );
  if (!response.ok) throw new Error(`插件下载失败 (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  log.info('[PluginMarketplace] package download finished', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
    bytes: buffer.byteLength,
  });
  if (buffer.byteLength > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
    throw new Error('插件安装包超过 80 MB');
  }

  const zipPath = join(directory, `${plugin.id}.zip`);
  await fs.writeFile(zipPath, buffer);

  if (plugin.checksum) {
    const expected = plugin.checksum
      .replace(/^sha256:/i, '')
      .trim()
      .toLowerCase();
    if (/^[a-f0-9]{64}$/.test(expected)) {
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== expected) throw new Error('插件安装包校验失败');
    }
  }

  return zipPath;
};

export const installPluginFromMarketplace = async (
  sourceId: string,
  pluginId: string,
  options: PluginMarketplaceInstallOptions = {},
): Promise<PluginMarketplaceInstallResult> => {
  const normalizedPluginId = normalizePluginId(pluginId);
  log.info('[PluginMarketplace] install requested', {
    sourceId,
    pluginId: normalizedPluginId,
  });
  let installTarget: PluginMarketplacePlugin | null = null;
  try {
    const marketplace = await listPluginMarketplace({
      githubProxyUrl: options.githubProxyUrl,
      refresh: false,
    });
    const plugin = marketplace.plugins.find(
      (item) => item.sourceId === sourceId && item.id === normalizedPluginId,
    );
    if (!plugin) {
      log.warn('[PluginMarketplace] install target not found', {
        sourceId,
        pluginId: normalizedPluginId,
      });
      return { ok: false, error: '在线插件不存在，请刷新插件源后重试' };
    }
    if (!plugin.compatibility.compatible) {
      log.warn('[PluginMarketplace] install blocked by compatibility', {
        sourceId,
        pluginId: plugin.id,
        message: plugin.compatibility.message,
      });
      return {
        ok: false,
        error: plugin.compatibility.message || '插件与当前 EchoMusic 版本不兼容',
      };
    }
    installTarget = plugin;

    const tempDirectory = await fs.mkdtemp(join(tmpdir(), 'echo-plugin-download-'));
    try {
      log.info('[PluginMarketplace] attempting archive install (zip download + extract)', {
        sourceId,
        pluginId: plugin.id,
      });
      const zipPath = await downloadMarketplacePackage(
        plugin,
        tempDirectory,
        options.githubProxyUrl,
      );
      const extractDirectory = join(tempDirectory, 'extracted');
      await fs.mkdir(extractDirectory, { recursive: true });
      await extractMarketplacePackage(zipPath, extractDirectory, plugin);
      const sourceDirectory = await findPluginInstallSourceDirectory(
        extractDirectory,
        plugin.packagePath,
      );
      log.info('[PluginMarketplace] archive install succeeded', {
        sourceId,
        pluginId: plugin.id,
      });

      log.info('[PluginMarketplace] install apply started', {
        sourceId,
        pluginId: plugin.id,
        method: 'archive',
      });
      const installed = await installPluginDirectory(sourceDirectory, {
        expectedPluginId: plugin.id,
        enableAfterInstall: Boolean(options.enableAfterInstall),
      });
      void reportMarketplacePluginInstallEvent(plugin, installed.updated ? 'update' : 'install');
      log.info('[PluginMarketplace] install succeeded', {
        sourceId,
        pluginId: installed.plugin.id,
        updated: installed.updated,
        enabled: installed.enabled,
      });
      return { ok: true, ...installed };
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    if (installTarget) {
      void reportMarketplacePluginInstallEvent(installTarget, 'failure', error);
    }
    log.warn('[PluginMarketplace] install failed', {
      sourceId,
      pluginId: normalizedPluginId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件安装失败',
    };
  }
};

export const getPluginWindowDescriptor = (pluginId: string, windowId: string) => {
  const plugin = findPlugin(pluginId);
  if (!plugin || plugin.invalid || !plugin.compatibility.compatible || !plugin.enabled) return null;
  const normalizedWindowId = normalizePluginId(windowId);
  return plugin.windows.find((item) => item.id === normalizedWindowId) ?? null;
};

export const setPluginEnabled = async (
  pluginId: string,
  enabled: boolean,
): Promise<PluginSetEnabledResult> => {
  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };
  if (enabled) {
    const compatibilityError = getPluginCompatibilityError(plugin);
    if (compatibilityError) return { ok: false, error: compatibilityError };
  }

  const nextState = getEnabledState();
  nextState[plugin.id] = Boolean(enabled);
  setEnabledState(nextState);
  if (!enabled) {
    await closePluginWebServer(plugin.id);
    closePluginSqliteDatabases(plugin.id);
    await terminatePluginProcesses(plugin.id);
  }
  const refreshed = findPlugin(plugin.id);
  return refreshed ? { ok: true, plugin: refreshed } : { ok: false, error: '插件刷新失败' };
};

export const readPluginTextAsset = (
  pluginId: string,
  asset: 'main' | 'style',
): PluginAssetSourceResult => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };
  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  if (!plugin.enabled) return { ok: false, error: '插件未启用' };

  const filePath = asset === 'main' ? plugin.mainFile : plugin.styleFile;
  if (!filePath)
    return { ok: false, error: asset === 'main' ? '插件入口为空' : '插件没有样式文件' };
  const pluginDir = resolve(plugin.directory);
  const resolvedFile = resolve(filePath);
  if (!isPathInside(pluginDir, resolvedFile)) return { ok: false, error: '插件资源路径非法' };
  if (!existsSync(resolvedFile)) return { ok: false, error: '插件资源不存在' };

  const ext = extname(resolvedFile).toLowerCase();
  if (asset === 'main' && !['.js', '.mjs'].includes(ext)) {
    return { ok: false, error: '插件入口必须是 .js 或 .mjs' };
  }
  if (asset === 'style' && ext !== '.css') {
    return { ok: false, error: '插件样式必须是 .css' };
  }

  try {
    return { ok: true, source: readFileSync(resolvedFile, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件资源读取失败',
    };
  }
};

export const readPluginWindowTextAsset = (
  pluginId: string,
  windowId: string,
  asset: 'main' | 'style',
): PluginAssetSourceResult => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };
  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  if (!plugin.enabled) return { ok: false, error: '插件未启用' };

  const descriptor = plugin.windows.find((item) => item.id === normalizePluginId(windowId));
  if (!descriptor) return { ok: false, error: '插件窗口不存在' };

  const filePath = asset === 'main' ? descriptor.mainFile : descriptor.styleFile;
  if (!filePath)
    return { ok: false, error: asset === 'main' ? '插件窗口入口为空' : '插件窗口没有样式文件' };

  const pluginDir = resolve(plugin.directory);
  const resolvedFile = resolve(filePath);
  if (!isPathInside(pluginDir, resolvedFile)) return { ok: false, error: '插件窗口资源路径非法' };
  if (!existsSync(resolvedFile)) return { ok: false, error: '插件窗口资源不存在' };

  const ext = extname(resolvedFile).toLowerCase();
  if (asset === 'main' && !['.js', '.mjs'].includes(ext)) {
    return { ok: false, error: '插件窗口入口必须是 .js 或 .mjs' };
  }
  if (asset === 'style' && ext !== '.css') {
    return { ok: false, error: '插件窗口样式必须是 .css' };
  }

  try {
    return { ok: true, source: readFileSync(resolvedFile, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件窗口资源读取失败',
    };
  }
};

const hasPluginLocalFilesAccess = (pluginId: string) => {
  if (getPluginSafeMode()) return { ok: false as const, error: '插件安全模式已开启' };
  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false as const, error: '插件不存在' };
  if (plugin.invalid) return { ok: false as const, error: plugin.error || '插件无效' };
  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return { ok: false as const, error: compatibilityError };
  if (!plugin.enabled) return { ok: false as const, error: '插件未启用' };
  if (plugin.manifest.capabilities?.localFiles !== true) {
    return { ok: false as const, error: '插件未声明本地文件能力' };
  }
  return { ok: true as const, plugin };
};

const pluginFileApi = createPluginFileApi({
  getLocalFilesAccess: hasPluginLocalFilesAccess,
});

export const {
  listPluginFiles,
  listPluginImageFiles,
  getPluginFileUrl,
  readPluginTextFile,
  readPluginFileBytes,
  readPluginAudioMetadata,
  writePluginFile,
  deletePluginFile,
} = pluginFileApi;

export const uninstallPlugin = async (pluginId: string): Promise<PluginUninstallResult> => {
  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };

  const root = resolve(ensurePluginRoot());
  const directory = resolve(plugin.directory);
  if (!isPathInside(root, directory) || directory === root) {
    return { ok: false, error: '插件目录非法' };
  }

  try {
    const nextState = getEnabledState();
    delete nextState[plugin.id];
    setEnabledState(nextState);
    const lastFailure = getPluginLastFailure();
    if (lastFailure?.pluginId === plugin.id || lastFailure?.pluginIds?.includes(plugin.id)) {
      getKvStorage().delete(PLUGIN_LAST_FAILURE_KEY);
    }
    clearPluginStorage(plugin.id);
    removePluginInstalledAt(plugin.id);
    clearPluginProcessConsents(plugin.id);

    await closePluginWebServer(plugin.id);
    deletePluginSqliteDatabases(plugin.id);

    // 等待进程完全终止
    await terminatePluginProcesses(plugin.id);

    // Windows下额外等待一小段时间，确保文件句柄被释放
    if (process.platform === 'win32') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    rmSync(directory, { recursive: true, force: true });
    return { ok: true, pluginId: plugin.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件卸载失败',
    };
  }
};

export const getPluginData = (pluginId: string, key: string) =>
  getKvStorage().get(getPluginStorageKey(pluginId, key));

export const setPluginData = (pluginId: string, key: string, value: unknown) => {
  getKvStorage().set(getPluginStorageKey(pluginId, key), value);
  trackPluginStorageKey(pluginId, key);
  return { ok: true };
};

export const deletePluginData = (pluginId: string, key: string) => {
  getKvStorage().delete(getPluginStorageKey(pluginId, key));
  untrackPluginStorageKey(pluginId, key);
  return { ok: true };
};

export const openPluginDirectory = () => {
  const root = ensurePluginRoot();
  void shell.openPath(root);
  return root;
};

export const getPluginDirectory = () => ensurePluginRoot();

export const ensurePluginDirectoryExists = () => {
  const root = ensurePluginRoot();
  try {
    const stats = statSync(root);
    return stats.isDirectory();
  } catch {
    return false;
  }
};
