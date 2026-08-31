import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import log from './logger';
import { getKvStorage } from './storage/kv';
import {
  getDesktopLyricPersistedSettings,
  patchDesktopLyricPersistedSettings,
  setMainAppSetting,
  setPersistedLogSettings,
  type MainAppSettings,
} from './storage/settings';
import { normalizeLogSettings, type AppLogLevel } from '../shared/logging';
import { getStorePersistenceKey } from '../shared/storePersistence';
import { isBlockedObjectKey } from '../shared/objectSafety';
import {
  SETTINGS_BACKUP_EXTENSION,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  sanitizePortableAppSettings,
  type PluginBackupCreateRequest,
  type PluginBackupCreateResult,
  type PluginBackupInspectRequest,
  type PluginBackupInspectResult,
  type PluginBackupRestoreRequest,
  type PluginBackupRestoreResult,
  type SettingsBackupExportRequest,
  type SettingsBackupExportResult,
  type SettingsBackupImportRequest,
  type SettingsBackupImportResult,
  type SettingsBackupInspectResult,
  type SettingsBackupScope,
  type SettingsBackupSummary,
} from '../shared/settingsBackup';
import {
  exportPluginEnabledPreference,
  exportPluginStorage,
  getPluginDescriptor,
  getPluginDirectory,
  getPluginSafeMode,
  installPluginsFromLocal,
  listPlugins,
  normalizePluginId,
  replacePluginEnabledPreference,
  replacePluginStorage,
  setPluginEnabled,
  terminatePluginProcesses,
} from './plugins';
import {
  closePluginSqliteDatabases,
  getPluginSqliteDirectory,
  snapshotPluginSqliteDatabases,
} from './plugins/sqlite';
import { closePluginWebServer } from './plugins/webServer';
import { assertBackupManifestMatchesPlugin } from '../shared/settingsBackupValidation';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 512 * 1024 * 1024;
const MAX_SETTINGS_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_COUNT = 200;
const MAX_FILE_COUNT = 20_000;
const MAX_SINGLE_FILE_BYTES = 80 * 1024 * 1024;
const INSPECTION_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_INSPECTIONS = 8;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface ArchivedFile {
  path: string;
  data: string;
  mode?: number;
}

interface ArchivedPlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  files: ArchivedFile[];
  storage: Record<string, unknown>;
  sqliteFiles: ArchivedFile[];
}

interface SettingsBackupArchive {
  format: typeof SETTINGS_BACKUP_FORMAT;
  version: typeof SETTINGS_BACKUP_VERSION;
  createdAt: string;
  appVersion: string;
  includes: SettingsBackupScope;
  settings?: Record<string, unknown>;
  desktopLyricSettings?: Record<string, unknown>;
  plugins?: ArchivedPlugin[];
}

interface InspectedBackup {
  filePath: string;
  archive: SettingsBackupArchive;
  expiresAt: number;
  digest: string;
  ownerPluginId?: string;
  temporaryDirectory?: string;
}

interface PluginRollbackSnapshot {
  id: string;
  directory: string;
  existed: boolean;
  enabledPreference?: boolean;
  storage: Record<string, unknown>;
  codeSnapshotDirectory: string;
  sqliteSnapshotDirectory: string;
}

const inspectedBackups = new Map<string, InspectedBackup>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeDesktopLyricSettings = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(cloned).filter(([key]) => key !== 'windowState' && !isBlockedObjectKey(key)),
    );
  } catch {
    return {};
  }
};

const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value))
    return false;
  const normalized = value.replace(/\\/g, '/');
  return !normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..');
};

const getDecodedBase64Bytes = (value: string) => {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
};

const toArchiveRelativePath = (root: string, filePath: string) =>
  relative(root, filePath).split(sep).join('/');

const readDirectoryFiles = async (root: string): Promise<ArchivedFile[]> => {
  const output: ArchivedFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`文件过大，无法备份：${entry.name}`);
      }
      if (output.length >= MAX_FILE_COUNT) throw new Error('备份中的文件数量过多');
      const data = await fs.readFile(filePath);
      output.push({
        path: toArchiveRelativePath(root, filePath),
        data: data.toString('base64'),
        mode: stats.mode & 0o777,
      });
    }
  };

  try {
    await fs.access(root, fsConstants.R_OK);
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return output;
};

