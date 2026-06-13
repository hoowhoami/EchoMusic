import { app, nativeImage, shell, type BrowserWindow } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { PluginAppIconRefreshResult } from '../shared/plugins';
import { getKvStorage } from './storage/kv';
import log from './logger';

type AppIconTarget = 'tray' | 'taskbar' | 'desktop';

type PluginIconCandidate = {
  pluginId: string;
  directory: string;
  value: unknown;
};

type ResolvedPluginIcon = {
  path: string;
  pluginId: string;
};

type AppIconState = {
  trayIconPath: string | null;
  taskbarIconPath: string | null;
  desktopIconPath: string | null;
  trayPluginId: string | null;
  taskbarPluginId: string | null;
  desktopPluginId: string | null;
  desktopApplied: boolean;
  desktopError: string | null;
  taskbarShortcutApplied: boolean;
  taskbarShortcutError: string | null;
  initialized: boolean;
};

const PLUGIN_STATE_KEY = 'plugins:enabled';
const PLUGIN_INSTALL_TIMES_KEY = 'plugins:install-times';
const PLUGIN_MANIFEST_FILE = 'manifest.json';

const APP_ICON_CONFIG_KEYS = ['appIcons', 'appIcon', 'customAppIcons', 'customAppIcon'] as const;

const TRAY_ICON_STORAGE_KEYS = ['trayIconPath', 'trayIcon', 'trayPath'] as const;
const TASKBAR_ICON_STORAGE_KEYS = [
  'taskbarIconPath',
  'windowIconPath',
  'dockIconPath',
  'appIconPath',
  'taskbarIcon',
  'windowIcon',
  'dockIcon',
  'taskbarPath',
] as const;
const DESKTOP_ICON_STORAGE_KEYS = [
  'desktopIconPath',
  'desktopShortcutIconPath',
  'shortcutIconPath',
  'desktopIcon',
  'desktopShortcutIcon',
  'shortcutIcon',
  'desktopPath',
] as const;

const FALLBACK_ICON_STORAGE_KEYS = ['iconPath', 'icon'] as const;
const IMAGE_EXTENSIONS = new Set(['.bmp', '.ico', '.icns', '.jpg', '.jpeg', '.png', '.webp']);

let iconState: AppIconState = {
  trayIconPath: null,
  taskbarIconPath: null,
  desktopIconPath: null,
  trayPluginId: null,
  taskbarPluginId: null,
  desktopPluginId: null,
  desktopApplied: false,
  desktopError: null,
  taskbarShortcutApplied: false,
  taskbarShortcutError: null,
  initialized: false,
};

const normalizePluginId = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');

const isPathInside = (parent: string, target: string) => {
  const diff = relative(parent, target);
  return diff === '' || (!!diff && !diff.startsWith('..') && !isAbsolute(diff));
};

const getPluginStorageKey = (pluginId: string, key: string) =>
  `plugin:${normalizePluginId(pluginId)}:${String(key)}`;

const getPluginRoot = () => join(app.getPath('userData'), 'plugins');

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const normalizeIconPathValue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  const record = toRecord(value);
  if (!record) return '';
  for (const key of ['path', 'filePath', 'iconPath', 'file', 'url']) {
    const nested = normalizeIconPathValue(record[key]);
    if (nested) return nested;
  }
  return '';
};

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

const readPluginEntries = () => {
  const root = getPluginRoot();
  if (!existsSync(root)) return [];

  const enabledState = getKvStorage().get<Record<string, boolean>>(PLUGIN_STATE_KEY) ?? {};
  const installTimes = getKvStorage().get<Record<string, number>>(PLUGIN_INSTALL_TIMES_KEY) ?? {};

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, entry.name);
      const manifest = toRecord(readJsonFile(join(directory, PLUGIN_MANIFEST_FILE)));
      const id = normalizePluginId(manifest?.id) || normalizePluginId(entry.name);
      return {
        id,
        directory,
        enabled: Boolean(enabledState[id]),
        installedAt: Number(installTimes[id] ?? 0) || 0,
      };
    })
    .filter((entry) => entry.id && entry.enabled)
    .sort((left, right) => right.installedAt - left.installedAt || left.id.localeCompare(right.id));
};

