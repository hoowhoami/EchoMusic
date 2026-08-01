// 云盘上传相关的 IPC 类型定义（主进程选择文件/文件夹 → 渲染进程上传）

export type CloudPickMode = 'file' | 'folder';

export interface CloudUploadFile {
  /** 文件名（含扩展名） */
  name: string;
  /** 文件绝对路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件二进制内容（经 IPC 结构化克隆传输为 ArrayBuffer） */
  data: Buffer;
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

/** 云盘上传单文件大小上限（与后端 express.raw limit 一致） */
export const CLOUD_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;

/** 云盘上传支持的音频扩展名 */
export const CLOUD_UPLOAD_EXTENSIONS = [
  'mp3',
  'flac',
  'wav',
  'wave',
  'ape',
  'wma',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'amr',
  'aif',
  'aiff',
  'caf',
  'dsf',
  'dff',
];
