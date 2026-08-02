export interface LocalAudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  year?: number;
  track?: number;
  disk?: number;
  genre?: string[];
}

export interface LocalAudioFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  extension: string;
  relativePath: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface LocalAudioScanOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  limit?: number;
  maxDepth?: number;
  maxFileSize?: number;
}

export interface LocalAudioScanResult {
  root: string;
  files: LocalAudioFile[];
  errors?: string[];
  limitReached: boolean;
}

// 该清单 = 本地可播放格式 = FFmpeg 引擎
// native/echo-ffmpeg-player/vendor/ffmpeg-audio/scripts/generate_config.ts
// decoder/demuxer 白名单支持集，作为唯一事实源。
// amr 虽在 FFmpeg 白名单中，但当前仅作为云盘上传业务格式保留，不纳入本地播放清单。
export const LOCAL_AUDIO_EXTENSIONS = [
  'aac',
  'aif',
  'aiff',
  'alac',
  'ape',
  'caf',
  'dff',
  'dsf',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wave',
  'webm',
  'wma',
  'wv',
];
