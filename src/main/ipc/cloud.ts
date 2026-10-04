import fs from 'fs/promises';
import path from 'path';
import { dialog, type BrowserWindow, type OpenDialogOptions, type WebContents } from 'electron';
import { ipcRegistry } from './registry';
import log from '../logger';
import type { IpcContext } from './types';
import type {
  CloudPickFilesResult,
  CloudReadUploadFileDataResult,
  CloudUploadFile,
} from '../../shared/cloud';
import { CLOUD_UPLOAD_EXTENSIONS, CLOUD_UPLOAD_MAX_SIZE } from '../../shared/cloud';
import type { LocalAudioMetadata } from '../../shared/localMusic';
import { readAudioMetadata, resolveAudioTitleAndArtist } from '../media/audioMetadata';
import {
  normalizeFileExtension,
  scanLocalFiles,
  type ScannedLocalFile,
} from '../media/fileScanner';

const UPLOAD_EXTENSION_SET = new Set(CLOUD_UPLOAD_EXTENSIONS.map(normalizeFileExtension));
type UploadSelection = { files: Set<string>; generation: number };
const uploadSelections = new WeakMap<WebContents, UploadSelection>();
const UPLOAD_METADATA_CONCURRENCY = 4;
const UPLOAD_READ_CHUNK_SIZE = 512 * 1024;

const clearAllowedUploadFilePaths = (webContents: WebContents) => {
  const selection = uploadSelections.get(webContents);
  if (!selection) return;
  selection.generation++;
  selection.files.clear();
};

const getUploadSelection = (webContents: WebContents) => {
  if (webContents.isDestroyed()) return null;
  let selection = uploadSelections.get(webContents);
  if (!selection) {
    selection = { files: new Set<string>(), generation: 0 };
    uploadSelections.set(webContents, selection);
    webContents.once('destroyed', () => {
      clearAllowedUploadFilePaths(webContents);
      uploadSelections.delete(webContents);
    });
  }
  return selection;
};

const captureUploadSelection = (webContents: WebContents, selection: UploadSelection) => {
  const generation = selection.generation;
  return () =>
    !webContents.isDestroyed() &&
    uploadSelections.get(webContents) === selection &&
    generation === selection.generation;
};

const isUploadAudioExtension = (extension: string): boolean =>
  UPLOAD_EXTENSION_SET.has(normalizeFileExtension(extension));

const formatUploadMaxSize = () => `${Math.floor(CLOUD_UPLOAD_MAX_SIZE / 1024 / 1024)}MB`;

const getUploadSizeLimitError = () => `文件为空或超过 ${formatUploadMaxSize()} 限制`;

const showPickDialog = (
  win: BrowserWindow | null,
  mode: 'file' | 'folder',
  multi = true,
): Promise<Electron.OpenDialogReturnValue> => {
  const options: OpenDialogOptions =
    mode === 'folder'
      ? {
          title: '选择要上传的文件夹',
          properties: ['openDirectory'],
        }
      : {
          title: '选择要上传的音乐文件',
          properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
          filters: [
            { name: '音频文件', extensions: [...CLOUD_UPLOAD_EXTENSIONS] },
            { name: '所有文件', extensions: ['*'] },
          ],
        };
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
};

const toScannedUploadFile = async (filePath: string): Promise<ScannedLocalFile | null> => {
  const resolvedPath = await fs.realpath(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!isUploadAudioExtension(extension)) return null;
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) return null;
  return {
    name: path.basename(resolvedPath),
    path: resolvedPath,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    extension,
    relativePath: '',
    kind: 'audio',
  };
};

const readUploadFileDescriptor = async (
  file: ScannedLocalFile,
): Promise<CloudUploadFile | null> => {
  if (file.size <= 0 || file.size > CLOUD_UPLOAD_MAX_SIZE) return null;

  let metadata: LocalAudioMetadata | undefined;
  try {
    // parseFile 流式解析标签，不做全量 Buffer；每文件 pick/read 两次 IO 是有意换取
    // “pick 阶段不读文件内容”的内存收益。
    metadata = await readAudioMetadata(file.path);
  } catch (error) {
    log.debug('[CloudUpload] 标签解析失败，降级为文件名:', { filePath: file.path, error });
  }

  const { title, artist } = resolveAudioTitleAndArtist(file.name, metadata);
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    extension: file.extension,
    modifiedAt: file.modifiedAt,
    title,
    artist,
    duration: metadata?.duration,
  };
};

const collectUploadCandidates = async (
  selectedPaths: string[],
  mode: 'file' | 'folder',
  errors: string[],
): Promise<ScannedLocalFile[]> => {
  if (mode === 'file') {
    const files: ScannedLocalFile[] = [];
    for (const filePath of selectedPaths) {
      try {
        const file = await toScannedUploadFile(filePath);
        if (file) {
          files.push(file);
        } else {
          errors.push(`${path.basename(filePath)}: 不是支持的音频文件`);
        }
      } catch (error) {
        log.debug('[CloudUpload] 读取文件状态失败:', { filePath, error });
        errors.push(`${path.basename(filePath)}: 文件读取失败`);
      }
    }
    return files;
  }

  const files: ScannedLocalFile[] = [];
  for (const directoryPath of selectedPaths) {
    try {
      const scan = await scanLocalFiles(directoryPath, {
        recursive: true,
        extensions: CLOUD_UPLOAD_EXTENSIONS,
        // 过滤已由 extensions 完成；这里仅保持 folder 模式与 file 模式的 kind 语义一致。
        getKind: (extension) => (isUploadAudioExtension(extension) ? 'audio' : 'other'),
        limit: 10000,
        onError: (message) => errors.push(message),
      });
      files.push(...scan.files);
      if (scan.limitReached) {
        errors.push(`${path.basename(scan.root)}: 文件数量超过扫描上限，已截断`);
      }
    } catch (error) {
      log.debug('[CloudUpload] 扫描目录失败:', { directoryPath, error });
      errors.push(`${path.basename(directoryPath)}: 文件夹读取失败`);
    }
  }
  return files;
};

