import { app, dialog, shell, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  closeSync,
  realpathSync,
  rmSync,
  openSync,
  readSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import extractZip from 'extract-zip';
import {
  coerce as semverCoerce,
  gt as semverGt,
  satisfies as semverSatisfies,
  valid as semverValid,
  validRange as semverValidRange,
} from 'semver';
import type {
  EchoPluginCompatibility,
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginAssetSourceResult,
  PluginImageFileEntry,
  PluginFileUrlResult,
  PluginFailureRecord,
  PluginFileEntry,
  PluginFileKind,
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
  PluginListFilesOptions,
  PluginListFilesResult,
  PluginListResult,
  PluginLocalInstallItemResult,
  PluginLocalInstallOptions,
  PluginLocalInstallResult,
  PluginLocalInstallSourceKind,
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
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginReadFileBytesOptions,
  PluginReadFileBytesResult,
  PluginReadTextFileOptions,
  PluginReadTextFileResult,
  PluginWriteFileData,
  PluginWriteFileOptions,
  PluginWriteFileResult,
  PluginWindowDescriptor,
  PluginWindowManifest,
  PluginReportFailureResult,
  PluginSetSafeModeResult,
  PluginSetEnabledResult,
  PluginUninstallResult,
} from '../shared/plugins';
import { getKvStorage } from './storage/kv';
import log from './logger';

const PLUGIN_STATE_KEY = 'plugins:enabled';
const PLUGIN_SAFE_MODE_KEY = 'plugins:safe-mode';
const PLUGIN_LAST_FAILURE_KEY = 'plugins:last-failure';
const PLUGIN_STARTUP_SESSION_KEY = 'plugins:startup-session';
const PLUGIN_ACTIVE_SESSION_KEY = 'plugins:active-session';
const PLUGIN_INSTALL_TIMES_KEY = 'plugins:install-times';
const PLUGIN_MARKETPLACE_SOURCES_KEY = 'plugins:marketplace:sources';
const PLUGIN_MARKETPLACE_CACHE_KEY = 'plugins:marketplace:cache';
const PLUGIN_PROCESS_CONSENTS_KEY = 'plugins:process-consents';
const PLUGIN_MANIFEST_FILE = 'manifest.json';
const PLUGIN_MARKETPLACE_INDEX_FILE = 'echo-plugins.json';
const PLUGIN_MARKETPLACE_CACHE_VERSION = 3;
const DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL = 'https://github.com/hoowhoami/EchoMusicPlugins';
const DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID = 'github:hoowhoami/echomusicplugins';
const PLUGIN_IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
  '.svg',
  '.webp',
]);
const PLUGIN_AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.ape',
  '.dff',
  '.dsf',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  '.wma',
  '.wv',
]);
const PLUGIN_LYRIC_EXTENSIONS = new Set(['.krc', '.lrc', '.qrc', '.srt', '.ttml', '.txt']);
const PLUGIN_PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8', '.pls']);
const PLUGIN_CUE_EXTENSIONS = new Set(['.cue']);
const MAX_PLUGIN_IMAGE_SCAN_LIMIT = 1000;
const DEFAULT_PLUGIN_FILE_SCAN_LIMIT = 2000;
const MAX_PLUGIN_FILE_SCAN_LIMIT = 10000;
const DEFAULT_PLUGIN_READ_BYTES = 1024 * 1024;
const MAX_PLUGIN_READ_BYTES = 4 * 1024 * 1024;
const MAX_PLUGIN_WRITE_BYTES = 8 * 1024 * 1024;
const PLUGIN_WINDOW_MIN_WIDTH = 180;
const PLUGIN_WINDOW_MIN_HEIGHT = 48;
const PLUGIN_WINDOW_MAX_WIDTH = 1400;
const PLUGIN_WINDOW_MAX_HEIGHT = 900;
const PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
const PLUGIN_MARKETPLACE_API_TIMEOUT_MS = 10_000;
const PLUGIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 180_000;
const PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_MARKETPLACE_TREE_FILES = 500;
const PLUGIN_MARKETPLACE_TREE_DOWNLOAD_CONCURRENCY = 4;
const BARE_SEMVER_PATTERN = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PLUGIN_PROCESS_ARGS = 64;
const MAX_PLUGIN_PROCESS_ARG_LENGTH = 8192;
const MAX_PLUGIN_PROCESS_ENV_ENTRIES = 64;
const MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH = 8192;
const MAX_PLUGIN_PACKAGE_SIZE_BYTES = 80 * 1024 * 1024;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com']);
const BLOCKED_PLUGIN_PROCESS_ENV_KEYS = new Set([
  'ECHOMUSIC_PLUGIN_DIR',
  'ECHOMUSIC_PLUGIN_ID',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
]);

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
type GithubRepositoryResponse = {
  default_branch?: string;
  message?: string;
};
type GithubBranchResponse = {
  commit?: {
    sha?: string;
    commit?: {
      tree?: {
        sha?: string;
      };
    };
  };
  message?: string;
};
type GithubTreeEntry = {
  path?: string;
  type?: string;
  size?: number;
};
type GithubTreeResponse = {
  tree?: GithubTreeEntry[];
  truncated?: boolean;
  message?: string;
};
type GithubTreeRef = {
  branch: string;
  ref: string;
  treeSha: string;
};
type GithubApiRequestTarget = {
  url: string;
  mode: 'proxy' | 'direct';
  proxyKey?: string;
};
type MarketplaceTreeInstallFile = {
  rawPath: string;
  relativePath: string;
  size: number;
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
};
type PluginMarketplaceCatalogPlugin = Omit<
  PluginMarketplacePlugin,
  'installed' | 'installedVersion' | 'updateAvailable' | 'compatibility'
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

const unavailableGithubApiProxyUrls = new Set<string>();

type PluginProcessConsent = {
  pluginId: string;
  pluginVersion: string;
  executable: string;
  executableHash: string;
  grantedAt: number;
};
type PluginProcessConsents = Record<string, PluginProcessConsent>;
type PluginProcessRecord = {
  pluginId: string;
  executable: string;
  child: ChildProcess;
  startedAt: number;
};

type PluginDirectoryInstallOptions = {
  expectedPluginId?: string;
  enableAfterInstall: boolean;
};

export const normalizePluginId = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const comparePluginText = (left: string, right: string) =>
  left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });

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
const pluginProcesses = new Map<number, PluginProcessRecord>();

const getPluginRoot = () => join(app.getPath('userData'), 'plugins');

const ensurePluginRoot = () => {
  const root = getPluginRoot();
  mkdirSync(root, { recursive: true });
  return root;
};

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
    setLastFailure({
      pluginIds: activeSession.pluginIds,
      reason: 'render-process-gone',
      message: '上次应用在插件运行期间未正常退出，已自动进入安全模式。',
      createdAt: Date.now(),
    });
    setPluginSafeMode(true);
    getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
  }
};

