import { app, shell } from 'electron';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'path';
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
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
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
const PLUGIN_MANIFEST_FILE = 'manifest.json';
const PLUGIN_MARKETPLACE_INDEX_FILE = 'echo-plugins.json';
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
const MAX_PLUGIN_IMAGE_SCAN_LIMIT = 1000;
const PLUGIN_WINDOW_MIN_WIDTH = 180;
const PLUGIN_WINDOW_MIN_HEIGHT = 48;
const PLUGIN_WINDOW_MAX_WIDTH = 1400;
const PLUGIN_WINDOW_MAX_HEIGHT = 900;
const BARE_SEMVER_PATTERN = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  icon?: string;
  tags?: unknown;
  repo?: string;
  homepage?: string;
  downloadUrl?: string;
  path?: string;
  packagePath?: string;
  checksum?: string;
  sha256?: string;
  requires?: EchoPluginManifest['requires'];
};
type PluginMarketplaceCatalogPlugin = Omit<
  PluginMarketplacePlugin,
  'installed' | 'installedVersion' | 'updateAvailable' | 'compatibility'
>;
type PluginMarketplaceCache = {
  plugins: PluginMarketplaceCatalogPlugin[];
  fetchedAt: number;
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
    iconUrl:
      iconFile && existsSync(iconFile)
        ? pathToFileURL(iconFile).toString()
        : isRemoteImageSource(iconSource)
          ? iconSource
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
  if (!cache || !Array.isArray(cache.plugins)) return { plugins: [], fetchedAt: 0 };
  return {
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

const toRawGithubUrl = (repo: GithubRepository, filePath: string) => {
  const normalizedPath = normalizeMarketplacePackagePath(filePath);
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${normalizedPath}`;
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

const applyGithubProxyUrl = (url: string, githubProxyUrl?: string) => {
  const target = String(url || '').trim();
  const proxy = String(githubProxyUrl || '').trim();
  if (!target || !proxy || !/^https?:\/\//i.test(target) || !isGithubHostedUrl(target)) {
    return target;
  }
  return `${proxy.replace(/\/+$/, '')}/${target}`;
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
  Boolean(value) &&
  value !== '.' &&
  !value.split('/').includes('..') &&
  !value.startsWith('..') &&
  !isAbsolute(value);

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

const getMarketplaceEntryDownloadUrl = (
  sourceRepo: GithubRepository,
  entry: PluginMarketplaceIndexEntry,
) => {
  const explicitUrl = String(entry.downloadUrl || '').trim();
  if (/^https?:\/\//i.test(explicitUrl)) return explicitUrl;
  return toGithubArchiveUrl(sourceRepo);
};

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

const normalizeMarketplaceIndexPlugins = (
  source: PluginMarketplaceSource,
  index: PluginMarketplaceIndex,
) => {
  const sourceRepo = parseGithubRepository(source.url);
  if (!sourceRepo || !Array.isArray(index.plugins)) return [];

  const plugins: PluginMarketplaceCatalogPlugin[] = [];
  for (const rawEntry of index.plugins) {
    const pluginId = normalizePluginId(rawEntry?.id);
    const name = String(rawEntry?.name || pluginId).trim();
    const version = String(rawEntry?.version || '').trim();
    const packagePath = normalizeMarketplacePackagePath(rawEntry?.packagePath || rawEntry?.path);
    if (!pluginId || !name || !version || !isSafeMarketplacePackagePath(packagePath)) continue;

    const manifest: EchoPluginManifest = {
      id: pluginId,
      name,
      version,
      description: String(rawEntry.description || ''),
      author: String(rawEntry.author || ''),
      icon: String(rawEntry.icon || ''),
      requires: rawEntry.requires,
    };
    const repo = String(rawEntry.repo || '').trim() || source.url;
    const homepage = String(rawEntry.homepage || '').trim() || repo;
    const icon = String(rawEntry.icon || '').trim();
    const iconUrl = resolveMarketplaceAssetUrl(sourceRepo, packagePath, icon);

    plugins.push({
      id: pluginId,
      name,
      version,
      description: String(rawEntry.description || ''),
      author: String(rawEntry.author || ''),
      icon,
      iconUrl,
      tags: normalizeMarketplaceTags(rawEntry.tags),
      repo,
      homepage,
      downloadUrl: getMarketplaceEntryDownloadUrl(sourceRepo, rawEntry),
      packagePath,
      checksum: String(rawEntry.checksum || rawEntry.sha256 || '').trim(),
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      manifest,
    });
  }

  return plugins;
};

const fetchMarketplaceText = async (url: string, githubProxyUrl?: string) => {
  const targetUrl = applyGithubProxyUrl(url, githubProxyUrl);
  const response = await fetch(targetUrl, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'EchoMusic-Plugin-Marketplace',
    },
  });
  if (!response.ok) {
    throw new Error(`请求失败 (${response.status})`);
  }
  return response.text();
};

const fetchMarketplaceIndex = async (source: PluginMarketplaceSource, githubProxyUrl?: string) => {
  const sourceRepo = parseGithubRepository(source.url);
  if (!sourceRepo) throw new Error('仅支持 GitHub 仓库地址');
  const indexUrl = toRawGithubUrl(sourceRepo, PLUGIN_MARKETPLACE_INDEX_FILE);
  const raw = await fetchMarketplaceText(indexUrl, githubProxyUrl);
  const index = JSON.parse(raw) as PluginMarketplaceIndex;
  const plugins = normalizeMarketplaceIndexPlugins(source, index);
  if (plugins.length === 0) {
    throw new Error(`${PLUGIN_MARKETPLACE_INDEX_FILE} 未提供可用插件`);
  }
  return {
    index,
    plugins,
    indexUrl: toGithubBlobUrl(sourceRepo, PLUGIN_MARKETPLACE_INDEX_FILE),
  };
};

const fetchMarketplaceSourceCatalog = async (
  source: PluginMarketplaceSource,
  githubProxyUrl?: string,
) => {
  try {
    const result = await fetchMarketplaceIndex(source, githubProxyUrl);
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
        lastError: '',
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
      plugins: [] as PluginMarketplaceCatalogPlugin[],
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
) => {
  const enabledSources = sources.filter((source) => source.enabled);
  const fetched = await Promise.all(
    enabledSources.map((source) => fetchMarketplaceSourceCatalog(source, githubProxyUrl)),
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
    const refreshed = await refreshMarketplaceCatalog(sources, options.githubProxyUrl);
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
  const response = await fetch(downloadUrl, {
    headers: {
      Accept: 'application/zip,application/octet-stream,*/*',
      'User-Agent': 'EchoMusic-Plugin-Marketplace',
    },
  });
  if (!response.ok) throw new Error(`插件下载失败 (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxSize = 80 * 1024 * 1024;
  if (buffer.byteLength > maxSize) throw new Error('插件安装包超过 80 MB');

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

const installExtractedPluginDirectory = (
  plugin: PluginMarketplacePlugin,
  sourceDirectory: string,
  enableAfterInstall: boolean,
) => {
  const manifestResult = readManifest(join(sourceDirectory, PLUGIN_MANIFEST_FILE));
  if (manifestResult.error) throw new Error(manifestResult.error);
  const pluginId = normalizePluginId(manifestResult.manifest.id);
  if (!pluginId || pluginId !== plugin.id) {
    throw new Error(`插件清单 id 与索引不一致: ${pluginId || '空'} / ${plugin.id}`);
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
  try {
    const marketplace = await listPluginMarketplace({
      githubProxyUrl: options.githubProxyUrl,
      refresh: false,
    });
    const plugin = marketplace.plugins.find(
      (item) => item.sourceId === sourceId && item.id === normalizePluginId(pluginId),
    );
    if (!plugin) return { ok: false, error: '在线插件不存在，请刷新插件源后重试' };
    if (!plugin.compatibility.compatible) {
      return {
        ok: false,
        error: plugin.compatibility.message || '插件与当前 EchoMusic 版本不兼容',
      };
    }

    const tempDirectory = mkdtempSync(join(tmpdir(), 'echo-plugin-download-'));
    try {
      const zipPath = await downloadMarketplacePackage(
        plugin,
        tempDirectory,
        options.githubProxyUrl,
      );
      const extractDirectory = join(tempDirectory, 'extracted');
      mkdirSync(extractDirectory, { recursive: true });
      await extractZip(zipPath, { dir: extractDirectory });
      const sourceDirectory = findPluginInstallSourceDirectory(
        extractDirectory,
        plugin.packagePath,
      );
      const installed = installExtractedPluginDirectory(
        plugin,
        sourceDirectory,
        Boolean(options.enableAfterInstall),
      );
      return { ok: true, ...installed };
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
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