const readAllowedUploadFileData = async (
  webContents: WebContents,
  filePath: string,
): Promise<CloudReadUploadFileDataResult> => {
  const selection = uploadSelections.get(webContents);
  const denied = (): CloudReadUploadFileDataResult => ({
    ok: false,
    error: '文件不在本次上传选择范围内',
  });
  if (!selection || webContents.isDestroyed()) return denied();
  const isCurrent = captureUploadSelection(webContents, selection);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const closeHandle = async () => {
    const opened = handle;
    handle = undefined;
    await opened?.close().catch((error) => {
      log.debug('[CloudUpload] 关闭上传文件失败:', { filePath, error });
    });
  };
  try {
    const resolvedPath = await fs.realpath(String(filePath || '').trim());
    const isAllowed = () => isCurrent() && selection.files.has(resolvedPath);
    if (!isAllowed()) return denied();
    if (!isUploadAudioExtension(path.extname(resolvedPath))) {
      return { ok: false, error: '不是支持的音频文件' };
    }
    handle = await fs.open(resolvedPath, 'r');
    if (!isAllowed()) return denied();
    const stat = await handle.stat();
    if (!isAllowed()) return denied();
    if (!stat.isFile()) return { ok: false, error: '路径不是文件' };
    if (stat.size <= 0 || stat.size > CLOUD_UPLOAD_MAX_SIZE) {
      return { ok: false, error: getUploadSizeLimitError() };
    }
    // 固定已验证的大小，分块读取；文件增长不会触发不受限的 readFile 分配。
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        Math.min(UPLOAD_READ_CHUNK_SIZE, data.length - offset),
        offset,
      );
      if (!isAllowed()) return denied();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    if (!isAllowed()) return denied();
    if (offset !== data.length || extraBytes > 0) {
      return { ok: false, error: '文件在读取期间发生变化，请重新选择' };
    }
    await closeHandle();
    if (!isAllowed()) return denied();
    return {
      ok: true,
      path: resolvedPath,
      size: data.length,
      data: data.buffer as ArrayBuffer,
    };
  } catch (error) {
    if (!isCurrent()) return denied();
    log.debug('[CloudUpload] 读取上传文件失败:', { filePath, error });
    return { ok: false, error: error instanceof Error ? error.message : '文件读取失败' };
  } finally {
    if (handle) await closeHandle();
  }
};

export const registerCloudHandlers = (context: IpcContext) => {
  ipcRegistry.registerHandler(
    'cloud:pick-upload-files',
    async (_event, mode: 'file' | 'folder', multi = true): Promise<CloudPickFilesResult> => {
      if (mode !== 'file' && mode !== 'folder') {
        return { canceled: true, files: [] };
      }

      const sender = _event.sender;
      const selection = getUploadSelection(sender);
      const canceled = (): CloudPickFilesResult => ({ canceled: true, files: [] });
      if (!selection) return canceled();
      selection.generation++;
      const isCurrent = captureUploadSelection(sender, selection);
      const win = context.getMainWindow();
      let result: Electron.OpenDialogReturnValue;
      try {
        result = await showPickDialog(win, mode, multi);
      } catch (error) {
        if (!isCurrent()) return canceled();
        throw error;
      }
      if (!isCurrent()) return canceled();
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, files: [] };
      }

      selection.files.clear();
      const errors: string[] = [];
      const paths = await collectUploadCandidates(result.filePaths, mode, errors);
      if (!isCurrent()) return canceled();
      if (paths.length === 0) {
        return { canceled: false, files: [], errors: ['所选位置没有可上传的音频文件'] };
      }

      const uniquePaths = [...new Map(paths.map((file) => [file.path, file])).values()];
      const descriptors: Array<CloudUploadFile | null> = new Array(uniquePaths.length).fill(null);
      const fileErrors: Array<string | undefined> = new Array(uniquePaths.length);
      let next = 0;
      const worker = async () => {
        while (isCurrent() && next < uniquePaths.length) {
          const index = next++;
          const filePath = uniquePaths[index];
          try {
            const file = await readUploadFileDescriptor(filePath);
            if (!isCurrent()) return;
            if (file) descriptors[index] = file;
            else
              fileErrors[index] = `${path.basename(filePath.path)}: ${getUploadSizeLimitError()}`;
          } catch (error) {
            if (!isCurrent()) return;
            log.debug('[CloudUpload] 读取文件信息失败:', { filePath: filePath.path, error });
            fileErrors[index] = `${path.basename(filePath.path)}: 文件读取失败`;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_METADATA_CONCURRENCY, uniquePaths.length) }, worker),
      );
      if (!isCurrent()) return canceled();
      const files = descriptors.filter((file): file is CloudUploadFile => file !== null);
      errors.push(...fileErrors.filter((error): error is string => error !== undefined));
      selection.files = new Set(files.map((file) => file.path));

      return {
        canceled: false,
        files,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  );

  ipcRegistry.registerHandler('cloud:read-upload-file-data', (_event, filePath: string) =>
    readAllowedUploadFileData(_event.sender, filePath),
  );

  ipcRegistry.registerHandler('cloud:clear-upload-files', (_event) => {
    clearAllowedUploadFilePaths(_event.sender);
    return { ok: true };
  });
};