const writeArchivedFiles = async (root: string, files: ArchivedFile[]) => {
  const resolvedRoot = resolve(root);
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error('备份中包含非法文件路径');
    const target = resolve(resolvedRoot, file.path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error('备份文件路径超出目标目录');
    }
    const data = Buffer.from(file.data, 'base64');
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    if (process.platform !== 'win32' && Number.isInteger(file.mode)) {
      await fs.chmod(target, Number(file.mode) & 0o777);
    }
  }
};

const validateArchivedFiles = (value: unknown, counter: { files: number; bytes: number }) => {
  if (!Array.isArray(value)) throw new Error('备份文件列表无效');
  return value.map<ArchivedFile>((item) => {
    if (
      !isPlainObject(item) ||
      !isSafeRelativePath(item.path) ||
      typeof item.data !== 'string' ||
      !BASE64_RE.test(item.data)
    ) {
      throw new Error('备份中包含无效文件');
    }
    const bytes = getDecodedBase64Bytes(item.data);
    if (bytes > MAX_SINGLE_FILE_BYTES) throw new Error('备份中包含超大文件');
    counter.files += 1;
    counter.bytes += bytes;
    if (counter.files > MAX_FILE_COUNT || counter.bytes > MAX_BACKUP_JSON_BYTES) {
      throw new Error('备份内容超过安全限制');
    }
    return {
      path: item.path,
      data: item.data,
      mode: Number.isInteger(item.mode) ? Number(item.mode) & 0o777 : undefined,
    };
  });
};

const validateArchive = (value: unknown): SettingsBackupArchive => {
  if (!isPlainObject(value)) throw new Error('不是有效的 EchoMusic 备份文件');
  if (value.format !== SETTINGS_BACKUP_FORMAT) throw new Error('备份文件格式不受支持');
  if (value.version !== SETTINGS_BACKUP_VERSION) throw new Error('备份版本不受支持');
  if (!isPlainObject(value.includes)) throw new Error('备份范围信息无效');

  const includes = {
    settings: value.includes.settings === true,
    plugins: value.includes.plugins === true,
  };
  if (!includes.settings && !includes.plugins) throw new Error('备份中没有可恢复的内容');

  const settings = includes.settings ? sanitizePortableAppSettings(value.settings) : undefined;
  const desktopLyricSettings = includes.settings
    ? sanitizeDesktopLyricSettings(value.desktopLyricSettings)
    : undefined;
  if (
    settings &&
    Buffer.byteLength(JSON.stringify({ settings, desktopLyricSettings })) > MAX_SETTINGS_JSON_BYTES
  ) {
    throw new Error('应用设置数据过大');
  }

  const counter = { files: 0, bytes: 0 };
  const sourcePlugins = includes.plugins ? value.plugins : [];
  if (includes.plugins && !Array.isArray(sourcePlugins)) throw new Error('插件备份数据无效');
  if (Array.isArray(sourcePlugins) && sourcePlugins.length > MAX_PLUGIN_COUNT) {
    throw new Error('备份中的插件数量过多');
  }
  const seenPluginIds = new Set<string>();
  const plugins = (Array.isArray(sourcePlugins) ? sourcePlugins : []).map<ArchivedPlugin>(
    (item) => {
      if (!isPlainObject(item)) throw new Error('插件备份条目无效');
      const id = normalizePluginId(item.id);
      if (!id || id !== item.id || seenPluginIds.has(id)) throw new Error('插件标识无效或重复');
      seenPluginIds.add(id);
      const files = validateArchivedFiles(item.files, counter);
      const manifests = files.filter((file) => file.path === 'manifest.json');
      if (manifests.length !== 1) {
        throw new Error(`插件“${id}”的备份必须包含唯一的 manifest.json`);
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(Buffer.from(manifests[0].data, 'base64').toString('utf8'));
      } catch {
        throw new Error(`插件“${id}”的 manifest.json 无法解析`);
      }
      assertBackupManifestMatchesPlugin(id, manifest);

      return {
        id,
        name: String(item.name || id).slice(0, 160),
        version: String(item.version || '').slice(0, 80),
        enabled: item.enabled === true,
        files,
        storage: isPlainObject(item.storage)
          ? (JSON.parse(JSON.stringify(item.storage)) as Record<string, unknown>)
          : {},
        sqliteFiles: validateArchivedFiles(item.sqliteFiles ?? [], counter).map((file) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sqlite$/.test(file.path)) {
            throw new Error(`插件“${id}”包含无效的 SQLite 快照文件`);
          }
          return file;
        }),
      };
    },
  );

  return {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    createdAt: String(value.createdAt || ''),
    appVersion: String(value.appVersion || ''),
    includes,
    ...(settings ? { settings } : {}),
    ...(desktopLyricSettings ? { desktopLyricSettings } : {}),
    ...(includes.plugins ? { plugins } : {}),
  };
};

