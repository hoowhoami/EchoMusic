import { constants as fsConstants, type Stats } from 'fs';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join, resolve } from 'path';
import StreamZip from 'node-stream-zip';
import type {
  EchoPluginDescriptor,
  PluginLocalInstallItemResult,
  PluginLocalInstallOptions,
  PluginLocalInstallResult,
  PluginLocalInstallSourceKind,
  PluginMarketplacePlugin,
} from '../../shared/plugins';
import log from '../logger';
import {
  MAX_PLUGIN_PACKAGE_SIZE_BYTES,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS,
  normalizePluginId,
} from './common';
import { readManifest, toDescriptor } from './descriptor';
import { ensurePluginRoot, isPathInside } from './path';

type PluginDirectoryInstallOptions = {
  expectedPluginId?: string;
  enableAfterInstall: boolean;
};

type PluginDirectoryInstallResult = {
  plugin: EchoPluginDescriptor;
  updated: boolean;
  enabled: boolean;
};

type PluginInstallerOptions = {
  findPlugin: (pluginId: string) => EchoPluginDescriptor | null;
  getEnabledState: () => Record<string, boolean>;
  isSafePackagePath: (value: string) => boolean;
  normalizePackagePath: (value: unknown) => string;
  runWithTimeout: <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    label: string,
  ) => Promise<T>;
  setEnabledState: (state: Record<string, boolean>) => void;
  setPluginInstalledAt: (pluginId: string, installedAt: number) => void;
  terminatePluginProcesses: (pluginId?: string) => Promise<void>;
};

const pathExists = async (filePath: string) => {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const extractZipWithStreamZip = async (zipPath: string, extractDirectory: string) => {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entries = await zip.entries();
    let totalSize = 0;

    for (const entry of Object.values(entries)) {
      if (entry.encrypted) throw new Error('插件安装包包含加密文件');
      if (!entry.isFile) continue;
      totalSize += Math.max(0, Math.round(Number(entry.size) || 0));
      if (totalSize > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
        throw new Error('插件安装包解压后超过 80 MB');
      }
    }

    await zip.extract(null, extractDirectory);
  } finally {
    await zip.close().catch((error) => {
      log.warn('[PluginMarketplace] zip close failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
};

const findExtractedArchiveRoot = async (directory: string) => {
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(
    (entry) => !entry.name.startsWith('__MACOSX'),
  );
  if (entries.length === 1 && entries[0].isDirectory()) {
    return join(directory, entries[0].name);
  }
  return directory;
};

const findManifestDirectoryCandidate = async (directory: string) => {
  if (!(await pathExists(directory))) return '';
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) return '';
  if (await pathExists(join(directory, PLUGIN_MANIFEST_FILE))) return directory;

  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (entries.length === 1) {
    const nested = join(directory, entries[0].name);
    if (await pathExists(join(nested, PLUGIN_MANIFEST_FILE))) return nested;
  }

  return '';
};

const normalizeLocalInstallPaths = (paths: unknown) => {
  if (!Array.isArray(paths)) return [];
  return Array.from(
    new Set(paths.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)),
  );
};

const getLocalInstallSource = async (
  sourcePath: string,
): Promise<{ path: string; kind: PluginLocalInstallSourceKind; stats: Stats }> => {
  const resolvedPath = await fs.realpath(resolve(sourcePath));
  const stats = await fs.stat(resolvedPath);
  if (stats.isDirectory()) return { path: resolvedPath, kind: 'directory', stats };
  if (stats.isFile() && extname(resolvedPath).toLowerCase() === '.zip') {
    return { path: resolvedPath, kind: 'zip', stats };
  }
  throw new Error('仅支持 .zip 插件压缩包或插件文件夹');
};

export const createPluginInstaller = ({
  findPlugin,
  getEnabledState,
  isSafePackagePath,
  normalizePackagePath,
  runWithTimeout,
  setEnabledState,
  setPluginInstalledAt,
  terminatePluginProcesses,
}: PluginInstallerOptions) => {
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
      extractZipWithStreamZip(zipPath, extractDirectory),
      PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS,
      '插件安装包解压超时',
      'node-stream-zip',
    );
    log.info('[PluginMarketplace] package extract finished', {
      pluginId: plugin.id,
      sourceId: plugin.sourceId,
    });
  };

  const findPluginInstallSourceDirectory = async (
    extractDirectory: string,
    packagePath: string,
  ) => {
    const archiveRoot = await findExtractedArchiveRoot(extractDirectory);
    const normalizedPackagePath = normalizePackagePath(packagePath);
    if (!isSafePackagePath(normalizedPackagePath)) throw new Error('插件包路径非法');

    if (normalizedPackagePath) {
      const candidate = resolve(archiveRoot, normalizedPackagePath);
      if (!isPathInside(archiveRoot, candidate)) throw new Error('插件包路径非法');
      const matched = await findManifestDirectoryCandidate(candidate);
      if (matched) return matched;
    }

    const rootMatched = await findManifestDirectoryCandidate(archiveRoot);
    if (rootMatched) return rootMatched;

    throw new Error('插件安装包中未找到 manifest.json');
  };

  const installPluginDirectory = async (
    sourceDirectory: string,
    options: PluginDirectoryInstallOptions,
  ): Promise<PluginDirectoryInstallResult> => {
    const sourceStats = await fs.stat(sourceDirectory);
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

    const stagingParent = await fs.mkdtemp(join(tmpdir(), 'echo-plugin-install-'));
    const stagingDirectory = join(stagingParent, pluginId);
    try {
      const enableAfterInstall = Boolean(options.enableAfterInstall);
      await fs.cp(sourceDirectory, stagingDirectory, { recursive: true });
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
      await terminatePluginProcesses(pluginId);
      if (process.platform === 'win32') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      await fs.rm(targetDirectory, { recursive: true, force: true });
      await fs.cp(stagingDirectory, targetDirectory, { recursive: true });
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
      await fs.rm(stagingParent, { recursive: true, force: true });
    }
  };

  const installPluginFromLocalSource = async (
    inputPath: string,
    options: PluginLocalInstallOptions,
  ): Promise<PluginLocalInstallItemResult> => {
    const sourcePath = String(inputPath ?? '').trim();
    let kind: PluginLocalInstallItemResult['kind'] = 'unknown';

    try {
      if (!sourcePath) throw new Error('插件路径为空');
      const source = await getLocalInstallSource(sourcePath);
      kind = source.kind;

      if (source.kind === 'directory') {
        const sourceDirectory = await findPluginInstallSourceDirectory(source.path, '');
        const installed = await installPluginDirectory(sourceDirectory, {
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

      const tempDirectory = await fs.mkdtemp(join(tmpdir(), 'echo-plugin-local-'));
      try {
        const extractDirectory = join(tempDirectory, 'extracted');
        await fs.mkdir(extractDirectory, { recursive: true });
        await extractMarketplacePackage(source.path, extractDirectory, {
          id: 'local',
          sourceId: 'local',
        });
        const sourceDirectory = await findPluginInstallSourceDirectory(extractDirectory, '');
        const installed = await installPluginDirectory(sourceDirectory, {
          enableAfterInstall: Boolean(options.enableAfterInstall),
        });
        return {
          ok: true,
          sourcePath: source.path,
          kind,
          ...installed,
        };
      } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
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

  const installPluginsFromLocal = async (
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

  return {
    extractMarketplacePackage,
    findPluginInstallSourceDirectory,
    installPluginDirectory,
    installPluginsFromLocal,
  };
};
