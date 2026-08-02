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
import type { LocalAudioMetadata } from '../../shared/local-music';
import { readAudioMetadata, resolveAudioTitleAndArtist } from '../media/audioMetadata';
import {
  normalizeFileExtension,
  scanLocalFiles,
  type ScannedLocalFile,
} from '../media/fileScanner';

const UPLOAD_EXTENSION_SET = new Set(CLOUD_UPLOAD_EXTENSIONS.map(normalizeFileExtension));
const allowedUploadFilePathsByWebContents = new Map<number, Set<string>>();

const getAllowedUploadFilePaths = (webContents: WebContents) => {
  const webContentsId = webContents.id;
  let filePaths = allowedUploadFilePathsByWebContents.get(webContentsId);
  if (!filePaths) {
    filePaths = new Set<string>();
    allowedUploadFilePathsByWebContents.set(webContentsId, filePaths);
    webContents.once('destroyed', () => clearAllowedUploadFilePaths(webContentsId));
  }
  return filePaths;
};

const clearAllowedUploadFilePaths = (webContentsId: number) => {
  allowedUploadFilePathsByWebContents.delete(webContentsId);
};

const isUploadAudioExtension = (extension: string): boolean =>
  UPLOAD_EXTENSION_SET.has(normalizeFileExtension(extension));

const formatUploadMaxSize = () => `${Math.floor(CLOUD_UPLOAD_MAX_SIZE / 1024 / 1024)}MB`;

const getUploadSizeLimitError = () => `文件为空或超过 ${formatUploadMaxSize()} 限制`;

const showPickDialog = (
  win: BrowserWindow | null,
  mode: 'file' | 'folder',
): Promise<Electron.OpenDialogReturnValue> => {
  const options: OpenDialogOptions =
    mode === 'folder'
      ? {
          title: '选择要上传的文件夹',
          properties: ['openDirectory'],
        }
      : {
          title: '选择要上传的音乐文件',
          properties: ['openFile', 'multiSelections'],
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
  webContentsId: number,
  filePath: string,
): Promise<CloudReadUploadFileDataResult> => {
  try {
    const resolvedPath = await fs.realpath(String(filePath || '').trim());
    const allowedUploadFilePaths = allowedUploadFilePathsByWebContents.get(webContentsId);
    if (!allowedUploadFilePaths?.has(resolvedPath)) {
      return { ok: false, error: '文件不在本次上传选择范围内' };
    }
    if (!isUploadAudioExtension(path.extname(resolvedPath))) {
      return { ok: false, error: '不是支持的音频文件' };
    }
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) return { ok: false, error: '路径不是文件' };
    if (stat.size <= 0 || stat.size > CLOUD_UPLOAD_MAX_SIZE) {
      return { ok: false, error: getUploadSizeLimitError() };
    }
    const data = await fs.readFile(resolvedPath);
    return {
      ok: true,
      path: resolvedPath,
      size: stat.size,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    };
  } catch (error) {
    log.debug('[CloudUpload] 读取上传文件失败:', { filePath, error });
    return { ok: false, error: error instanceof Error ? error.message : '文件读取失败' };
  }
};

export const registerCloudHandlers = (context: IpcContext) => {
  ipcRegistry.registerHandler(
    'cloud:pick-upload-files',
    async (_event, mode: 'file' | 'folder'): Promise<CloudPickFilesResult> => {
      if (mode !== 'file' && mode !== 'folder') {
        return { canceled: true, files: [] };
      }

      const win = context.getMainWindow();
      const result = await showPickDialog(win, mode);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, files: [] };
      }

      const errors: string[] = [];
      const paths = await collectUploadCandidates(result.filePaths, mode, errors);
      if (paths.length === 0) {
        return { canceled: false, files: [], errors: ['所选位置没有可上传的音频文件'] };
      }

      const files: CloudUploadFile[] = [];
      const allowedUploadFilePaths = getAllowedUploadFilePaths(_event.sender);
      allowedUploadFilePaths.clear();
      for (const filePath of paths) {
        try {
          const file = await readUploadFileDescriptor(filePath);
          if (file) {
            files.push(file);
            allowedUploadFilePaths.add(file.path);
          } else {
            errors.push(`${path.basename(filePath.path)}: ${getUploadSizeLimitError()}`);
          }
        } catch (error) {
          log.debug('[CloudUpload] 读取文件信息失败:', { filePath: filePath.path, error });
          errors.push(`${path.basename(filePath.path)}: 文件读取失败`);
        }
      }

      return {
        canceled: false,
        files,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  );

  ipcRegistry.registerHandler('cloud:read-upload-file-data', (_event, filePath: string) =>
    readAllowedUploadFileData(_event.sender.id, filePath),
  );

  ipcRegistry.registerHandler('cloud:clear-upload-files', (_event) => {
    clearAllowedUploadFilePaths(_event.sender.id);
    return { ok: true };
  });
};