const readPluginStorage = (pluginId: string, key: string) =>
  getKvStorage().get<unknown>(getPluginStorageKey(pluginId, key));

const pickConfigIconValue = (config: unknown, target: AppIconTarget): unknown => {
  const record = toRecord(config);
  if (!record || record.enabled === false) return '';
  const platformRecord = toRecord(record[process.platform]);
  if (platformRecord) {
    const platformValue = pickConfigIconValue(platformRecord, target);
    if (platformValue) return platformValue;
  }

  const keys =
    target === 'tray'
      ? ['trayIconPath', 'trayIcon', 'trayPath', 'tray']
      : target === 'taskbar'
        ? [
            'taskbarIconPath',
            'windowIconPath',
            'dockIconPath',
            'appIconPath',
            'taskbarIcon',
            'windowIcon',
            'dockIcon',
            'taskbar',
            'window',
            'dock',
          ]
        : [
            'desktopIconPath',
            'desktopShortcutIconPath',
            'shortcutIconPath',
            'desktopIcon',
            'desktopShortcutIcon',
            'shortcutIcon',
            'desktop',
            'shortcut',
          ];

  for (const key of [...keys, ...FALLBACK_ICON_STORAGE_KEYS]) {
    const value = normalizeIconPathValue(record[key]);
    if (value) return value;
  }
  return '';
};

const getIconCandidates = (target: AppIconTarget): PluginIconCandidate[] => {
  const candidates: PluginIconCandidate[] = [];
  for (const plugin of readPluginEntries()) {
    for (const key of APP_ICON_CONFIG_KEYS) {
      const value = pickConfigIconValue(readPluginStorage(plugin.id, key), target);
      if (value) candidates.push({ pluginId: plugin.id, directory: plugin.directory, value });
    }

    const storageKeys =
      target === 'tray'
        ? TRAY_ICON_STORAGE_KEYS
        : target === 'taskbar'
          ? TASKBAR_ICON_STORAGE_KEYS
          : DESKTOP_ICON_STORAGE_KEYS;
    for (const key of [...storageKeys, ...FALLBACK_ICON_STORAGE_KEYS]) {
      const value = normalizeIconPathValue(readPluginStorage(plugin.id, key));
      if (value) candidates.push({ pluginId: plugin.id, directory: plugin.directory, value });
    }
  }
  return candidates;
};

const resolveIconCandidatePath = (candidate: PluginIconCandidate): string => {
  const rawPath = normalizeIconPathValue(candidate.value);
  if (!rawPath) return '';

  let filePath = rawPath;
  if (/^file:\/\//i.test(filePath)) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      return '';
    }
  }

  if (!isAbsolute(filePath)) {
    const pluginRoot = resolve(candidate.directory);
    const resolvedPath = resolve(pluginRoot, filePath);
    if (!isPathInside(pluginRoot, resolvedPath)) return '';
    filePath = resolvedPath;
  }

  return filePath;
};

const isUsableIconFile = (filePath: string) => {
  const extension = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return false;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) return false;
    return !nativeImage.createFromPath(filePath).isEmpty();
  } catch {
    return false;
  }
};

const resolvePluginIcon = (target: AppIconTarget): ResolvedPluginIcon | null => {
  for (const candidate of getIconCandidates(target)) {
    const filePath = resolveIconCandidatePath(candidate);
    if (filePath && isUsableIconFile(filePath)) {
      return { path: filePath, pluginId: candidate.pluginId };
    }
    log.warn('[AppIcons] Ignored invalid plugin icon path', {
      pluginId: candidate.pluginId,
      target,
      path: filePath || candidate.value,
    });
  }
  return null;
};

export const isPluginAppIconStorageKey = (key: string) => {
  const normalizedKey = String(key ?? '').trim();
  return new Set<string>([
    ...APP_ICON_CONFIG_KEYS,
    ...TRAY_ICON_STORAGE_KEYS,
    ...TASKBAR_ICON_STORAGE_KEYS,
    ...DESKTOP_ICON_STORAGE_KEYS,
    ...FALLBACK_ICON_STORAGE_KEYS,
  ]).has(normalizedKey);
};