export const setPluginSafeMode = (enabled: boolean): PluginSetSafeModeResult => {
  try {
    getKvStorage().set(PLUGIN_SAFE_MODE_KEY, Boolean(enabled));
    if (enabled) {
      getKvStorage().delete(PLUGIN_STARTUP_SESSION_KEY);
      getKvStorage().delete(PLUGIN_ACTIVE_SESSION_KEY);
      terminatePluginProcesses();
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

const isPathInside = (parent: string, target: string) => {
  const diff = relative(parent, target);
  return diff === '' || (!!diff && !diff.startsWith('..') && !isAbsolute(diff));
};

const resolvePluginFile = (directory: string, fileName: unknown) => {
  const normalizedFileName = normalize(String(fileName ?? '').trim());
  if (!normalizedFileName || normalizedFileName.startsWith('..')) return '';
  const fullPath = resolve(directory, normalizedFileName);
  if (!isPathInside(resolve(directory), fullPath)) return '';
  return fullPath;
};

const isRemoteImageSource = (source: string) =>
  /^https?:\/\//i.test(source) || /^data:image\//i.test(source);

const isSupportedPluginImage = (source: string) =>
  isRemoteImageSource(source) || PLUGIN_IMAGE_EXTENSIONS.has(extname(source).toLowerCase());

const appendUrlCacheKey = (source: string, cacheKey: string) => {
  const target = String(source || '').trim();
  const key = String(cacheKey || '').trim();
  if (!target || !key || /^data:image\//i.test(target)) return target;

  try {
    const url = new URL(target);
    url.searchParams.set('v', key);
    return url.toString();
  } catch {
    return target;
  }
};

const getManifestIconSource = (manifest: EchoPluginManifest) => {
  const icon = manifest.icon;
  if (typeof icon === 'string' && isSupportedPluginImage(icon.trim())) return icon.trim();
  return '';
};

const normalizeWindowDimension = (value: unknown, fallback: number, min: number, max: number) => {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return clamp(next, min, max);
};

const normalizePluginWindowDescriptors = (
  pluginId: string,
  directory: string,
  manifest: EchoPluginManifest,
): { windows: PluginWindowDescriptor[]; error: string } => {
  const rawWindows = manifest.contributes?.windows;
  if (!rawWindows) return { windows: [], error: '' };
  if (!Array.isArray(rawWindows)) return { windows: [], error: 'contributes.windows 必须是数组' };

  const windows: PluginWindowDescriptor[] = [];
  const seenWindowIds = new Set<string>();

  for (const rawWindow of rawWindows as PluginWindowManifest[]) {
    const windowId = normalizePluginId(rawWindow?.id);
    if (!windowId) return { windows, error: '插件窗口 id 不能为空' };
    if (seenWindowIds.has(windowId)) {
      return { windows, error: `插件窗口 id 重复: ${windowId}` };
    }
    seenWindowIds.add(windowId);

    const main = String(rawWindow?.main || '').trim();
    if (!main) return { windows, error: `插件窗口 ${windowId} 缺少 main 入口` };
    const mainFile = resolvePluginFile(directory, main);
    if (!mainFile) return { windows, error: `插件窗口 ${windowId} 入口路径非法` };

    const style = String(rawWindow?.style || '').trim();
    const styleFile = style ? resolvePluginFile(directory, style) : '';
    if (style && !styleFile) return { windows, error: `插件窗口 ${windowId} 样式路径非法` };

    const defaultWidth = normalizeWindowDimension(
      rawWindow.defaultWidth,
      420,
      PLUGIN_WINDOW_MIN_WIDTH,
      PLUGIN_WINDOW_MAX_WIDTH,
    );
    const defaultHeight = normalizeWindowDimension(
      rawWindow.defaultHeight,
      72,
      PLUGIN_WINDOW_MIN_HEIGHT,
      PLUGIN_WINDOW_MAX_HEIGHT,
    );
    const minWidth = normalizeWindowDimension(
      rawWindow.minWidth,
      Math.min(defaultWidth, PLUGIN_WINDOW_MIN_WIDTH),
      PLUGIN_WINDOW_MIN_WIDTH,
      PLUGIN_WINDOW_MAX_WIDTH,
    );
    const minHeight = normalizeWindowDimension(
      rawWindow.minHeight,
      Math.min(defaultHeight, PLUGIN_WINDOW_MIN_HEIGHT),
      PLUGIN_WINDOW_MIN_HEIGHT,
      PLUGIN_WINDOW_MAX_HEIGHT,
    );
    const maxWidth = normalizeWindowDimension(
      rawWindow.maxWidth,
      Math.max(defaultWidth, minWidth),
      minWidth,
      PLUGIN_WINDOW_MAX_WIDTH,
    );
    const maxHeight = normalizeWindowDimension(
      rawWindow.maxHeight,
      Math.max(defaultHeight, minHeight),
      minHeight,
      PLUGIN_WINDOW_MAX_HEIGHT,
    );

    windows.push({
      pluginId,
      id: windowId,
      type: 'floating',
      title: String(rawWindow.title || `${manifest.name || pluginId} - ${windowId}`),
      main,
      style,
      mainFile,
      styleFile,
      defaultWidth: clamp(defaultWidth, minWidth, maxWidth),
      defaultHeight: clamp(defaultHeight, minHeight, maxHeight),
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
      position: rawWindow.position === 'center' ? 'center' : 'top-center',
      transparent: rawWindow.transparent !== false,
      alwaysOnTop: rawWindow.alwaysOnTop !== false,
      skipTaskbar: rawWindow.skipTaskbar !== false,
      resizable: Boolean(rawWindow.resizable),
      movable: rawWindow.movable !== false,
      rememberBounds: rawWindow.rememberBounds !== false,
      allowOutsideWorkArea: Boolean(rawWindow.allowOutsideWorkArea),
      acceptFirstMouse: Boolean(rawWindow.acceptFirstMouse),
    });
  }

  return { windows, error: '' };
};

const readManifest = (manifestPath: string): { manifest: EchoPluginManifest; error: string } => {
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as EchoPluginManifest;
    return { manifest: parsed, error: '' };
  } catch (error) {
    return {
      manifest: {
        id: basename(manifestPath),
        name: basename(manifestPath),
        version: '0.0.0',
      },
      error: error instanceof Error ? error.message : 'manifest 读取失败',
    };
  }
};

const getHostVersion = () =>
  semverValid(app.getVersion()) ?? semverCoerce(app.getVersion())?.version ?? '';

const normalizeEchoMusicVersionRequirement = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return { range: '', error: '' };

  if (BARE_SEMVER_PATTERN.test(text)) {
    const version = semverValid(text) ?? semverCoerce(text)?.version;
    return version
      ? { range: `>=${version}`, error: '' }
      : { range: '', error: `requires.echoMusicVersion 主程序版本要求无效: ${text}` };
  }

  const range = semverValidRange(text);
  if (!range) return { range: '', error: `requires.echoMusicVersion 主程序版本范围无效: ${text}` };
  return { range, error: '' };
};

const validateEchoMusicVersionRequirement = (manifest: EchoPluginManifest) => {
  const requirement = manifest.requires?.echoMusicVersion;
  if (!requirement) return '';

  return normalizeEchoMusicVersionRequirement(requirement).error;
};

const validateManifestCapabilities = (manifest: EchoPluginManifest) => {
  const capabilities = manifest.capabilities;
  if (capabilities === undefined) return '';
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return 'manifest.capabilities 必须是对象';
  }
  if (capabilities.audioSource !== undefined && typeof capabilities.audioSource !== 'boolean') {
    return 'manifest.capabilities.audioSource 必须是布尔值';
  }
  if (capabilities.audioSpectrum !== undefined && typeof capabilities.audioSpectrum !== 'boolean') {
    return 'manifest.capabilities.audioSpectrum 必须是布尔值';
  }
  if (capabilities.kugouApi !== undefined && typeof capabilities.kugouApi !== 'boolean') {
    return 'manifest.capabilities.kugouApi 必须是布尔值';
  }
  if (capabilities.localFiles !== undefined && typeof capabilities.localFiles !== 'boolean') {
    return 'manifest.capabilities.localFiles 必须是布尔值';
  }
  if (capabilities.lyricEffects !== undefined && typeof capabilities.lyricEffects !== 'boolean') {
    return 'manifest.capabilities.lyricEffects 必须是布尔值';
  }
  if (capabilities.lyrics !== undefined && typeof capabilities.lyrics !== 'boolean') {
    return 'manifest.capabilities.lyrics 必须是布尔值';
  }
  if (capabilities.process !== undefined && typeof capabilities.process !== 'boolean') {
    return 'manifest.capabilities.process 必须是布尔值';
  }
  return '';
};

const getEchoMusicCompatibility = (manifest: EchoPluginManifest): EchoPluginCompatibility => {
  const requirement = String(manifest.requires?.echoMusicVersion ?? '').trim();
  const hostVersion = getHostVersion();

  if (!requirement) {
    return {
      compatible: true,
      currentEchoMusicVersion: hostVersion,
      requiredEchoMusicVersion: '',
      message: '',
    };
  }

  const { range, error } = normalizeEchoMusicVersionRequirement(requirement);
  if (error || !range || !hostVersion) {
    return {
      compatible: false,
      currentEchoMusicVersion: hostVersion,
      requiredEchoMusicVersion: requirement,
      message: error || '无法确认当前 EchoMusic 版本',
    };
  }

  const compatible = semverSatisfies(hostVersion, range, { includePrerelease: true });
  return {
    compatible,
    currentEchoMusicVersion: hostVersion,
    requiredEchoMusicVersion: range,
    message: compatible
      ? ''
      : `版本不兼容：需要 EchoMusic 主程序 ${range}，当前版本 ${hostVersion}`,
  };
};

const validateManifest = (manifest: EchoPluginManifest, manifestError: string) => {
  if (manifestError) return manifestError;
  if (!normalizePluginId(manifest.id)) return 'manifest.id 不能为空';
  if (!String(manifest.name ?? '').trim()) return 'manifest.name 不能为空';
  if (!String(manifest.version ?? '').trim()) return 'manifest.version 不能为空';
  const capabilitiesError = validateManifestCapabilities(manifest);
  if (capabilitiesError) return capabilitiesError;
  const versionRequirementError = validateEchoMusicVersionRequirement(manifest);
  if (versionRequirementError) return versionRequirementError;
  return '';
};

const toDescriptor = (
  directory: string,
  directoryName: string,
  enabledState: PluginEnabledState,
): EchoPluginDescriptor => {
  const manifestPath = join(directory, PLUGIN_MANIFEST_FILE);
  const { manifest, error: manifestError } = readManifest(manifestPath);
  const id = normalizePluginId(manifest.id) || normalizePluginId(directoryName) || directoryName;
  const mainFile = resolvePluginFile(directory, manifest.main || 'index.js');
  const styleFile = manifest.style ? resolvePluginFile(directory, manifest.style) : '';
  const { windows, error: windowError } = normalizePluginWindowDescriptors(id, directory, manifest);
  const iconSource = getManifestIconSource(manifest);
  const iconFile =
    iconSource && !isRemoteImageSource(iconSource) ? resolvePluginFile(directory, iconSource) : '';
  const iconFileExists = Boolean(iconFile && existsSync(iconFile));
  const iconVersion = String(manifest.version || '0.0.0');
  const iconCacheKey = iconFileExists
    ? `${iconVersion}-${Math.round(statSync(iconFile).mtimeMs)}`
    : iconVersion;
  const validationError = validateManifest(manifest, manifestError);
  const compatibility = getEchoMusicCompatibility(manifest);
  const mainError = !validationError && mainFile && !existsSync(mainFile) ? '插件入口不存在' : '';
  const styleError =
    !validationError && styleFile && !existsSync(styleFile) ? '插件样式文件不存在' : '';
  const missingWindowError =
    !validationError && !windowError
      ? (windows.find((item) => !existsSync(item.mainFile)) &&
          `插件窗口 ${windows.find((item) => !existsSync(item.mainFile))?.id} 入口不存在`) ||
        (windows.find((item) => item.styleFile && !existsSync(item.styleFile)) &&
          `插件窗口 ${windows.find((item) => item.styleFile && !existsSync(item.styleFile))?.id} 样式文件不存在`) ||
        ''
      : '';
  const windowExtensionError =
    !validationError && !windowError && !missingWindowError
      ? (windows.find((item) => !['.js', '.mjs'].includes(extname(item.mainFile).toLowerCase())) &&
          `插件窗口 ${windows.find((item) => !['.js', '.mjs'].includes(extname(item.mainFile).toLowerCase()))?.id} 入口必须是 .js 或 .mjs`) ||
        (windows.find(
          (item) => item.styleFile && extname(item.styleFile).toLowerCase() !== '.css',
        ) &&
          `插件窗口 ${windows.find((item) => item.styleFile && extname(item.styleFile).toLowerCase() !== '.css')?.id} 样式必须是 .css`) ||
        ''
      : '';
  const error =
    validationError ||
    mainError ||
    styleError ||
    windowError ||
    missingWindowError ||
    windowExtensionError;
  const invalid = Boolean(error);

  return {
    id,
    name: String(manifest.name || id),
    version: String(manifest.version || '0.0.0'),
    description: String(manifest.description || ''),
    author: String(manifest.author || ''),
    directoryName,
    directory,
    manifestPath,
    mainFile,
    styleFile,
    iconUrl: iconFileExists
      ? appendUrlCacheKey(pathToFileURL(iconFile).toString(), iconCacheKey)
      : isRemoteImageSource(iconSource)
        ? appendUrlCacheKey(iconSource, iconCacheKey)
        : '',
    windows,
    enabled: !invalid && compatibility.compatible && Boolean(enabledState[id]),
    invalid,
    error,
    compatibility,
    manifest: {
      ...manifest,
      id,
      name: String(manifest.name || id),
      version: String(manifest.version || '0.0.0'),
    },
  };
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

export const getPluginDescriptor = (pluginId: string) => findPlugin(pluginId);

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

const toGithubRepositoryApiUrl = (repo: GithubRepository) =>
  `https://api.github.com/repos/${repo.owner}/${repo.repo}`;

const toGithubBranchUrl = (repo: GithubRepository, branch: string) =>
  `https://api.github.com/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`;

const toGithubTreeUrl = (repo: GithubRepository, treeSha: string) =>
  `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`;

const toGithubArchiveUrl = (repo: GithubRepository) =>
  `https://github.com/${repo.owner}/${repo.repo}/archive/HEAD.zip`;

const toGithubBlobUrl = (repo: GithubRepository, filePath: string) => {
  const normalizedPath = normalizeMarketplacePackagePath(filePath);
  return `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/${normalizedPath}`;
};

const isGithubApiUrl = (value: string) => {
  try {
    const { hostname } = new URL(value);
    return hostname === 'api.github.com';
  } catch {
    return false;
  }
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

const getGithubApiRequestTargets = (
  url: string,
  githubProxyUrl?: string,
): GithubApiRequestTarget[] => {
  const target = String(url || '').trim();
  const proxy = normalizeGithubProxyUrl(githubProxyUrl);
  const directTarget: GithubApiRequestTarget = { url: target, mode: 'direct' };
  if (
    !target ||
    !proxy ||
    !/^https?:\/\//i.test(target) ||
    !isGithubApiUrl(target) ||
    unavailableGithubApiProxyUrls.has(proxy)
  ) {
    return [directTarget];
  }

  const proxyTarget = toGithubProxyUrl(target, proxy);
  if (proxyTarget === target) return [directTarget];
  return [{ url: proxyTarget, mode: 'proxy', proxyKey: proxy }, directTarget];
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

const removeTemporaryDirectory = (directory: string) => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn('[PluginMarketplace] temporary directory cleanup failed', {
      directory,
      error: error instanceof Error ? error.message : String(error),
    });
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

const getMarketplaceEntryDownloadUrl = (pluginRepo: GithubRepository) =>
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
) => {
  const raw = await fetchMarketplaceText(
    getMarketplaceManifestUrl(pluginRepo, packagePath),
    githubProxyUrl,
  );
  return JSON.parse(raw) as EchoPluginManifest;
};

const normalizeMarketplaceIndexPlugin = async (
  source: PluginMarketplaceSource,
  sourceRepo: GithubRepository,
  rawEntry: PluginMarketplaceIndexEntry,
  githubProxyUrl?: string,
): Promise<PluginMarketplaceCatalogPlugin | null> => {
  const packagePath = normalizeMarketplacePackagePath(rawEntry?.packagePath ?? rawEntry?.path);
  if (!isSafeMarketplacePackagePath(packagePath)) return null;
  const pluginRepo = getMarketplaceEntryRepository(sourceRepo, rawEntry);
  const manifest = await fetchMarketplaceManifest(pluginRepo, packagePath, githubProxyUrl);
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
    downloadUrl: getMarketplaceEntryDownloadUrl(pluginRepo),
    packagePath,
    checksum: '',
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
      normalizeMarketplaceIndexPlugin(source, sourceRepo, entry, githubProxyUrl),
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

const fetchMarketplaceText = async (url: string, githubProxyUrl?: string) => {
  const targetUrl = applyGithubProxyUrl(url, githubProxyUrl);
  const response = await fetchWithTimeout(
    targetUrl,
    {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'EchoMusic-Plugin-Marketplace',
      },
    },
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
) => {
  const sourceRepo = parseGithubRepository(source.url);
  if (!sourceRepo) throw new Error('仅支持 GitHub 仓库地址');
  const indexUrl = toRawGithubUrl(sourceRepo, PLUGIN_MARKETPLACE_INDEX_FILE);
  const raw = await fetchMarketplaceText(indexUrl, githubProxyUrl);
  const index = JSON.parse(raw) as PluginMarketplaceIndex;
  const result = await normalizeMarketplaceIndexPlugins(
    source,
    index,
    githubProxyUrl,
    previousPlugins,
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
) => {
  try {
    const result = await fetchMarketplaceIndex(source, githubProxyUrl, previousPlugins);
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

const hydrateMarketplacePlugins = (
  plugins: PluginMarketplaceCatalogPlugin[],
  sources: PluginMarketplaceSource[],
  githubProxyUrl?: string,
): PluginMarketplacePlugin[] => {
  const installedById = new Map(listPlugins().plugins.map((plugin) => [plugin.id, plugin]));
  const enabledSourceIds = new Set(
    sources.filter((source) => source.enabled).map((source) => source.id),
  );

  return plugins
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
      };
    });
};

const refreshMarketplaceCatalog = async (
  sources: PluginMarketplaceSource[],
  githubProxyUrl?: string,
  previousPlugins: PluginMarketplaceCatalogPlugin[] = [],
) => {
  const enabledSources = sources.filter((source) => source.enabled);
  const fetched = await Promise.all(
    enabledSources.map((source) =>
      fetchMarketplaceSourceCatalog(source, githubProxyUrl, previousPlugins),
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
    );
    nextSources = refreshed.sources;
    cache = refreshed.cache;
  }

  const plugins = hydrateMarketplacePlugins(cache.plugins, nextSources, options.githubProxyUrl);
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
  writeFileSync(zipPath, buffer);

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

const fetchMarketplaceFileBuffer = async (url: string, githubProxyUrl?: string) => {
  const targetUrl = applyGithubProxyUrl(url, githubProxyUrl);
  const response = await fetchWithTimeout(
    targetUrl,
    {
      headers: {
        Accept: 'application/octet-stream,*/*',
        'User-Agent': 'EchoMusic-Plugin-Marketplace',
      },
    },
    PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS,
    '插件文件请求超时，请检查网络或 GitHub 代理',
  );
  if (!response.ok) throw new Error(`插件文件下载失败 (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

const writeMarketplaceInstallFile = (
  sourceDirectory: string,
  relativeFile: string,
  content: string | Buffer,
) => {
  const normalizedRelativeFile = normalizeMarketplacePackagePath(relativeFile);
  if (!normalizedRelativeFile || !isSafeMarketplacePackagePath(normalizedRelativeFile)) {
    throw new Error(`插件文件路径非法: ${relativeFile}`);
  }

  const targetFile = resolve(sourceDirectory, normalizedRelativeFile);
  if (!isPathInside(sourceDirectory, targetFile)) {
    throw new Error(`插件文件路径越界: ${relativeFile}`);
  }
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, content);
};

const fetchGithubApiJson = async <T>(
  url: string,
  githubProxyUrl: string | undefined,
  timeoutMessage: string,
  failureMessage: string,
) => {
  const targets = getGithubApiRequestTargets(url, githubProxyUrl);
  let lastError: Error | null = null;

  for (const target of targets) {
    try {
      const response = await fetchWithTimeout(
        target.url,
        {
          headers: {
            Accept: 'application/vnd.github+json,application/json,*/*',
            'User-Agent': 'EchoMusic-Plugin-Marketplace',
          },
        },
        PLUGIN_MARKETPLACE_API_TIMEOUT_MS,
        timeoutMessage,
      );
      if (!response.ok) throw new Error(`${failureMessage} (${response.status})`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (target.mode === 'proxy' && targets.some((item) => item.mode === 'direct')) {
        if (target.proxyKey) unavailableGithubApiProxyUrls.add(target.proxyKey);
        log.info('[PluginMarketplace] github api proxy disabled, retry direct', {
          error: lastError.message,
        });
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error(failureMessage);
};

const fetchGithubTreeRef = async (
  repo: GithubRepository,
  githubProxyUrl?: string,
): Promise<GithubTreeRef> => {
  log.info('[PluginMarketplace] tree ref resolve started', {
    repo: `${repo.owner}/${repo.repo}`,
  });
  const repoPayload = await fetchGithubApiJson<GithubRepositoryResponse>(
    toGithubRepositoryApiUrl(repo),
    githubProxyUrl,
    '插件仓库信息请求超时，请检查网络或 GitHub 代理',
    '插件仓库信息请求失败',
  );
  const defaultBranch = String(repoPayload.default_branch || '').trim();
  if (!defaultBranch) throw new Error(repoPayload.message || '插件仓库默认分支无效');

  const branchPayload = await fetchGithubApiJson<GithubBranchResponse>(
    toGithubBranchUrl(repo, defaultBranch),
    githubProxyUrl,
    '插件仓库分支信息请求超时，请检查网络或 GitHub 代理',
    '插件仓库分支信息请求失败',
  );
  const treeSha = String(branchPayload.commit?.commit?.tree?.sha || '').trim();
  if (!treeSha) throw new Error(branchPayload.message || '插件仓库 tree 引用无效');
  const ref = String(branchPayload.commit?.sha || '').trim() || defaultBranch;
  log.info('[PluginMarketplace] tree ref resolved', {
    repo: `${repo.owner}/${repo.repo}`,
    branch: defaultBranch,
    ref,
    treeSha,
  });
  return { branch: defaultBranch, ref, treeSha };
};

const fetchGithubTree = async (repo: GithubRepository, githubProxyUrl?: string) => {
  log.info('[PluginMarketplace] tree fetch started', {
    repo: `${repo.owner}/${repo.repo}`,
  });
  const treeRef = await fetchGithubTreeRef(repo, githubProxyUrl);
  const payload = await fetchGithubApiJson<GithubTreeResponse>(
    toGithubTreeUrl(repo, treeRef.treeSha),
    githubProxyUrl,
    '插件仓库文件列表请求超时，请检查网络或 GitHub 代理',
    '插件仓库文件列表请求失败',
  );
  if (!Array.isArray(payload.tree)) {
    throw new Error(payload.message || '插件仓库文件列表无效');
  }
  if (payload.truncated) {
    throw new Error('插件仓库文件过多，请改用压缩包安装');
  }
  log.info('[PluginMarketplace] tree fetch finished', {
    repo: `${repo.owner}/${repo.repo}`,
    branch: treeRef.branch,
    ref: treeRef.ref,
    treeSha: treeRef.treeSha,
    entries: payload.tree.length,
  });
  return {
    tree: payload.tree,
    ref: treeRef.ref,
  };
};

const getMarketplaceTreeInstallFiles = (
  plugin: PluginMarketplacePlugin,
  tree: GithubTreeEntry[],
): MarketplaceTreeInstallFile[] => {
  const packagePath = normalizeMarketplacePackagePath(plugin.packagePath);
  if (!isSafeMarketplacePackagePath(packagePath)) throw new Error('插件包路径非法');
  const prefix = packagePath ? `${packagePath}/` : '';
  const files: MarketplaceTreeInstallFile[] = [];
  let totalSize = 0;

  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    const rawPath = normalizeMarketplacePackagePath(entry.path);
    if (!rawPath || !isSafeMarketplacePackagePath(rawPath)) continue;
    if (prefix && !rawPath.startsWith(prefix)) continue;

    const relativePath = prefix ? rawPath.slice(prefix.length) : rawPath;
    if (!relativePath || !isSafeMarketplacePackagePath(relativePath)) continue;

    const size = Math.max(0, Math.round(Number(entry.size) || 0));
    totalSize += size;
    files.push({ rawPath, relativePath, size });
  }

  if (!files.some((file) => file.relativePath === PLUGIN_MANIFEST_FILE)) {
    throw new Error('插件目录缺少 manifest.json');
  }
  if (files.length > MAX_PLUGIN_MARKETPLACE_TREE_FILES) {
    throw new Error(`插件文件数量超过限制 (${MAX_PLUGIN_MARKETPLACE_TREE_FILES})`);
  }
  if (totalSize > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
    throw new Error('插件文件总大小超过 80 MB');
  }

  log.info('[PluginMarketplace] tree install files selected', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
    packagePath,
    files: files.length,
    bytes: totalSize,
  });

  return files.sort((left, right) => comparePluginText(left.relativePath, right.relativePath));
};

const prepareMarketplaceTreeInstallDirectory = async (
  plugin: PluginMarketplacePlugin,
  directory: string,
  githubProxyUrl?: string,
) => {
  const repo = parseGithubRepository(plugin.repo || plugin.sourceUrl);
  if (!repo) throw new Error('插件仓库地址无效');

  const treeResult = await fetchGithubTree(repo, githubProxyUrl);
  const tree = treeResult.tree;
  const files = getMarketplaceTreeInstallFiles(plugin, tree);
  const sourceDirectory = join(directory, 'tree', plugin.id);
  mkdirSync(sourceDirectory, { recursive: true });

  log.info('[PluginMarketplace] tree install started', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
    ref: treeResult.ref,
    files: files.length,
  });

  for (let index = 0; index < files.length; index += PLUGIN_MARKETPLACE_TREE_DOWNLOAD_CONCURRENCY) {
    const batch = files.slice(index, index + PLUGIN_MARKETPLACE_TREE_DOWNLOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (file) => {
        try {
          const buffer = await fetchMarketplaceFileBuffer(
            toRawGithubUrl(repo, file.rawPath, treeResult.ref),
            githubProxyUrl,
          );
          writeMarketplaceInstallFile(sourceDirectory, file.relativePath, buffer);
        } catch (error) {
          log.warn('[PluginMarketplace] tree file install failed', {
            pluginId: plugin.id,
            sourceId: plugin.sourceId,
            file: file.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }),
    );
  }

  log.info('[PluginMarketplace] tree install prepared', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
    ref: treeResult.ref,
    files: files.length,
  });

  return sourceDirectory;
};

const extractMarketplacePackage = async (
  zipPath: string,
  extractDirectory: string,
  plugin: Pick<PluginMarketplacePlugin, 'id' | 'sourceId'>,
) => {
  log.info('[PluginMarketplace] package extract started', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
  });
  await runWithTimeout(
    extractZip(zipPath, { dir: extractDirectory }),
    PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS,
    '插件安装包解压超时',
    'extract-zip',
  );
  log.info('[PluginMarketplace] package extract finished', {
    pluginId: plugin.id,
    sourceId: plugin.sourceId,
  });
};

const findExtractedArchiveRoot = (directory: string) => {
  const entries = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith('__MACOSX'),
  );
  if (entries.length === 1 && entries[0].isDirectory()) {
    return join(directory, entries[0].name);
  }
  return directory;
};

const findPluginInstallSourceDirectory = (extractDirectory: string, packagePath: string) => {
  const archiveRoot = findExtractedArchiveRoot(extractDirectory);
  const candidate = resolve(archiveRoot, packagePath || '.');
  if (!isPathInside(archiveRoot, candidate)) throw new Error('插件包路径非法');
  if (existsSync(join(candidate, PLUGIN_MANIFEST_FILE))) return candidate;

  const entries = existsSync(candidate)
    ? readdirSync(candidate, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  if (entries.length === 1) {
    const nested = join(candidate, entries[0].name);
    if (existsSync(join(nested, PLUGIN_MANIFEST_FILE))) return nested;
  }

  throw new Error('插件安装包中未找到 manifest.json');
};

const installPluginDirectory = (
  sourceDirectory: string,
  options: PluginDirectoryInstallOptions,
) => {
  const sourceStats = statSync(sourceDirectory);
  if (!sourceStats.isDirectory()) throw new Error('插件源必须是文件夹');

  const manifestResult = readManifest(join(sourceDirectory, PLUGIN_MANIFEST_FILE));
  if (manifestResult.error) throw new Error(manifestResult.error);
  const pluginId = normalizePluginId(manifestResult.manifest.id);
  if (!pluginId) throw new Error('manifest.id 不能为空');

  const expectedPluginId = normalizePluginId(options.expectedPluginId);
  if (expectedPluginId && pluginId !== expectedPluginId) {
    throw new Error(`插件清单 id 与索引不一致: ${pluginId || '空'} / ${expectedPluginId}`);
  }

  const root = resolve(ensurePluginRoot());
  const existingPlugin = findPlugin(pluginId);
  const targetDirectory = existingPlugin
    ? resolve(existingPlugin.directory)
    : resolve(root, pluginId);
  if (!isPathInside(root, targetDirectory) || targetDirectory === root) {
    throw new Error('插件安装目录非法');
  }

  const stagingParent = mkdtempSync(join(tmpdir(), 'echo-plugin-install-'));
  const stagingDirectory = join(stagingParent, pluginId);
  try {
    const enableAfterInstall = Boolean(options.enableAfterInstall);
    cpSync(sourceDirectory, stagingDirectory, { recursive: true });
    const descriptor = toDescriptor(stagingDirectory, pluginId, {
      ...getEnabledState(),
      ...(enableAfterInstall ? { [pluginId]: true } : {}),
    });
    if (descriptor.invalid) throw new Error(descriptor.error || '插件清单无效');
    if (!descriptor.compatibility.compatible) {
      throw new Error(descriptor.compatibility.message || '插件与当前 EchoMusic 版本不兼容');
    }

    const nextState = getEnabledState();
    const wasEnabled = Boolean(nextState[pluginId]);
    if (enableAfterInstall) nextState[pluginId] = true;
    terminatePluginProcesses(pluginId);
    rmSync(targetDirectory, { recursive: true, force: true });
    cpSync(stagingDirectory, targetDirectory, { recursive: true });
    if (!existingPlugin) setPluginInstalledAt(pluginId, Date.now());
    if (wasEnabled && !enableAfterInstall) nextState[pluginId] = true;
    setEnabledState(nextState);

    const installed = findPlugin(pluginId);
    if (!installed) throw new Error('插件安装后扫描失败');
    return {
      plugin: installed,
      updated: Boolean(existingPlugin),
      enabled: Boolean(nextState[pluginId]),
    };
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
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

    const tempDirectory = mkdtempSync(join(tmpdir(), 'echo-plugin-download-'));
    try {
      let sourceDirectory = '';
      let installMethod: 'tree' | 'archive' = 'tree';
      let treeError: Error | null = null;

      // 优先尝试 Tree 模式（逐文件下载，更稳定）
      try {
        log.info('[PluginMarketplace] attempting tree install (file-by-file download)', {
          sourceId,
          pluginId: plugin.id,
        });
        sourceDirectory = await prepareMarketplaceTreeInstallDirectory(
          plugin,
          tempDirectory,
          options.githubProxyUrl,
        );
        installMethod = 'tree';
        log.info('[PluginMarketplace] tree install succeeded', {
          sourceId,
          pluginId: plugin.id,
        });
      } catch (error) {
        treeError = error instanceof Error ? error : new Error(String(error));
        log.warn('[PluginMarketplace] tree install failed, will try archive fallback', {
          sourceId,
          pluginId: plugin.id,
          error: treeError.message,
        });
      }

      // Tree 失败时回退到 Archive 模式（压缩包下载+解压）
      if (!sourceDirectory) {
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
          mkdirSync(extractDirectory, { recursive: true });
          await extractMarketplacePackage(zipPath, extractDirectory, plugin);
          sourceDirectory = findPluginInstallSourceDirectory(extractDirectory, plugin.packagePath);
          installMethod = 'archive';
          log.info('[PluginMarketplace] archive install succeeded', {
            sourceId,
            pluginId: plugin.id,
          });
        } catch (archiveError) {
          // 两种方式都失败，抛出更详细的错误信息
          const archiveMsg =
            archiveError instanceof Error ? archiveError.message : String(archiveError);
          const treeMsg = treeError?.message || '未知错误';
          throw new Error(`插件安装失败。Tree 模式: ${treeMsg}；Archive 模式: ${archiveMsg}`);
        }
      }

      log.info('[PluginMarketplace] install apply started', {
        sourceId,
        pluginId: plugin.id,
        method: installMethod,
      });
      const installed = installPluginDirectory(sourceDirectory, {
        expectedPluginId: plugin.id,
        enableAfterInstall: Boolean(options.enableAfterInstall),
      });
      log.info('[PluginMarketplace] install succeeded', {
        sourceId,
        pluginId: installed.plugin.id,
        updated: installed.updated,
        enabled: installed.enabled,
      });
      return { ok: true, ...installed };
    } finally {
      removeTemporaryDirectory(tempDirectory);
    }
  } catch (error) {
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

const normalizeLocalInstallPaths = (paths: unknown) => {
  if (!Array.isArray(paths)) return [];
  return Array.from(
    new Set(paths.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)),
  );
};

const getLocalInstallSource = (
  sourcePath: string,
): { path: string; kind: PluginLocalInstallSourceKind; stats: Stats } => {
  const resolvedPath = realpathSync(resolve(sourcePath));
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) return { path: resolvedPath, kind: 'directory', stats };
  if (stats.isFile() && extname(resolvedPath).toLowerCase() === '.zip') {
    return { path: resolvedPath, kind: 'zip', stats };
  }
  throw new Error('仅支持 .zip 插件压缩包或插件文件夹');
};

const installPluginFromLocalSource = async (
  inputPath: string,
  options: PluginLocalInstallOptions,
): Promise<PluginLocalInstallItemResult> => {
  const sourcePath = String(inputPath ?? '').trim();
  let kind: PluginLocalInstallItemResult['kind'] = 'unknown';

  try {
    if (!sourcePath) throw new Error('插件路径为空');
    const source = getLocalInstallSource(sourcePath);
    kind = source.kind;

    if (source.kind === 'directory') {
      const sourceDirectory = findPluginInstallSourceDirectory(source.path, '');
      const installed = installPluginDirectory(sourceDirectory, {
        enableAfterInstall: Boolean(options.enableAfterInstall),
      });
      return {
        ok: true,
        sourcePath: source.path,
        kind,
        ...installed,
      };
    }

    if (source.stats.size > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
      throw new Error('插件安装包超过 80 MB');
    }

    const tempDirectory = mkdtempSync(join(tmpdir(), 'echo-plugin-local-'));
    try {
      const extractDirectory = join(tempDirectory, 'extracted');
      mkdirSync(extractDirectory, { recursive: true });
      await extractZip(source.path, { dir: extractDirectory });
      const sourceDirectory = findPluginInstallSourceDirectory(extractDirectory, '');
      const installed = installPluginDirectory(sourceDirectory, {
        enableAfterInstall: Boolean(options.enableAfterInstall),
      });
      return {
        ok: true,
        sourcePath: source.path,
        kind,
        ...installed,
      };
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      ok: false,
      sourcePath,
      kind,
      error: error instanceof Error ? error.message : '插件安装失败',
    };
  }
};

export const installPluginsFromLocal = async (
  paths: string[],
  options: PluginLocalInstallOptions = {},
): Promise<PluginLocalInstallResult> => {
  const sourcePaths = normalizeLocalInstallPaths(paths);
  const results: PluginLocalInstallItemResult[] = [];

  for (const sourcePath of sourcePaths) {
    results.push(await installPluginFromLocalSource(sourcePath, options));
  }

  const installed = results.filter((result) => result.ok).length;
  const failed = results.length - installed;

  return {
    ok: results.length > 0 && failed === 0,
    results,
    installed,
    failed,
  };
};

const toPortableRelativePath = (parent: string, target: string) =>
  relative(parent, target).replace(/\\/g, '/');

const hashFileSha256 = (filePath: string) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const normalizePluginProcessArgs = (args: unknown) => {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) throw new Error('进程参数必须是字符串数组');
  if (args.length > MAX_PLUGIN_PROCESS_ARGS) {
    throw new Error(`进程参数不能超过 ${MAX_PLUGIN_PROCESS_ARGS} 个`);
  }

  return args.map((arg) => {
    if (typeof arg !== 'string') throw new Error('进程参数必须是字符串数组');
    if (arg.includes('\0')) throw new Error('进程参数不能包含空字符');
    if (arg.length > MAX_PLUGIN_PROCESS_ARG_LENGTH) {
      throw new Error(`单个进程参数不能超过 ${MAX_PLUGIN_PROCESS_ARG_LENGTH} 个字符`);
    }
    return arg;
  });
};

const isBlockedPluginProcessEnvKey = (key: string) =>
  BLOCKED_PLUGIN_PROCESS_ENV_KEYS.has(key.toUpperCase());

const buildPluginProcessEnv = (
  plugin: EchoPluginDescriptor,
  pluginRoot: string,
  customEnv: unknown,
) => {
  const env = Object.entries(process.env).reduce<Record<string, string>>(
    (nextEnv, [key, value]) => {
      if (value !== undefined && !isBlockedPluginProcessEnvKey(key)) nextEnv[key] = value;
      return nextEnv;
    },
    {},
  );
  env.ECHOMUSIC_PLUGIN_ID = plugin.id;
  env.ECHOMUSIC_PLUGIN_DIR = pluginRoot;

  if (customEnv === undefined || customEnv === null) return env;
  if (typeof customEnv !== 'object' || Array.isArray(customEnv)) {
    throw new Error('进程环境变量必须是对象');
  }

  const entries = Object.entries(customEnv as Record<string, unknown>);
  if (entries.length > MAX_PLUGIN_PROCESS_ENV_ENTRIES) {
    throw new Error(`进程环境变量不能超过 ${MAX_PLUGIN_PROCESS_ENV_ENTRIES} 项`);
  }

  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名非法: ${rawKey}`);
    if (isBlockedPluginProcessEnvKey(key)) continue;
    if (rawValue === undefined || rawValue === null) {
      delete env[key];
      continue;
    }

    const value = String(rawValue);
    if (value.includes('\0')) throw new Error(`环境变量 ${key} 不能包含空字符`);
    if (value.length > MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH) {
      throw new Error(`环境变量 ${key} 不能超过 ${MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH} 个字符`);
    }
    env[key] = value;
  }

  return env;
};

const resolvePluginProcessPath = (
  plugin: EchoPluginDescriptor,
  value: unknown,
  options: { kind: 'file' | 'directory'; label: string },
) => {
  const input = String(value ?? '').trim();
  if (!input) throw new Error(`${options.label}不能为空`);
  if (input.includes('\0')) throw new Error(`${options.label}不能包含空字符`);

  const resolvedPath = resolvePluginFile(plugin.directory, input);
  if (!resolvedPath) throw new Error(`${options.label}必须位于插件目录内`);
  if (!existsSync(resolvedPath)) throw new Error(`${options.label}不存在`);

  const pluginRoot = realpathSync(plugin.directory);
  const realPath = realpathSync(resolvedPath);
  if (!isPathInside(pluginRoot, realPath)) throw new Error(`${options.label}必须位于插件目录内`);

  const stats = statSync(realPath);
  if (options.kind === 'file' && !stats.isFile()) throw new Error(`${options.label}必须是文件`);
  if (options.kind === 'directory' && !stats.isDirectory()) {
    throw new Error(`${options.label}必须是文件夹`);
  }

  return { pluginRoot, realPath, stats };
};

const resolvePluginProcessLaunch = (plugin: EchoPluginDescriptor, options: unknown) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('进程启动参数必须是对象');
  }

  const launchOptions = options as PluginProcessLaunchOptions;
  const executable = resolvePluginProcessPath(plugin, launchOptions.executable, {
    kind: 'file',
    label: '可执行程序路径',
  });
  const executableExt = extname(executable.realPath).toLowerCase();

  if (process.platform === 'win32' && !WINDOWS_EXECUTABLE_EXTENSIONS.has(executableExt)) {
    throw new Error('Windows 插件进程只支持 .exe 或 .com 可执行文件');
  }
  if (process.platform !== 'win32' && (executable.stats.mode & 0o111) === 0) {
    throw new Error('可执行程序缺少执行权限');
  }

  const cwd =
    launchOptions.cwd === undefined || launchOptions.cwd === null || launchOptions.cwd === ''
      ? { pluginRoot: executable.pluginRoot, realPath: executable.pluginRoot }
      : resolvePluginProcessPath(plugin, launchOptions.cwd, {
          kind: 'directory',
          label: '工作目录',
        });

  if (!isPathInside(executable.pluginRoot, cwd.realPath)) {
    throw new Error('工作目录必须位于插件目录内');
  }

  const args = normalizePluginProcessArgs(launchOptions.args);
  const env = buildPluginProcessEnv(plugin, executable.pluginRoot, launchOptions.env);
  const executableRelativePath = toPortableRelativePath(executable.pluginRoot, executable.realPath);

  return {
    executablePath: executable.realPath,
    executableRelativePath,
    executableHash: hashFileSha256(executable.realPath),
    cwd: cwd.realPath,
    args,
    env,
  };
};

const getPluginProcessConsents = (): PluginProcessConsents => {
  const saved = getKvStorage().get<PluginProcessConsents>(PLUGIN_PROCESS_CONSENTS_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};

  return Object.entries(saved).reduce<PluginProcessConsents>((consents, [key, consent]) => {
    if (!consent || typeof consent !== 'object') return consents;
    const normalizedPluginId = normalizePluginId(consent.pluginId);
    const executable = String(consent.executable || '').trim();
    const executableHash = String(consent.executableHash || '').trim();
    if (!normalizedPluginId || !executable || !/^[a-f0-9]{64}$/i.test(executableHash)) {
      return consents;
    }
    consents[key] = {
      pluginId: normalizedPluginId,
      pluginVersion: String(consent.pluginVersion || ''),
      executable,
      executableHash: executableHash.toLowerCase(),
      grantedAt: Number(consent.grantedAt) || Date.now(),
    };
    return consents;
  }, {});
};

const setPluginProcessConsents = (consents: PluginProcessConsents) => {
  getKvStorage().set(PLUGIN_PROCESS_CONSENTS_KEY, consents);
};

const getPluginProcessConsentKey = (pluginId: string, executable: string) =>
  `${normalizePluginId(pluginId)}:${executable}`;

const hasPluginProcessConsent = (
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  const consent = getPluginProcessConsents()[getPluginProcessConsentKey(plugin.id, executable)];
  return (
    consent?.pluginId === plugin.id &&
    consent.pluginVersion === plugin.version &&
    consent.executable === executable &&
    consent.executableHash === executableHash
  );
};

const rememberPluginProcessConsent = (
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  const consents = getPluginProcessConsents();
  consents[getPluginProcessConsentKey(plugin.id, executable)] = {
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    executable,
    executableHash,
    grantedAt: Date.now(),
  };
  setPluginProcessConsents(consents);
};

const clearPluginProcessConsents = (pluginId: string) => {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) return;
  const consents = getPluginProcessConsents();
  let changed = false;
  for (const [key, consent] of Object.entries(consents)) {
    if (consent.pluginId !== normalizedPluginId) continue;
    delete consents[key];
    changed = true;
  }
  if (changed) setPluginProcessConsents(consents);
};

const confirmPluginProcessLaunch = async (
  owner: BrowserWindow | null | undefined,
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  if (hasPluginProcessConsent(plugin, executable, executableHash)) return true;

  const options = {
    type: 'warning' as const,
    title: '允许插件启动本地程序？',
    message: `${plugin.name} 想启动插件目录内的可执行程序`,
    detail: [
      `插件: ${plugin.name} (${plugin.id})`,
      `程序: ${executable}`,
      '',
      '该文件位于插件目录内，但启动后的程序将拥有与你当前账户相同的系统权限，可能访问本机文件、网络和系统资源。仅在你信任该插件来源时允许。',
      '插件更新、版本变化或程序文件变化后会重新请求确认。',
    ].join('\n'),
    buttons: ['允许并记住', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: true,
  };
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);

  if (result.response !== 0) return false;
  rememberPluginProcessConsent(plugin, executable, executableHash);
  return true;
};

export const terminatePluginProcess = (
  pluginId: string,
  pid: number,
): PluginProcessTerminateResult => {
  const normalizedPluginId = normalizePluginId(pluginId);
  const normalizedPid = Math.trunc(Number(pid));
  if (!normalizedPluginId || !Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return { ok: false, error: '进程 ID 非法' };
  }

  const record = pluginProcesses.get(normalizedPid);
  if (!record || record.pluginId !== normalizedPluginId) {
    return { ok: false, error: '插件进程不存在' };
  }

  try {
    const terminated = record.child.kill();
    if (terminated) pluginProcesses.delete(normalizedPid);
    return { ok: true, pid: normalizedPid, terminated };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件进程终止失败',
    };
  }
};