const readArchiveBuffer = async (
  compressed: Buffer,
): Promise<{ archive: SettingsBackupArchive; digest: string }> => {
  if (compressed.byteLength > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 256 MB');
  let json: Buffer;
  try {
    json = await gunzipAsync(compressed, { maxOutputLength: MAX_BACKUP_JSON_BYTES });
  } catch {
    throw new Error('备份文件已损坏或格式不正确');
  }
  if (json.byteLength > MAX_BACKUP_JSON_BYTES) throw new Error('备份解压后超过安全限制');
  try {
    return {
      archive: validateArchive(JSON.parse(json.toString('utf8'))),
      digest: createHash('sha256').update(compressed).digest('hex'),
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('备份文件内容无法解析');
    throw error;
  }
};

const readArchive = async (
  filePath: string,
): Promise<{ archive: SettingsBackupArchive; digest: string }> => {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('请选择有效的备份文件');
  if (stats.size > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 256 MB');
  return readArchiveBuffer(await fs.readFile(filePath));
};

const buildSummary = (archive: SettingsBackupArchive): SettingsBackupSummary => ({
  createdAt: archive.createdAt,
  appVersion: archive.appVersion,
  includes: archive.includes,
  settingCount:
    Object.keys(archive.settings ?? {}).length +
    Object.keys(archive.desktopLyricSettings ?? {}).length,
  pluginCount: archive.plugins?.length ?? 0,
  pluginNames: (archive.plugins ?? []).map((plugin) => plugin.name),
});

const getDialogWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

const removeInspectionTemporaryDirectory = async (inspection: InspectedBackup) => {
  if (!inspection.temporaryDirectory) return;
  await fs.rm(inspection.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
};

const cleanupInspections = async () => {
  const now = Date.now();
  for (const [token, inspection] of inspectedBackups) {
    if (inspection.expiresAt > now) continue;
    inspectedBackups.delete(token);
    await removeInspectionTemporaryDirectory(inspection);
  }
};

const createBackupArchive = async (
  request: SettingsBackupExportRequest,
): Promise<SettingsBackupArchive> => {
  if (!request?.settings && !request?.plugins) throw new Error('请至少选择一项备份内容');

  const archive: SettingsBackupArchive = {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    includes: { settings: Boolean(request.settings), plugins: Boolean(request.plugins) },
  };
  if (request.settings) {
    archive.settings = sanitizePortableAppSettings(request.settingsData);
    archive.desktopLyricSettings = sanitizeDesktopLyricSettings(getDesktopLyricPersistedSettings());
    if (Buffer.byteLength(JSON.stringify(archive.settings)) > MAX_SETTINGS_JSON_BYTES) {
      throw new Error('应用设置数据过大');
    }
  }
  if (request.plugins) {
    const descriptors = listPlugins().plugins.filter((plugin) => !plugin.invalid);
    if (descriptors.length > MAX_PLUGIN_COUNT) throw new Error('已安装插件数量过多');
    archive.plugins = [];
    let totalFiles = 0;
    for (const plugin of descriptors) {
      const files = await readDirectoryFiles(plugin.directory);
      const sqliteSnapshotRoot = await fs.mkdtemp(
        join(app.getPath('temp'), `echo-sqlite-export-${plugin.id}-`),
      );
      let sqliteFiles: ArchivedFile[];
      try {
        snapshotPluginSqliteDatabases(plugin.id, sqliteSnapshotRoot);
        sqliteFiles = await readDirectoryFiles(sqliteSnapshotRoot);
      } finally {
        await fs.rm(sqliteSnapshotRoot, { recursive: true, force: true }).catch(() => {});
      }
      totalFiles += files.length + sqliteFiles.length;
      if (totalFiles > MAX_FILE_COUNT) throw new Error('插件文件数量过多');
      archive.plugins.push({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        enabled: plugin.enabled,
        files,
        storage: exportPluginStorage(plugin.id),
        sqliteFiles,
      });
    }
  }
  return archive;
};

const compressBackupArchive = async (archive: SettingsBackupArchive) => {
  const json = Buffer.from(JSON.stringify(archive));
  if (json.byteLength > MAX_BACKUP_JSON_BYTES) throw new Error('备份内容超过 512 MB');
  const compressed = await gzipAsync(json, { level: 9 });
  if (compressed.byteLength > MAX_BACKUP_FILE_BYTES) throw new Error('生成的备份文件超过 256 MB');
  return compressed;
};

export const exportSettingsBackup = async (
  request: SettingsBackupExportRequest,
): Promise<SettingsBackupExportResult> => {
  try {
    if (!request?.settings && !request?.plugins) {
      return { ok: false, canceled: false, error: '请至少选择一项备份内容' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const options = {
      title: '创建 EchoMusic 备份',
      defaultPath: `EchoMusic-backup-${date}.${SETTINGS_BACKUP_EXTENSION}`,
      buttonLabel: '创建备份',
      filters: [{ name: 'EchoMusic 备份', extensions: [SETTINGS_BACKUP_EXTENSION] }],
    };
    const win = getDialogWindow();
    const picked = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

    const archive = await createBackupArchive(request);
    const compressed = await compressBackupArchive(archive);
    await fs.writeFile(picked.filePath, compressed);
    return {
      ok: true,
      canceled: false,
      filePath: picked.filePath,
      summary: buildSummary(archive),
    };
  } catch (error) {
    log.warn('[SettingsBackup] Export failed', error);
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : '创建备份失败',
    };
  }
};

export const inspectSettingsBackup = async (): Promise<SettingsBackupInspectResult> => {
  try {
    await cleanupInspections();
    const options: OpenDialogOptions = {
      title: '从备份恢复 EchoMusic',
      buttonLabel: '选择备份',
      filters: [{ name: 'EchoMusic 备份', extensions: [SETTINGS_BACKUP_EXTENSION] }],
      properties: ['openFile'],
    };
    const win = getDialogWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return { ok: false, canceled: true };
    const { archive, digest } = await readArchive(filePath);
    const token = randomUUID();
    inspectedBackups.set(token, {
      filePath,
      archive,
      digest,
      expiresAt: Date.now() + INSPECTION_TTL_MS,
    });
    return { ok: true, canceled: false, token, summary: buildSummary(archive) };
  } catch (error) {
    log.warn('[SettingsBackup] Inspect failed', error);
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : '无法读取备份文件',
    };
  }
};

const getPluginBackupAccess = (pluginId: string) => {
  if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' } as const;
  const plugin = getPluginDescriptor(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' } as const;
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' } as const;
  if (!plugin.compatibility.compatible) {
    return {
      ok: false,
      error: plugin.compatibility.message || '插件与当前 EchoMusic 版本不兼容',
    } as const;
  }
  if (!plugin.enabled) return { ok: false, error: '插件未启用' } as const;
  if (plugin.manifest.capabilities?.backups !== true) {
    return { ok: false, error: '插件未声明备份与恢复能力' } as const;
  }
  return { ok: true, plugin } as const;
};

const confirmPluginBackupOperation = async (
  pluginName: string,
  operation: 'create' | 'restore',
  detail: string,
) => {
  const options = {
    type: 'warning' as const,
    title: operation === 'create' ? '允许插件创建备份？' : '允许插件恢复备份？',
    message:
      operation === 'create'
        ? `插件“${pluginName}”请求创建 EchoMusic 备份`
        : `插件“${pluginName}”请求从备份恢复 EchoMusic`,
    detail,
    buttons: ['取消', operation === 'create' ? '允许创建' : '恢复并重启'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win = getDialogWindow();
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
};

const toBackupBuffer = (value: unknown) => {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new Error('备份数据必须是 ArrayBuffer 或 ArrayBufferView');
};

export const createPluginBackup = async (
  request: PluginBackupCreateRequest,
): Promise<PluginBackupCreateResult> => {
  const access = getPluginBackupAccess(String(request?.pluginId || ''));
  if (!access.ok) return { ok: false, canceled: false, error: access.error };

  const scope = {
    settings: request.settings !== false,
    plugins: request.plugins !== false,
  };
  if (!scope.settings && !scope.plugins) {
    return { ok: false, canceled: false, error: '请至少选择一项备份内容' };
  }
  const selected = [scope.settings ? '应用设置' : '', scope.plugins ? '插件及插件数据' : '']
    .filter(Boolean)
    .join('、');
  const confirmed = await confirmPluginBackupOperation(
    access.plugin.name,
    'create',
    `将允许该插件读取并保存：${selected}。备份文件未加密，请仅允许你信任的插件执行此操作。`,
  );
  if (!confirmed) return { ok: false, canceled: true };

  try {
    const settingsKey = getStorePersistenceKey('setting');
    const archive = await createBackupArchive({
      ...scope,
      settingsData: scope.settings
        ? (request.settingsData ??
          getKvStorage().get<Record<string, unknown>>(settingsKey) ??
          undefined)
        : undefined,
    });
    const compressed = await compressBackupArchive(archive);
    const bytes = Uint8Array.from(compressed);
    return {
      ok: true,
      canceled: false,
      data: bytes.buffer,
      fileName: `EchoMusic-backup-${new Date().toISOString().slice(0, 10)}.${SETTINGS_BACKUP_EXTENSION}`,
      summary: buildSummary(archive),
    };
  } catch (error) {
    log.warn('[SettingsBackup] Plugin create failed', {
      pluginId: access.plugin.id,
      error,
    });
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : '创建备份失败',
    };
  }
};

export const inspectPluginBackup = async (
  request: PluginBackupInspectRequest,
): Promise<PluginBackupInspectResult> => {
  const access = getPluginBackupAccess(String(request?.pluginId || ''));
  if (!access.ok) return { ok: false, error: access.error };

  let temporaryDirectory = '';
  try {
    await cleanupInspections();
    if (inspectedBackups.size >= MAX_ACTIVE_INSPECTIONS) {
      throw new Error('待恢复的备份过多，请稍后重试');
    }
    const compressed = toBackupBuffer(request.data);
    const { archive, digest } = await readArchiveBuffer(compressed);
    temporaryDirectory = await fs.mkdtemp(join(app.getPath('temp'), 'echo-plugin-backup-'));
    const filePath = join(temporaryDirectory, `backup.${SETTINGS_BACKUP_EXTENSION}`);
    await fs.writeFile(filePath, compressed);
    const token = randomUUID();
    inspectedBackups.set(token, {
      filePath,
      archive,
      digest,
      ownerPluginId: access.plugin.id,
      temporaryDirectory,
      expiresAt: Date.now() + INSPECTION_TTL_MS,
    });
    return { ok: true, token, summary: buildSummary(archive) };
  } catch (error) {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    log.warn('[SettingsBackup] Plugin inspect failed', {
      pluginId: access.plugin.id,
      error,
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : '无法读取备份数据',
    };
  }
};

const snapshotPluginForRollback = async (
  pluginId: string,
  rollbackRoot: string,
): Promise<PluginRollbackSnapshot> => {
  const descriptor = getPluginDescriptor(pluginId);
  const codeSnapshotDirectory = join(rollbackRoot, pluginId, 'code');
  const sqliteSnapshotDirectory = join(rollbackRoot, pluginId, 'sqlite');
  if (descriptor) {
    await fs.mkdir(dirname(codeSnapshotDirectory), { recursive: true });
    await fs.cp(descriptor.directory, codeSnapshotDirectory, { recursive: true });
  }
  snapshotPluginSqliteDatabases(pluginId, sqliteSnapshotDirectory);
  return {
    id: pluginId,
    directory: descriptor?.directory ?? join(getPluginDirectory(), pluginId),
    existed: Boolean(descriptor),
    enabledPreference: exportPluginEnabledPreference(pluginId),
    storage: exportPluginStorage(pluginId),
    codeSnapshotDirectory,
    sqliteSnapshotDirectory,
  };
};

const restorePluginFromRollback = async (snapshot: PluginRollbackSnapshot) => {
  await closePluginWebServer(snapshot.id).catch(() => {});
  closePluginSqliteDatabases(snapshot.id);
  await terminatePluginProcesses(snapshot.id).catch(() => {});
  await fs.rm(snapshot.directory, { recursive: true, force: true });
  if (snapshot.existed) {
    await fs.mkdir(dirname(snapshot.directory), { recursive: true });
    await fs.cp(snapshot.codeSnapshotDirectory, snapshot.directory, { recursive: true });
  }

  replacePluginStorage(snapshot.id, snapshot.storage);
  replacePluginEnabledPreference(snapshot.id, snapshot.enabledPreference);
  const sqliteDirectory = getPluginSqliteDirectory(snapshot.id);
  await fs.rm(sqliteDirectory, { recursive: true, force: true });
  const sqliteFiles = await fs.readdir(snapshot.sqliteSnapshotDirectory).catch(() => []);
  if (sqliteFiles.length > 0) {
    await fs.mkdir(dirname(sqliteDirectory), { recursive: true });
    await fs.cp(snapshot.sqliteSnapshotDirectory, sqliteDirectory, { recursive: true });
  }
};

const importPlugin = async (plugin: ArchivedPlugin, stagingRoot: string) => {
  const sourceDirectory = join(stagingRoot, plugin.id);
  await fs.mkdir(sourceDirectory, { recursive: true });
  await writeArchivedFiles(sourceDirectory, plugin.files);
  await closePluginWebServer(plugin.id);
  closePluginSqliteDatabases(plugin.id);
  await terminatePluginProcesses(plugin.id);
  replacePluginEnabledPreference(plugin.id, false);
  const result = await installPluginsFromLocal([sourceDirectory], {
    enableAfterInstall: false,
    expectedPluginId: plugin.id,
  });
  const installed = result.results[0];
  if (!installed?.ok) {
    throw new Error(installed?.error || `插件“${plugin.name}”安装失败`);
  }

  replacePluginStorage(plugin.id, plugin.storage);
  closePluginSqliteDatabases(plugin.id);
  const sqliteDirectory = getPluginSqliteDirectory(plugin.id);
  await fs.rm(sqliteDirectory, { recursive: true, force: true });
  if (plugin.sqliteFiles.length > 0) {
    await fs.mkdir(sqliteDirectory, { recursive: true });
    await writeArchivedFiles(sqliteDirectory, plugin.sqliteFiles);
  }
  const enabledResult = await setPluginEnabled(plugin.id, plugin.enabled);
  if (!enabledResult.ok) throw new Error(enabledResult.error);
};

const importSettingsBackupForOwner = async (
  request: SettingsBackupImportRequest,
  ownerPluginId?: string,
): Promise<SettingsBackupImportResult> => {
  await cleanupInspections();
  const inspection = inspectedBackups.get(String(request?.token || ''));
  if (!inspection) return { ok: false, error: '备份选择已失效，请重新选择文件' };
  if (inspection.ownerPluginId !== ownerPluginId) {
    return { ok: false, error: '备份恢复请求与选择来源不匹配' };
  }
  inspectedBackups.delete(String(request.token));

  const archive = inspection.archive;
  const importSettings = Boolean(request.settings && archive.includes.settings);
  const importPlugins = Boolean(request.plugins && archive.includes.plugins);
  if (!importSettings && !importPlugins) {
    await removeInspectionTemporaryDirectory(inspection);
    return { ok: false, error: '请至少选择一项恢复内容' };
  }

  let pluginsImported = 0;
  let stagingRoot = '';
  const rollbackSnapshots: PluginRollbackSnapshot[] = [];
  try {
    // Re-read the file so replacement or tampering between preview and import is detected.
    const fresh = await readArchive(inspection.filePath);
    const freshArchive = fresh.archive;
    if (fresh.digest !== inspection.digest) {
      throw new Error('备份文件在预览后发生变化，请重新选择');
    }

    if (importPlugins) {
      stagingRoot = await fs.mkdtemp(join(app.getPath('temp'), 'echo-settings-import-'));
      const rollbackRoot = join(stagingRoot, 'rollback');
      for (const plugin of freshArchive.plugins ?? []) {
        rollbackSnapshots.push(await snapshotPluginForRollback(plugin.id, rollbackRoot));
        await importPlugin(plugin, stagingRoot);
        pluginsImported += 1;
      }
    }

    if (importSettings) {
      const key = getStorePersistenceKey('setting');
      const current = getKvStorage().get<Record<string, unknown>>(key);
      getKvStorage().set(key, {
        ...(isPlainObject(current) ? current : {}),
        ...sanitizePortableAppSettings(freshArchive.settings),
      });
      const importedSettings = sanitizePortableAppSettings(freshArchive.settings);
      if (['tray', 'exit'].includes(String(importedSettings.closeBehavior))) {
        setMainAppSetting('closeBehavior', importedSettings.closeBehavior as 'tray' | 'exit');
      }
      if (['system', 'light', 'dark'].includes(String(importedSettings.theme))) {
        setMainAppSetting('theme', importedSettings.theme as 'system' | 'light' | 'dark');
      }
      const booleanMainSettingKeys: Array<
        Exclude<keyof MainAppSettings, 'closeBehavior' | 'theme' | 'dpiScale'>
      > = [
        'rememberWindowSize',
        'preventSleep',
        'disableGpuAcceleration',
        'autoLaunch',
        'startMinimized',
        'highDpiEnabled',
        'devToolsEnabled',
        'taskbarCoverPreview',
        'taskbarProgress',
      ];
      for (const settingKey of booleanMainSettingKeys) {
        if (typeof importedSettings[settingKey] !== 'boolean') continue;
        setMainAppSetting(settingKey, importedSettings[settingKey]);
      }
      if (
        typeof importedSettings.dpiScale === 'number' &&
        Number.isFinite(importedSettings.dpiScale)
      ) {
        setMainAppSetting('dpiScale', Math.min(2, Math.max(0.5, importedSettings.dpiScale)));
      }
      setPersistedLogSettings(
        normalizeLogSettings({
          level: importedSettings.logLevel as AppLogLevel,
          apiResponseBody: Boolean(importedSettings.logApiResponseBody),
          diagnosticUntil: 0,
        }),
      );
      if (isPlainObject(freshArchive.desktopLyricSettings)) {
        patchDesktopLyricPersistedSettings(freshArchive.desktopLyricSettings);
      }
    }

    return {
      ok: true,
      settingsImported: importSettings,
      pluginsImported,
      summary: buildSummary(freshArchive),
    };
  } catch (error) {
    log.warn('[SettingsBackup] Import failed', error);
    let rollbackError: unknown;
    for (const snapshot of rollbackSnapshots.reverse()) {
      try {
        await restorePluginFromRollback(snapshot);
      } catch (restoreError) {
        rollbackError ??= restoreError;
        log.error('[SettingsBackup] Plugin rollback failed', {
          pluginId: snapshot.id,
          error: restoreError,
        });
      }
    }
    return {
      ok: false,
      error: rollbackError
        ? `${error instanceof Error ? error.message : '从备份恢复失败'}；部分插件回滚失败，请重新启动后检查插件`
        : error instanceof Error
          ? error.message
          : '从备份恢复失败',
      settingsImported: false,
      pluginsImported: 0,
    };
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    await removeInspectionTemporaryDirectory(inspection);
  }
};

export const importSettingsBackup = (
  request: SettingsBackupImportRequest,
): Promise<SettingsBackupImportResult> => importSettingsBackupForOwner(request);

export const restorePluginBackup = async (
  request: PluginBackupRestoreRequest,
): Promise<PluginBackupRestoreResult> => {
  const access = getPluginBackupAccess(String(request?.pluginId || ''));
  if (!access.ok) return { ok: false, canceled: false, error: access.error };

  await cleanupInspections();
  const inspection = inspectedBackups.get(String(request?.token || ''));
  if (!inspection || inspection.ownerPluginId !== access.plugin.id) {
    return { ok: false, canceled: false, error: '备份选择已失效，请重新检查备份数据' };
  }
  const scope = {
    settings: request.settings !== false && inspection.archive.includes.settings,
    plugins: request.plugins !== false && inspection.archive.includes.plugins,
  };
  if (!scope.settings && !scope.plugins) {
    return { ok: false, canceled: false, error: '请至少选择一项恢复内容' };
  }
  const selected = [scope.settings ? '应用设置' : '', scope.plugins ? '插件及插件数据' : '']
    .filter(Boolean)
    .join('、');
  const summary = buildSummary(inspection.archive);
  const confirmed = await confirmPluginBackupOperation(
    access.plugin.name,
    'restore',
    `将恢复：${selected}。备份来自 EchoMusic ${summary.appVersion || '未知版本'}，创建于 ${summary.createdAt || '未知时间'}。同名设置与插件会被覆盖。`,
  );
  if (!confirmed) return { ok: false, canceled: true };

  const result = await importSettingsBackupForOwner(
    { token: request.token, ...scope },
    access.plugin.id,
  );
  return result.ok
    ? { ...result, canceled: false, restartScheduled: true }
    : { ...result, canceled: false };
};