export const refreshAppIconConfig = (): PluginAppIconRefreshResult => {
  const trayIcon = resolvePluginIcon('tray');
  const taskbarIcon = resolvePluginIcon('taskbar');
  const desktopIcon = resolvePluginIcon('desktop');
  iconState = {
    trayIconPath: trayIcon?.path ?? null,
    taskbarIconPath: taskbarIcon?.path ?? null,
    desktopIconPath: desktopIcon?.path ?? null,
    trayPluginId: trayIcon?.pluginId ?? null,
    taskbarPluginId: taskbarIcon?.pluginId ?? null,
    desktopPluginId: desktopIcon?.pluginId ?? null,
    desktopApplied: false,
    desktopError: null,
    taskbarShortcutApplied: false,
    taskbarShortcutError: null,
    initialized: true,
  };

  log.info('[AppIcons] Refreshed plugin app icons', {
    trayPluginId: iconState.trayPluginId,
    taskbarPluginId: iconState.taskbarPluginId,
    desktopPluginId: iconState.desktopPluginId,
    hasTrayIcon: Boolean(iconState.trayIconPath),
    hasTaskbarIcon: Boolean(iconState.taskbarIconPath),
    hasDesktopIcon: Boolean(iconState.desktopIconPath),
  });

  return getAppIconRefreshResult();
};

export const ensureAppIconConfigLoaded = () => {
  if (!iconState.initialized) refreshAppIconConfig();
};

export const getAppIconRefreshResult = (): PluginAppIconRefreshResult => ({
  ok: true,
  trayIconPath: iconState.trayIconPath,
  taskbarIconPath: iconState.taskbarIconPath,
  windowIconPath: iconState.taskbarIconPath,
  desktopIconPath: iconState.desktopIconPath,
  trayPluginId: iconState.trayPluginId,
  taskbarPluginId: iconState.taskbarPluginId,
  windowPluginId: iconState.taskbarPluginId,
  desktopPluginId: iconState.desktopPluginId,
  desktopApplied: iconState.desktopApplied,
  desktopError: iconState.desktopError,
  taskbarShortcutApplied: iconState.taskbarShortcutApplied,
  taskbarShortcutError: iconState.taskbarShortcutError,
});

const getDefaultTrayIconName = () =>
  process.platform === 'darwin'
    ? 'IconTemplate.png'
    : process.platform === 'win32'
      ? 'win_tray_icon.ico'
      : 'linux_tray_icon.png';

const resolveDefaultIconPath = (iconName: string) => {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icons', iconName)
    : join(process.cwd(), 'build/icons', iconName);
  return existsSync(iconPath) ? iconPath : '';
};

export const resolveTrayIconPath = () => {
  ensureAppIconConfigLoaded();
  return iconState.trayIconPath || resolveDefaultIconPath(getDefaultTrayIconName());
};

export const resolveWindowIconPath = () => {
  ensureAppIconConfigLoaded();
  if (iconState.taskbarIconPath) return iconState.taskbarIconPath;
  const iconName =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
        ? 'icon.icns'
        : 'icon.png';
  return resolveDefaultIconPath(iconName);
};

export const applyWindowAppIcon = (mainWindow: BrowserWindow | null) => {
  const iconPath = resolveWindowIconPath();
  if (!iconPath) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIcon(iconPath);
    }
    if (process.platform === 'darwin') {
      app.dock?.setIcon(iconPath);
    }
  } catch (error) {
    log.warn('[AppIcons] Failed to apply window icon', { iconPath, error });
  }
};

const getWindowsShortcutCandidates = (kind: 'desktop' | 'taskbar') => {
  if (process.platform !== 'win32') return [];
  const names = Array.from(new Set([app.getName(), 'EchoMusic', 'echo-music'].filter(Boolean)));
  const directory =
    kind === 'desktop'
      ? app.getPath('desktop')
      : join(
          app.getPath('appData'),
          'Microsoft',
          'Internet Explorer',
          'Quick Launch',
          'User Pinned',
          'TaskBar',
        );
  return names.map((name) => join(directory, `${name}.lnk`));
};

