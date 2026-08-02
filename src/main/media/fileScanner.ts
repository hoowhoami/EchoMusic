import fs from 'fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'path';

export interface ScannedLocalFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  extension: string;
  relativePath: string;
  kind: string;
}

export interface ScanLocalFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  limit?: number;
  maxDepth?: number;
  maxFileSize?: number;
  extensions?: Iterable<string>;
  kinds?: Iterable<string>;
  includeOther?: boolean;
  getKind?: (extension: string) => string;
  onError?: (message: string) => void;
}

export interface ScanLocalFilesResult {
  root: string;
  files: ScannedLocalFile[];
  limitReached: boolean;
}

const DEFAULT_SCAN_LIMIT = 2000;
const MAX_SCAN_LIMIT = 10000;
const DEFAULT_SCAN_DEPTH = 32;
const MAX_SCAN_DEPTH = 64;

export const normalizeFileExtension = (value: string) => {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (!text) return '';
  return text.startsWith('.') ? text : `.${text}`;
};

export const normalizeFileExtensions = (extensions?: Iterable<string>) =>
  new Set(
    Array.from(extensions ?? [])
      .map(normalizeFileExtension)
      .filter((extension) => /^\.[a-z0-9]+$/i.test(extension)),
  );

const normalizeLimit = (value: unknown) => {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_SCAN_LIMIT;
  return Math.min(Math.floor(limit), MAX_SCAN_LIMIT);
};

const normalizeDepth = (value: unknown) => {
  const depth = Number(value);
  if (!Number.isFinite(depth) || depth < 0) return DEFAULT_SCAN_DEPTH;
  return Math.min(Math.floor(depth), MAX_SCAN_DEPTH);
};

const normalizeMaxFileSize = (value: unknown) => {
  const maxFileSize = Number(value);
  if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) return 0;
  return Math.floor(maxFileSize);
};

export const toPortableRelativePath = (root: string, filePath: string) => {
  const value = relative(root, filePath);
  return sep === '/' ? value : value.split(sep).join('/');
};

export const scanLocalFiles = async (
  rootPath: string,
  options: ScanLocalFilesOptions = {},
): Promise<ScanLocalFilesResult> => {
  const input = String(rootPath || '').trim();
  if (!input) throw new Error('文件夹路径为空');

  const root = await fs.realpath(resolve(input));
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) throw new Error('路径不是文件夹');

  const recursive = Boolean(options.recursive);
  const includeHidden = Boolean(options.includeHidden);
  const limit = normalizeLimit(options.limit);
  const maxDepth = normalizeDepth(options.maxDepth);
  const maxFileSize = normalizeMaxFileSize(options.maxFileSize);
  const extensions = normalizeFileExtensions(options.extensions);
  const kinds = new Set(Array.from(options.kinds ?? []).map((kind) => String(kind)));
  const includeOther = options.includeOther ?? true;
  const getKind = options.getKind ?? (() => 'other');
  const files: ScannedLocalFile[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let limitReached = false;

  const shouldIncludeFile = (file: ScannedLocalFile) => {
    if (maxFileSize > 0 && file.size > maxFileSize) return false;
    if (extensions.size > 0) {
      // 扩展名白名单命中时，且调用方未传 kinds，getKind/includeOther 不参与过滤。
      if (!extensions.has(file.extension)) return false;
      return kinds.size > 0 ? kinds.has(file.kind) : true;
    }
    if (kinds.size > 0) return kinds.has(file.kind);
    return includeOther || file.kind !== 'other';
  };

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      options.onError?.(
        `${current.directory}: ${error instanceof Error ? error.message : '文件夹读取失败'}`,
      );
      continue;
    }

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const fullPath = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive && current.depth < maxDepth) {
          queue.push({ directory: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stats = await fs.stat(fullPath);
        const extension = extname(entry.name).toLowerCase();
        const file: ScannedLocalFile = {
          name: basename(fullPath),
          path: fullPath,
          size: stats.size,
          modifiedAt: stats.mtimeMs,
          extension,
          relativePath: toPortableRelativePath(root, fullPath),
          kind: getKind(extension),
        };
        if (!shouldIncludeFile(file)) continue;
        files.push(file);
      } catch (error) {
        options.onError?.(
          `${fullPath}: ${error instanceof Error ? error.message : '文件读取失败'}`,
        );
      }

      if (files.length >= limit) {
        limitReached = true;
        break;
      }
    }
  }

  return { root, files, limitReached };
};
