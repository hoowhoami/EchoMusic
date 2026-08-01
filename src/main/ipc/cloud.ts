import fs from 'fs/promises';
import path from 'path';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { parseBuffer } from 'music-metadata';
import { ipcRegistry } from './registry';
import log from '../logger';
import type { IpcContext } from './types';
import type { CloudPickFilesResult, CloudUploadFile } from '../../shared/cloud';
import { CLOUD_UPLOAD_EXTENSIONS, CLOUD_UPLOAD_MAX_SIZE } from '../../shared/cloud';

const AUDIO_EXT_SET = new Set(CLOUD_UPLOAD_EXTENSIONS.map((ext) => ext.toLowerCase()));

const isAudioFile = (fileName: string): boolean => {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return AUDIO_EXT_SET.has(ext);
};

/**
 * 递归收集目录下的所有音频文件（按扩展名过滤）
 */
const collectAudioFiles = async (dir: string, result: string[] = []): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    log.warn('[CloudUpload] 读取目录失败:', { dir, error });
    return result;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAudioFiles(fullPath, result);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
};

/**
 * 解析音乐文件内嵌标签（歌名/歌手），失败静默降级为文件名格式推断
 * 文件名约定："歌手 - 歌名.mp3" 可拆分出歌手
 */
const resolveTitleAndArtist = (
  fileName: string,
  metadata?: { title?: string; artist?: string },
): { title: string; artist?: string } => {
  const tagTitle = metadata?.title?.trim();
  const tagArtist = metadata?.artist?.trim();
  const baseName = path.basename(fileName, path.extname(fileName)).trim();

  if (tagTitle) {
    return { title: tagTitle, artist: tagArtist || undefined };
  }

  // 无内嵌歌名时降级为文件名；若文件名为 "歌手 - 歌名" 格式则拆分
  if (tagArtist) {
    return { title: baseName, artist: tagArtist };
  }
  const splitIndex = baseName.indexOf(' - ');
  if (splitIndex > 0 && splitIndex < baseName.length - 3) {
    return {
      title: baseName.slice(splitIndex + 3).trim(),
      artist: baseName.slice(0, splitIndex).trim(),
    };
  }
  return { title: baseName };
};

/**
 * 读取单个文件为 Buffer，校验大小上限，并解析内嵌标签与时长
 */
const readUploadFile = async (filePath: string): Promise<CloudUploadFile | null> => {
  const stat = await fs.stat(filePath);
  if (stat.size <= 0) return null;
  if (stat.size > CLOUD_UPLOAD_MAX_SIZE) return null;

  const data = await fs.readFile(filePath);

  // 基于已读 Buffer 解析标签（parseBuffer 无额外磁盘 IO；duration 用于匹配评分）
  let metadata: { title?: string; artist?: string; duration?: number } | undefined;
  try {
    const parsed = await parseBuffer(data, path.extname(filePath).slice(1), {
      duration: true,
      skipCovers: true,
    });
    metadata = {
      title: parsed.common.title || undefined,
      artist: parsed.common.artist || undefined,
      duration: parsed.format.duration || undefined,
    };
  } catch (error) {
    log.debug('[CloudUpload] 标签解析失败，降级为文件名:', { filePath, error });
  }

  const { title, artist } = resolveTitleAndArtist(path.basename(filePath), metadata);
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    data,
    title,
    artist,
    duration: metadata?.duration,
  };
};

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

      // 展开路径：单曲模式直接使用所选文件，文件夹模式递归收集音频文件
      let paths: string[] = [];
      if (mode === 'folder') {
        for (const dir of result.filePaths) {
          paths = paths.concat(await collectAudioFiles(dir));
        }
      } else {
        paths = result.filePaths;
      }

      if (paths.length === 0) {
        return { canceled: false, files: [], errors: ['所选位置没有可上传的音频文件'] };
      }

      const files: CloudUploadFile[] = [];
      const errors: string[] = [];
      for (const filePath of paths) {
        try {
          const file = await readUploadFile(filePath);
          if (file) {
            files.push(file);
          } else {
            errors.push(`${path.basename(filePath)}: 文件为空或超过 100MB 限制`);
          }
        } catch (error) {
          log.warn('[CloudUpload] 读取文件失败:', { filePath, error });
          errors.push(`${path.basename(filePath)}: 文件读取失败`);
        }
      }

      return {
        canceled: false,
        files,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  );
};
