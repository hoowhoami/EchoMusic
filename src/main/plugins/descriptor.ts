import { app } from 'electron';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { pathToFileURL } from 'url';
import {
  coerce as semverCoerce,
  satisfies as semverSatisfies,
  valid as semverValid,
  validRange as semverValidRange,
} from 'semver';
import type {
  EchoPluginCompatibility,
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginWindowDescriptor,
  PluginWindowManifest,
} from '../../shared/plugins';
import {
  BARE_SEMVER_PATTERN,
  PLUGIN_IMAGE_EXTENSIONS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_WINDOW_MAX_HEIGHT,
  PLUGIN_WINDOW_MAX_WIDTH,
  PLUGIN_WINDOW_MIN_HEIGHT,
  PLUGIN_WINDOW_MIN_WIDTH,
  clamp,
  normalizePluginId,
} from './common';
import { resolvePluginFile } from './path';

const isRemoteImageSource = (source: string) =>
  /^https?:\/\//i.test(source) || /^data:image\//i.test(source);

export const isSupportedPluginImage = (source: string) =>
  isRemoteImageSource(source) || PLUGIN_IMAGE_EXTENSIONS.has(extname(source).toLowerCase());

export const appendUrlCacheKey = (source: string, cacheKey: string) => {
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

export const getManifestIconSource = (manifest: EchoPluginManifest) => {
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

export const readManifest = (
  manifestPath: string,
): { manifest: EchoPluginManifest; error: string } => {
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
  if (
    capabilities.kugouVerification !== undefined &&
    typeof capabilities.kugouVerification !== 'boolean'
  ) {
    return 'manifest.capabilities.kugouVerification 必须是布尔值';
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
  if (capabilities.sqlite !== undefined && typeof capabilities.sqlite !== 'boolean') {
    return 'manifest.capabilities.sqlite 必须是布尔值';
  }
  if (capabilities.webServer !== undefined && typeof capabilities.webServer !== 'boolean') {
    return 'manifest.capabilities.webServer 必须是布尔值';
  }
  return '';
};

export const getEchoMusicCompatibility = (
  manifest: EchoPluginManifest,
): EchoPluginCompatibility => {
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

export const validateManifest = (manifest: EchoPluginManifest, manifestError: string) => {
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

export const toDescriptor = (
  directory: string,
  directoryName: string,
  enabledState: Record<string, boolean>,
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
  const missingMainWindow = windows.find((item) => !existsSync(item.mainFile));
  const missingStyleWindow = windows.find((item) => item.styleFile && !existsSync(item.styleFile));
  const invalidMainExtensionWindow = windows.find(
    (item) => !['.js', '.mjs'].includes(extname(item.mainFile).toLowerCase()),
  );
  const invalidStyleExtensionWindow = windows.find(
    (item) => item.styleFile && extname(item.styleFile).toLowerCase() !== '.css',
  );
  const missingWindowError =
    !validationError && !windowError
      ? (missingMainWindow && `插件窗口 ${missingMainWindow.id} 入口不存在`) ||
        (missingStyleWindow && `插件窗口 ${missingStyleWindow.id} 样式文件不存在`) ||
        ''
      : '';
  const windowExtensionError =
    !validationError && !windowError && !missingWindowError
      ? (invalidMainExtensionWindow &&
          `插件窗口 ${invalidMainExtensionWindow.id} 入口必须是 .js 或 .mjs`) ||
        (invalidStyleExtensionWindow &&
          `插件窗口 ${invalidStyleExtensionWindow.id} 样式必须是 .css`) ||
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