export const terminatePluginProcesses = (pluginId?: string) => {
  const normalizedPluginId = pluginId ? normalizePluginId(pluginId) : '';
  for (const [pid, record] of Array.from(pluginProcesses.entries())) {
    if (normalizedPluginId && record.pluginId !== normalizedPluginId) continue;
    try {
      record.child.kill();
    } catch (error) {
      log.warn('[Plugin] Failed to terminate plugin process', {
        pluginId: record.pluginId,
        pid,
        error,
      });
    } finally {
      pluginProcesses.delete(pid);
    }
  }
};

app.once('before-quit', () => terminatePluginProcesses());

export const launchPluginProcess = async (
  pluginId: string,
  options: PluginProcessLaunchOptions,
  owner?: BrowserWindow | null,
): Promise<PluginProcessLaunchResult> => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };

  const plugin = findPlugin(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };

  const compatibilityError = getPluginCompatibilityError(plugin);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  if (!plugin.enabled) return { ok: false, error: '插件未启用' };
  if (plugin.manifest.capabilities?.process !== true) {
    return { ok: false, error: '插件未声明本地进程能力' };
  }

  try {
    const launch = resolvePluginProcessLaunch(plugin, options);
    const allowed = await confirmPluginProcessLaunch(
      owner,
      plugin,
      launch.executableRelativePath,
      launch.executableHash,
    );
    if (!allowed) return { ok: false, error: '用户已取消启动本地程序', canceled: true };

    const child = spawn(launch.executablePath, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const startedAt = Date.now();
    let trackedPid = 0;
    let processFinished = false;
    const forgetProcess = () => {
      processFinished = true;
      if (trackedPid > 0) pluginProcesses.delete(trackedPid);
    };
    child.once('exit', forgetProcess);
    child.once('error', (error) => {
      if (trackedPid > 0) {
        log.warn('[Plugin] Plugin process failed', {
          pluginId: plugin.id,
          executable: launch.executableRelativePath,
          pid: trackedPid,
          error,
        });
      }
      forgetProcess();
    });

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolveSpawn();
      };
      const onError = (error: Error) => {
        child.removeListener('spawn', onSpawn);
        rejectSpawn(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    const pid = Number(child.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      child.kill();
      return { ok: false, error: '插件进程启动失败' };
    }

    trackedPid = pid;
    pluginProcesses.set(pid, {
      pluginId: plugin.id,
      executable: launch.executableRelativePath,
      child,
      startedAt,
    });
    if (processFinished) pluginProcesses.delete(pid);

    return {
      ok: true,
      pid,
      executable: launch.executableRelativePath,
      cwd: launch.cwd,
      startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件进程启动失败',
    };
  }
};

export const getPluginWindowDescriptor = (pluginId: string, windowId: string) => {
  const plugin = findPlugin(pluginId);
  if (!plugin || plugin.invalid || !plugin.compatibility.compatible || !plugin.enabled) return null;
  const normalizedWindowId = normalizePluginId(windowId);
  return plugin.windows.find((item) => item.id === normalizedWindowId) ?? null;
};

export const setPluginEnabled = (pluginId: string, enabled: boolean): PluginSetEnabledResult => {
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
  if (!enabled) terminatePluginProcesses(plugin.id);
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

const normalizeImageScanLimit = (limit: unknown) => {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return 200;
  return Math.min(Math.floor(value), MAX_PLUGIN_IMAGE_SCAN_LIMIT);
};

const normalizeFileScanLimit = (limit: unknown) => {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PLUGIN_FILE_SCAN_LIMIT;
  return Math.min(Math.floor(value), MAX_PLUGIN_FILE_SCAN_LIMIT);
};

const normalizeFileScanDepth = (depth: unknown) => {
  const value = Number(depth);
  if (!Number.isFinite(value) || value < 0) return 32;
  return Math.min(Math.floor(value), 64);
};

const normalizePluginFileExtension = (value: unknown) => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return '';
  return text.startsWith('.') ? text : `.${text}`;
};

const normalizePluginFileExtensions = (extensions: unknown) => {
  if (!Array.isArray(extensions)) return new Set<string>();
  return new Set(
    extensions
      .map(normalizePluginFileExtension)
      .filter((extension) => /^\.[a-z0-9]+$/i.test(extension)),
  );
};

const getPluginFileKind = (extension: string): PluginFileKind => {
  if (PLUGIN_AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (PLUGIN_IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (PLUGIN_LYRIC_EXTENSIONS.has(extension)) return 'lyric';
  if (PLUGIN_PLAYLIST_EXTENSIONS.has(extension)) return 'playlist';
  if (PLUGIN_CUE_EXTENSIONS.has(extension)) return 'cue';
  return 'other';
};

const normalizePluginFileKinds = (kinds: unknown) => {
  const validKinds = new Set<PluginFileKind>([
    'audio',
    'image',
    'lyric',
    'playlist',
    'cue',
    'other',
  ]);
  if (!Array.isArray(kinds)) return new Set<PluginFileKind>();
  return new Set(
    kinds
      .map((kind) => String(kind ?? '').trim())
      .filter((kind): kind is PluginFileKind => validKinds.has(kind as PluginFileKind)),
  );
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

const getLocalFileStats = (filePath: string) => {
  const input = String(filePath || '').trim();
  if (!input) throw new Error('文件路径为空');
  const resolvedPath = realpathSync(resolve(input));
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) throw new Error('路径不是文件');
  return { path: resolvedPath, stats };
};

const toPluginFileEntry = (root: string, filePath: string, stats: Stats): PluginFileEntry => {
  const extension = extname(filePath).toLowerCase();
  return {
    name: basename(filePath),
    path: filePath,
    url: pathToFileURL(filePath).toString(),
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    kind: getPluginFileKind(extension),
    extension,
    relativePath: toPortableRelativePath(root, filePath),
  };
};

export const listPluginFiles = (
  pluginId: string,
  directoryPath: string,
  options: PluginListFilesOptions = {},
): PluginListFilesResult => {
  const access = hasPluginLocalFilesAccess(pluginId);
  if (!access.ok) return { ok: false, error: access.error };

  try {
    const input = String(directoryPath || '').trim();
    if (!input) return { ok: false, error: '文件夹路径为空' };
    const root = realpathSync(resolve(input));
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) return { ok: false, error: '路径不是文件夹' };

    const recursive = Boolean(options.recursive);
    const includeHidden = Boolean(options.includeHidden);
    const limit = normalizeFileScanLimit(options.limit);
    const maxDepth = normalizeFileScanDepth(options.maxDepth);
    const kinds = normalizePluginFileKinds(options.kinds);
    const extensions = normalizePluginFileExtensions(options.extensions);
    const files: PluginFileEntry[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let limitReached = false;

    const shouldIncludeFile = (entry: PluginFileEntry) => {
      if (extensions.size > 0) {
        if (!extensions.has(entry.extension)) return false;
        return kinds.size > 0 ? kinds.has(entry.kind) : true;
      }
      if (kinds.size > 0) return kinds.has(entry.kind);
      return entry.kind !== 'other';
    };

    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift()!;
      for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const fullPath = join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (recursive && current.depth < maxDepth) {
            queue.push({ directory: fullPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = statSync(fullPath);
        const item = toPluginFileEntry(root, fullPath, stats);
        if (!shouldIncludeFile(item)) continue;
        files.push(item);
        if (files.length >= limit) {
          limitReached = true;
          break;
        }
      }
    }

    files.sort((left, right) => comparePluginText(left.relativePath, right.relativePath));
    return { ok: true, root, files, limitReached };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '文件夹读取失败',
    };
  }
};

export const listPluginImageFiles = (
  directoryPath: string,
  options: PluginListImageFilesOptions = {},
): PluginListImageFilesResult => {
  try {
    const root = resolve(String(directoryPath || '').trim());
    if (!root || !existsSync(root)) return { ok: false, error: '图片文件夹不存在' };
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) return { ok: false, error: '路径不是文件夹' };

    const recursive = Boolean(options.recursive);
    const limit = normalizeImageScanLimit(options.limit);
    const files: PluginImageFileEntry[] = [];
    const queue = [root];

    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive) queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !PLUGIN_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          continue;
        }
        const stats = statSync(fullPath);
        files.push({
          name: entry.name,
          path: fullPath,
          url: pathToFileURL(fullPath).toString(),
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        });
        if (files.length >= limit) break;
      }
    }

    files.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    return { ok: true, files };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '图片文件夹读取失败',
    };
  }
};

