import { constants as fsConstants, type Stats } from 'fs';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
import { getPluginRoot, isPathInside } from './path';
import {
  createInstallTransaction,
  validateProgramDirectory,
  withInstallLock,
} from './installTransaction';
import { safePath } from '../downloads/files';

type PluginDirectoryInstallOptions = {
  expectedPluginId?: string;
  enableAfterInstall: boolean;
  source?: EchoPluginDescriptor['installSource'];
  tags?: string[];
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
  setEnabledState: (state: Record<string, boolean>) => void;
  setPluginTags: (pluginId: string, tags: unknown) => void;
  setPluginInstallSource: (
    pluginId: string,
    source: NonNullable<EchoPluginDescriptor['installSource']>,
  ) => void;
  setPluginInstalledAt: (pluginId: string, installedAt: number) => void;
  terminatePluginProcesses: (pluginId?: string) => Promise<void>;
  withMetadataMutation: <T>(pluginId: string, mutate: () => Promise<T>) => Promise<T>;
  snapshotMetadata?: (pluginId: string) => unknown;
  restoreMetadata?: (pluginId: string, value: unknown) => Promise<void>;
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
    if (Object.keys(entries).length > 10000) throw new Error('插件包文件数量过多');
    let totalSize = 0;

    const names = new Set<string>();
    const casing = new Map<string, string>();
    for (const entry of Object.values(entries)) {
      if (entry.encrypted) throw new Error('插件安装包包含加密文件');
      if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('插件安装包不能包含链接');
      const mode = (entry.attr >>> 16) & 0xf000;
      if (mode && mode !== 0x4000 && mode !== 0x8000) throw new Error('插件安装包包含特殊文件');
      const name = entry.name.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      if (names.has(name)) throw new Error('插件安装包包含重复路径');
      names.add(name);
      const parts = entry.name.replace(/\\/g, '/').replace(/\/$/, '').split('/');
      for (let i = 1; i <= parts.length; i++) {
        const actual = parts.slice(0, i).join('/');
        const key = actual.toLowerCase();
        if (casing.has(key) && casing.get(key) !== actual)
          throw new Error('插件安装包包含大小写冲突路径');
        casing.set(key, actual);
      }
      await safePath(extractDirectory, entry.name.replace(/\/$/, ''), true);
      if (!entry.isFile) continue;
      totalSize += Math.max(0, Math.round(Number(entry.size) || 0));
      if (totalSize > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
        throw new Error('插件安装包解压后超过 80 MB');
      }
    }

    let output = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS);
    try {
      for (const entry of Object.values(entries)) {
        if (controller.signal.aborted) throw new Error('插件安装包解压超时');
        const target = await safePath(extractDirectory, entry.name.replace(/\/$/, ''), true);
        if (entry.isDirectory) {
          await fs.mkdir(target, { recursive: true });
          continue;
        }
        const stream = await zip.stream(entry);
        const budget = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            output += chunk.length;
            if (output > MAX_PLUGIN_PACKAGE_SIZE_BYTES)
              callback(new Error('插件安装包解压后超过 80 MB'));
            else callback(null, chunk);
          },
        });
        await pipeline(stream, budget, createWriteStream(target, { flags: 'wx' }), {
          signal: controller.signal,
        });
      }
    } finally {
      clearTimeout(timer);
    }
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
  setEnabledState,
  setPluginInstalledAt,
  setPluginInstallSource,
  setPluginTags,
  terminatePluginProcesses,
  withMetadataMutation,
  snapshotMetadata,
  restoreMetadata,
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
    await extractZipWithStreamZip(zipPath, extractDirectory);
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

    const manifestResult = await readManifest(join(sourceDirectory, PLUGIN_MANIFEST_FILE));
    if (manifestResult.error) throw new Error(manifestResult.error);
    const pluginId = normalizePluginId(manifestResult.manifest.id);
    if (!pluginId) throw new Error('manifest.id 不能为空');

    const expectedPluginId = normalizePluginId(options.expectedPluginId);
    if (expectedPluginId && pluginId !== expectedPluginId) {
      throw new Error(`插件清单 id 与索引不一致: ${pluginId || '空'} / ${expectedPluginId}`);
    }

    const root = resolve(getPluginRoot());
    await fs.mkdir(root, { recursive: true });
    return withInstallLock(pluginId, async () => {
      const existingPlugin = findPlugin(pluginId);
      const targetDirectory = existingPlugin
        ? resolve(existingPlugin.directory)
        : resolve(root, pluginId);
      if (!isPathInside(root, targetDirectory) || targetDirectory === root) {
        throw new Error('插件安装目录非法');
      }

      const transaction = await createInstallTransaction(
        root,
        targetDirectory,
        snapshotMetadata?.(pluginId),
      );
      const stagingDirectory = transaction.staged;
      let applying = false;
      try {
        const enableAfterInstall = Boolean(options.enableAfterInstall);
        await validateProgramDirectory(sourceDirectory);
        await fs.cp(sourceDirectory, stagingDirectory, { recursive: true });
        await validateProgramDirectory(stagingDirectory);
        const descriptor = await toDescriptor(stagingDirectory, pluginId, {
          ...getEnabledState(),
          ...(enableAfterInstall ? { [pluginId]: true } : {}),
        });
        if (descriptor.invalid) throw new Error(descriptor.error || '插件清单无效');
        if (!descriptor.compatibility.compatible) {
          throw new Error(descriptor.compatibility.message || '插件与当前 EchoMusic 版本不兼容');
        }

        const metadata = snapshotMetadata?.(pluginId);
        await transaction.setMetadata(metadata);
        applying = true;
        await transaction.apply(
          (fn) => withMetadataMutation(pluginId, fn),
          async () => {
            await terminatePluginProcesses(pluginId);
            setPluginInstallSource(pluginId, options.source ?? { kind: 'local' });
            setPluginTags(pluginId, options.tags ?? descriptor.manifest.tags);
            if (!existingPlugin) setPluginInstalledAt(pluginId, Date.now());
            // Read current preferences after async work, preserving changes to other plugins.
            if (enableAfterInstall) setEnabledState({ ...getEnabledState(), [pluginId]: true });
          },
          async () => {
            await restoreMetadata?.(pluginId, metadata);
          },
          () => {
            const installed = findPlugin(pluginId);
            if (!installed || installed.invalid || !installed.compatibility.compatible)
              throw new Error('插件安装后扫描失败');
          },
        );

        const installed = findPlugin(pluginId);
        if (!installed) throw new Error('插件安装后扫描失败');
        return {
          plugin: installed,
          updated: Boolean(existingPlugin),
          enabled: installed.enabled,
        };
      } catch (error) {
        if ((error as { code?: string }).code === 'ROLLBACK_FAILED')
          setEnabledState({ ...getEnabledState(), [pluginId]: false });
        throw error;
      } finally {
        if (!applying) await transaction.discard();
      }
    });
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
          expectedPluginId: options.expectedPluginId,
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
          expectedPluginId: options.expectedPluginId,
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
