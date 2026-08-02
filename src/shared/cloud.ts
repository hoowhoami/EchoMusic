// 云盘上传相关的 IPC 类型定义（主进程选择文件/文件夹 → 渲染进程上传）

import { LOCAL_AUDIO_EXTENSIONS } from './local-music';

export type CloudPickMode = 'file' | 'folder';

export interface CloudUploadFile {
  /** 文件名（含扩展名） */
  name: string;
  /** 文件绝对路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件扩展名（含点号，小写） */
  extension: string;
  /** 文件最后修改时间 */
  modifiedAt: number;
  /** 内嵌标签解析出的歌名（解析失败时为空，由调用方降级为文件名） */
  title?: string;
  /** 内嵌标签解析出的歌手（解析失败时为空） */
  artist?: string;
  /** 内嵌标签解析出的时长（秒，解析失败时为空） */
  duration?: number;
}

export interface CloudPickFilesResult {
  canceled: boolean;
  files: CloudUploadFile[];
  /** 单个文件读取/大小校验失败的提示 */
  errors?: string[];
}

export type CloudReadUploadFileDataResult =
  | {
      ok: true;
      path: string;
      size: number;
      data: ArrayBuffer;
    }
  | {
      ok: false;
      error: string;
    };

/** 云盘上传单文件大小上限（与后端 express.raw limit 一致） */
export const CLOUD_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;

const CLOUD_UPLOAD_EXCLUDED_LOCAL_EXTENSIONS = new Set(['alac', 'webm', 'wv']);
const CLOUD_UPLOAD_EXTRA_EXTENSIONS = ['amr'];

/** 云盘上传支持的音频扩展名：基于本地播放格式派生，排除云盘业务暂不接收的格式。 */
export const CLOUD_UPLOAD_EXTENSIONS = [
  ...LOCAL_AUDIO_EXTENSIONS.filter(
    (extension) => !CLOUD_UPLOAD_EXCLUDED_LOCAL_EXTENSIONS.has(extension),
  ),
  ...CLOUD_UPLOAD_EXTRA_EXTENSIONS,
];
