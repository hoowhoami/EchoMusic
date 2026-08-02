import fs from 'fs/promises';
import { basename, dirname, extname, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { Stats } from 'fs';
import type { LocalAudioMetadata } from '../../shared/local-music';
import type {
  EchoPluginDescriptor,
  PluginDeleteFileResult,
  PluginFileEntry,
  PluginFileKind,
  PluginFileUrlResult,
  PluginImageFileEntry,
  PluginListFilesOptions,
  PluginListFilesResult,
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
  PluginReadAudioMetadataResult,
  PluginReadFileBytesOptions,
  PluginReadFileBytesResult,
  PluginReadTextFileOptions,
  PluginReadTextFileResult,
  PluginWriteFileData,
  PluginWriteFileOptions,
  PluginWriteFileResult,
} from '../../shared/plugins';
import { readAudioMetadata, resolveAudioTitleAndArtist } from '../media/audioMetadata';
import { scanLocalFiles, type ScannedLocalFile } from '../media/fileScanner';
import {
  DEFAULT_PLUGIN_FILE_SCAN_LIMIT,
  DEFAULT_PLUGIN_READ_BYTES,
  MAX_PLUGIN_FILE_SCAN_LIMIT,
  MAX_PLUGIN_IMAGE_SCAN_LIMIT,
  MAX_PLUGIN_READ_BYTES,
  MAX_PLUGIN_WRITE_BYTES,
  PLUGIN_AUDIO_EXTENSIONS,
  PLUGIN_CUE_EXTENSIONS,
  PLUGIN_IMAGE_EXTENSIONS,
  PLUGIN_LYRIC_EXTENSIONS,
  PLUGIN_PLAYLIST_EXTENSIONS,
  clamp,
  comparePluginText,
} from './common';
import { isPathInside, resolvePluginFile, toPortableRelativePath } from './path';

type PluginLocalFilesAccessResult =
  | { ok: true; plugin: EchoPluginDescriptor }
  | { ok: false; error: string };

export interface PluginFileApiDependencies {
  getLocalFilesAccess: (pluginId: string) => PluginLocalFilesAccessResult;
  refreshAppIcons?: (options?: { force?: boolean }) => void;
}

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

const getLocalFileStats = async (filePath: string) => {
  const input = String(filePath || '').trim();
  if (!input) throw new Error('文件路径为空');
  const resolvedPath = await fs.realpath(resolve(input));
  const stats = await fs.stat(resolvedPath);
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

const toPluginFileEntryFromScanned = (file: ScannedLocalFile): PluginFileEntry => ({
  name: file.name,
  path: file.path,
  url: pathToFileURL(file.path).toString(),
  size: file.size,
  modifiedAt: file.modifiedAt,
  kind: file.kind as PluginFileKind,
  extension: file.extension,
  relativePath: file.relativePath,
});

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

const readPluginFileChunk = async (
  filePath: string,
  options: PluginReadTextFileOptions | PluginReadFileBytesOptions = {},
) => {
  const file = await getLocalFileStats(filePath);
  const offset = normalizePluginReadOffset(options.offset, file.stats.size);
  const length = normalizePluginReadLength(options, file.stats.size, offset);
  const buffer = Buffer.alloc(length);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file.path, 'r');
    const { bytesRead } =
      length > 0 ? await handle.read(buffer, 0, length, offset) : { bytesRead: 0 };
    return {
      ...file,
      buffer: buffer.subarray(0, bytesRead),
      bytesRead,
      truncated: offset + bytesRead < file.stats.size,
    };
  } finally {
    if (handle) await handle.close();
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

const pathExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolvePluginWritableFile = async (
  plugin: EchoPluginDescriptor,
  filePath: string,
  options: PluginWriteFileOptions,
) => {
  const input = String(filePath || '').trim();
  if (!input) throw new Error('文件路径为空');
  if (input.includes('\0')) throw new Error('文件路径不能包含空字符');

  const targetPath = resolvePluginFile(plugin.directory, input);
  if (!targetPath) throw new Error('写入路径必须位于插件目录内');

  const pluginRoot = await fs.realpath(plugin.directory);
  const parentPath = dirname(targetPath);
  if (options.createDirectories !== false) {
    await fs.mkdir(parentPath, { recursive: true });
  }

  const parentRealPath = await fs.realpath(parentPath);
  if (!isPathInside(pluginRoot, parentRealPath)) throw new Error('写入路径必须位于插件目录内');
  if (await pathExists(targetPath)) {
    const targetRealPath = await fs.realpath(targetPath);
    if (!isPathInside(pluginRoot, targetRealPath)) throw new Error('写入路径必须位于插件目录内');
    const stats = await fs.stat(targetPath);
    if (!stats.isFile()) throw new Error('写入路径不是文件');
    if (options.overwrite !== true) throw new Error('文件已存在');
  }

  return { pluginRoot, targetPath };
};

export const createPluginFileApi = ({
  getLocalFilesAccess,
  refreshAppIcons,
}: PluginFileApiDependencies) => {
  const listPluginFiles = async (
    pluginId: string,
    directoryPath: string,
    options: PluginListFilesOptions = {},
  ): Promise<PluginListFilesResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const input = String(directoryPath || '').trim();
      if (!input) return { ok: false, error: '文件夹路径为空' };
      const scan = await scanLocalFiles(input, {
        recursive: Boolean(options.recursive),
        includeHidden: Boolean(options.includeHidden),
        limit: normalizeFileScanLimit(options.limit),
        maxDepth: normalizeFileScanDepth(options.maxDepth),
        kinds: normalizePluginFileKinds(options.kinds),
        extensions: options.extensions,
        includeOther: false,
        getKind: getPluginFileKind,
      });
      const files = scan.files.map(toPluginFileEntryFromScanned);
      files.sort((left, right) => comparePluginText(left.relativePath, right.relativePath));
      return { ok: true, root: scan.root, files, limitReached: scan.limitReached };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '文件夹读取失败',
      };
    }
  };

  const listPluginImageFiles = async (
    directoryPath: string,
    options: PluginListImageFilesOptions = {},
  ): Promise<PluginListImageFilesResult> => {
    try {
      const scan = await scanLocalFiles(directoryPath, {
        recursive: Boolean(options.recursive),
        includeHidden: true,
        limit: normalizeImageScanLimit(options.limit),
        maxDepth: options.recursive ? 64 : 0,
        extensions: PLUGIN_IMAGE_EXTENSIONS,
        getKind: (extension) => (PLUGIN_IMAGE_EXTENSIONS.has(extension) ? 'image' : 'other'),
        includeOther: false,
      });
      const files: PluginImageFileEntry[] = scan.files.map((file) => ({
        name: file.name,
        path: file.path,
        url: pathToFileURL(file.path).toString(),
        size: file.size,
        modifiedAt: file.modifiedAt,
      }));

      files.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
      return { ok: true, files };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '图片文件夹读取失败',
      };
    }
  };

  const getPluginFileUrl = async (filePath: string): Promise<PluginFileUrlResult> => {
    try {
      const input = String(filePath || '').trim();
      const resolvedPath = input ? await fs.realpath(resolve(input)) : '';
      if (!resolvedPath) return { ok: false, error: '文件不存在' };
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) return { ok: false, error: '路径不是文件' };
      return { ok: true, url: pathToFileURL(resolvedPath).toString() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '文件地址解析失败',
      };
    }
  };

  const readPluginTextFile = async (
    pluginId: string,
    filePath: string,
    options: PluginReadTextFileOptions = {},
  ): Promise<PluginReadTextFileResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const chunk = await readPluginFileChunk(filePath, options);
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

  const readPluginFileBytes = async (
    pluginId: string,
    filePath: string,
    options: PluginReadFileBytesOptions = {},
  ): Promise<PluginReadFileBytesResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const chunk = await readPluginFileChunk(filePath, options);
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

  const readPluginAudioMetadata = async (
    pluginId: string,
    filePath: string,
  ): Promise<PluginReadAudioMetadataResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const file = await getLocalFileStats(filePath);
      const entry = toPluginFileEntry(file.path, file.path, file.stats);
      if (entry.kind !== 'audio') return { ok: false, error: '文件不是音频文件' };

      let metadata: LocalAudioMetadata | undefined;
      let metadataError: string | undefined;
      try {
        metadata = await readAudioMetadata(file.path);
      } catch (error) {
        metadataError = error instanceof Error ? error.message : '音频标签解析失败';
      }

      const { title, artist } = resolveAudioTitleAndArtist(entry.name, metadata);
      return {
        ok: true,
        ...entry,
        title,
        artist,
        album: metadata?.album,
        duration: metadata?.duration,
        year: metadata?.year,
        track: metadata?.track,
        disk: metadata?.disk,
        genre: metadata?.genre,
        metadataParsed: !metadataError,
        ...(metadataError ? { metadataError } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '音频标签读取失败',
      };
    }
  };

  const writePluginFile = async (
    pluginId: string,
    filePath: string,
    data: PluginWriteFileData,
    options: PluginWriteFileOptions = {},
  ): Promise<PluginWriteFileResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const buffer = normalizePluginWriteBuffer(data, options);
      if (buffer.byteLength > MAX_PLUGIN_WRITE_BYTES) {
        return {
          ok: false,
          error: `写入内容不能超过 ${Math.round(MAX_PLUGIN_WRITE_BYTES / 1024 / 1024)} MB`,
        };
      }

      const target = await resolvePluginWritableFile(access.plugin, filePath, options);
      await fs.writeFile(target.targetPath, buffer, {
        flag: options.overwrite === true ? 'w' : 'wx',
      });
      const stats = await fs.stat(target.targetPath);
      const entry = toPluginFileEntry(target.pluginRoot, target.targetPath, stats);
      refreshAppIcons?.({ force: true });
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

  const deletePluginFile = async (
    pluginId: string,
    filePath: string,
  ): Promise<PluginDeleteFileResult> => {
    const access = getLocalFilesAccess(pluginId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
      const input = String(filePath || '').trim();
      if (!input) return { ok: false, error: '文件路径为空' };
      if (input.includes('\0')) return { ok: false, error: '文件路径不能包含空字符' };

      const targetPath = resolvePluginFile(access.plugin.directory, input);
      if (!targetPath) return { ok: false, error: '删除路径必须位于插件目录内' };

      const pluginRoot = await fs.realpath(access.plugin.directory);
      const existed = await pathExists(targetPath);

      if (existed) {
        const targetRealPath = await fs.realpath(targetPath);
        if (!isPathInside(pluginRoot, targetRealPath)) {
          return { ok: false, error: '删除路径必须位于插件目录内' };
        }

        const stats = await fs.stat(targetPath);
        if (!stats.isFile()) return { ok: false, error: '删除路径不是文件' };

        await fs.rm(targetPath, { force: true });
      }

      if (existed) refreshAppIcons?.({ force: true });
      return {
        ok: true,
        name: basename(targetPath),
        path: targetPath,
        existed,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '文件删除失败',
      };
    }
  };

  return {
    listPluginFiles,
    listPluginImageFiles,
    getPluginFileUrl,
    readPluginTextFile,
    readPluginFileBytes,
    readPluginAudioMetadata,
    writePluginFile,
    deletePluginFile,
  };
};