const applyWindowsShortcutIcon = (kind: 'desktop' | 'taskbar', iconPath: string) => {
  const shortcutPath = getWindowsShortcutCandidates(kind).find((path) => existsSync(path));
  if (!shortcutPath) {
    return { applied: false, error: `${kind === 'desktop' ? '桌面' : '任务栏'}快捷方式不存在` };
  }

  try {
    let details: Electron.ShortcutDetails;
    try {
      details = shell.readShortcutLink(shortcutPath);
    } catch {
      details = {
        target: app.getPath('exe'),
        cwd: dirname(app.getPath('exe')),
        description: 'EchoMusic',
      };
    }
    const ok = shell.writeShortcutLink(shortcutPath, 'update', {
      ...details,
      target: details.target || app.getPath('exe'),
      icon: iconPath,
      iconIndex: 0,
      appUserModelId: 'com.hoowhoami.echomusic',
    });
    return ok ? { applied: true, error: null } : { applied: false, error: '快捷方式写入失败' };
  } catch (error) {
    return {
      applied: false,
      error: error instanceof Error ? error.message : '快捷方式写入失败',
    };
  }
};

const getLinuxDesktopEntryCandidates = () => {
  if (process.platform !== 'linux') return [];
  const desktopDir = app.getPath('desktop');
  if (!desktopDir || !existsSync(desktopDir)) return [];
  return readdirSync(desktopDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.desktop'))
    .map((entry) => join(desktopDir, entry.name));
};

const isEchoMusicDesktopEntry = (content: string) => {
  const lower = content.toLowerCase();
  return (
    /^Name\s*=\s*EchoMusic\s*$/im.test(content) ||
    lower.includes('echomusic') ||
    lower.includes(app.getPath('exe').toLowerCase())
  );
};

const applyLinuxDesktopEntryIcon = (iconPath: string) => {
  const desktopEntry = getLinuxDesktopEntryCandidates().find((filePath) => {
    try {
      return isEchoMusicDesktopEntry(readFileSync(filePath, 'utf8'));
    } catch {
      return false;
    }
  });
  if (!desktopEntry) return { applied: false, error: '桌面 .desktop 文件不存在' };

  try {
    const content = readFileSync(desktopEntry, 'utf8');
    const nextContent = /^Icon\s*=/im.test(content)
      ? content.replace(/^Icon\s*=.*$/im, `Icon=${iconPath}`)
      : content.replace(/\[Desktop Entry\]\s*/i, (match) => `${match}Icon=${iconPath}\n`);
    writeFileSync(desktopEntry, nextContent, 'utf8');
    return { applied: true, error: null };
  } catch (error) {
    return {
      applied: false,
      error: error instanceof Error ? error.message : '.desktop 文件写入失败',
    };
  }
};

export const applyDesktopAppIcon = () => {
  ensureAppIconConfigLoaded();
  if (!iconState.desktopIconPath) {
    iconState.desktopApplied = false;
    iconState.desktopError = null;
    return getAppIconRefreshResult();
  }

  const result =
    process.platform === 'win32'
      ? applyWindowsShortcutIcon('desktop', iconState.desktopIconPath)
      : process.platform === 'linux'
        ? applyLinuxDesktopEntryIcon(iconState.desktopIconPath)
        : { applied: false, error: '当前平台不支持运行时替换桌面图标' };

  iconState.desktopApplied = result.applied;
  iconState.desktopError = result.error;
  return getAppIconRefreshResult();
};

export const applyTaskbarShortcutIcon = () => {
  ensureAppIconConfigLoaded();
  if (!iconState.taskbarIconPath) {
    iconState.taskbarShortcutApplied = false;
    iconState.taskbarShortcutError = null;
    return getAppIconRefreshResult();
  }

  const result =
    process.platform === 'win32'
      ? applyWindowsShortcutIcon('taskbar', iconState.taskbarIconPath)
      : { applied: false, error: '当前平台不支持运行时替换任务栏快捷方式图标' };

  iconState.taskbarShortcutApplied = result.applied;
  iconState.taskbarShortcutError = result.error;
  return getAppIconRefreshResult();
};