export const getPluginFileUrl = (filePath: string): PluginFileUrlResult => {
  try {
    const resolvedPath = resolve(String(filePath || '').trim());
    if (!resolvedPath || !existsSync(resolvedPath)) return { ok: false, error: '文件不存在' };
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) return { ok: false, error: '路径不是文件' };
    return { ok: true, url: pathToFileURL(resolvedPath).toString() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '文件地址解析失败',
    };
  }
};

const normalizePluginReadOffset = (value: unknown, size: number) => {
  const offset = Math.trunc(Number(value) || 0);
  return clamp(offset, 0, Math.max(0, size));
};

const normalizePluginReadLength = (
  options: PluginReadTextFileOptions | PluginReadFileBytesOptions,
  size: number,
  offset: number,
) => {
  const maxBytes = clamp(
    Math.trunc(Number(options.maxBytes) || DEFAULT_PLUGIN_READ_BYTES),
    1,
    MAX_PLUGIN_READ_BYTES,
  );
  const requestedLength =
    options.length === undefined || options.length === null
      ? maxBytes
      : Math.trunc(Number(options.length) || 0);
  return clamp(requestedLength, 0, Math.min(maxBytes, Math.max(0, size - offset)));
};

const readPluginFileChunk = (
  filePath: string,
  options: PluginReadTextFileOptions | PluginReadFileBytesOptions = {},
) => {
  const file = getLocalFileStats(filePath);
  const offset = normalizePluginReadOffset(options.offset, file.stats.size);
  const length = normalizePluginReadLength(options, file.stats.size, offset);
  const buffer = Buffer.alloc(length);
  let fd: number | null = null;
  try {
    fd = openSync(file.path, 'r');
    const bytesRead = length > 0 ? readSync(fd, buffer, 0, length, offset) : 0;
    return {
      ...file,
      buffer: buffer.subarray(0, bytesRead),
      bytesRead,
      truncated: offset + bytesRead < file.stats.size,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const normalizePluginTextEncoding = (encoding: PluginReadTextFileOptions['encoding']) => {
  const normalized = String(encoding || 'utf8').toLowerCase();
  if (normalized === 'utf-8') return 'utf8';
  if (normalized === 'ucs-2') return 'ucs2';
  if (
    normalized === 'utf8' ||
    normalized === 'utf16le' ||
    normalized === 'ucs2' ||
    normalized === 'latin1' ||
    normalized === 'ascii'
  ) {
    return normalized;
  }
  return 'utf8';
};

export const readPluginTextFile = (
  pluginId: string,
  filePath: string,
  options: PluginReadTextFileOptions = {},
): PluginReadTextFileResult => {
  const access = hasPluginLocalFilesAccess(pluginId);
  if (!access.ok) return { ok: false, error: access.error };

  try {
    const chunk = readPluginFileChunk(filePath, options);
    const entry = toPluginFileEntry(chunk.path, chunk.path, chunk.stats);
    return {
      ok: true,
      name: entry.name,
      path: entry.path,
      url: entry.url,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      content: chunk.buffer.toString(normalizePluginTextEncoding(options.encoding)),
      bytesRead: chunk.bytesRead,
      truncated: chunk.truncated,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '文件读取失败',
    };
  }
};

export const readPluginFileBytes = (
  pluginId: string,
  filePath: string,
  options: PluginReadFileBytesOptions = {},
): PluginReadFileBytesResult => {
  const access = hasPluginLocalFilesAccess(pluginId);
  if (!access.ok) return { ok: false, error: access.error };

  try {
    const chunk = readPluginFileChunk(filePath, options);
    const entry = toPluginFileEntry(chunk.path, chunk.path, chunk.stats);
    const data = chunk.buffer.buffer.slice(
      chunk.buffer.byteOffset,
      chunk.buffer.byteOffset + chunk.bytesRead,
    );
    return {
      ok: true,
      name: entry.name,
      path: entry.path,
      url: entry.url,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      data,
      bytesRead: chunk.bytesRead,
      truncated: chunk.truncated,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '文件读取失败',
    };
  }
};

const normalizePluginWriteEncoding = (encoding: PluginWriteFileOptions['encoding']) => {
  const normalized = String(encoding || 'utf8').toLowerCase();
  if (normalized === 'utf-8') return 'utf8';
  if (normalized === 'ucs-2') return 'ucs2';
  if (
    normalized === 'utf8' ||
    normalized === 'utf16le' ||
    normalized === 'ucs2' ||
    normalized === 'latin1' ||
    normalized === 'ascii' ||
    normalized === 'base64'
  ) {
    return normalized;
  }
  return 'utf8';
};

const normalizePluginWriteBuffer = (data: PluginWriteFileData, options: PluginWriteFileOptions) => {
  if (typeof data === 'string') {
    return Buffer.from(data, normalizePluginWriteEncoding(options.encoding));
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data && typeof data === 'object' && data.type === 'base64') {
    return Buffer.from(String(data.data || ''), 'base64');
  }

  throw new Error('写入内容必须是字符串、ArrayBuffer、Uint8Array 或 base64 对象');
};

const resolvePluginWritableFile = (
  plugin: EchoPluginDescriptor,
  filePath: string,
  options: PluginWriteFileOptions,
) => {
  const input = String(filePath || '').trim();
  if (!input) throw new Error('文件路径为空');
  if (input.includes('\0')) throw new Error('文件路径不能包含空字符');

  const targetPath = resolvePluginFile(plugin.directory, input);
  if (!targetPath) throw new Error('写入路径必须位于插件目录内');

  const pluginRoot = realpathSync(plugin.directory);
  const parentPath = dirname(targetPath);
  if (options.createDirectories !== false) {
    mkdirSync(parentPath, { recursive: true });
  }

  const parentRealPath = realpathSync(parentPath);
  if (!isPathInside(pluginRoot, parentRealPath)) throw new Error('写入路径必须位于插件目录内');
  if (existsSync(targetPath)) {
    const targetRealPath = realpathSync(targetPath);
    if (!isPathInside(pluginRoot, targetRealPath)) throw new Error('写入路径必须位于插件目录内');
    const stats = statSync(targetPath);
    if (!stats.isFile()) throw new Error('写入路径不是文件');
    if (options.overwrite !== true) throw new Error('文件已存在');
  }

  return { pluginRoot, targetPath };
};

export const writePluginFile = (
  pluginId: string,
  filePath: string,
  data: PluginWriteFileData,
  options: PluginWriteFileOptions = {},
): PluginWriteFileResult => {
  const access = hasPluginLocalFilesAccess(pluginId);
  if (!access.ok) return { ok: false, error: access.error };

  try {
    const buffer = normalizePluginWriteBuffer(data, options);
    if (buffer.byteLength > MAX_PLUGIN_WRITE_BYTES) {
      return {
        ok: false,
        error: `写入内容不能超过 ${Math.round(MAX_PLUGIN_WRITE_BYTES / 1024 / 1024)} MB`,
      };
    }

    const target = resolvePluginWritableFile(access.plugin, filePath, options);
    writeFileSync(target.targetPath, buffer, { flag: options.overwrite === true ? 'w' : 'wx' });
    const stats = statSync(target.targetPath);
    const entry = toPluginFileEntry(target.pluginRoot, target.targetPath, stats);
    return {
      ok: true,
      name: entry.name,
      path: entry.path,
      url: entry.url,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      bytesWritten: buffer.byteLength,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '文件写入失败',
    };
  }
};

export const uninstallPlugin = (pluginId: string): PluginUninstallResult => {
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
    terminatePluginProcesses(plugin.id);
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
