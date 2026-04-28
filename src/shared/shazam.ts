/** 听歌识曲相关类型定义 */

/** 识别状态 */
export type RecognizeStatus = 'idle' | 'recording' | 'recognizing' | 'success' | 'failed';

/** Shazam 识别结果（精简） */
export interface ShazamResult {
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  /** Shazam 歌曲链接 */
  shazamUrl?: string;
}

/** 主进程返回给渲染进程的识别响应 */
export interface RecognizeResponse {
  success: boolean;
  result?: ShazamResult;
  error?: string;
}
