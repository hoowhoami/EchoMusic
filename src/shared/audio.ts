export interface ImpulseResponseFile {
  id: string;
  name: string;
  path: string;
  size: number;
  importedAt: number;
  format?: string;
}

export interface ImportImpulseResponseResult {
  canceled: boolean;
  file?: ImpulseResponseFile;
  files?: ImpulseResponseFile[];
  error?: string;
  errors?: string[];
}

export interface ImpulseResponsePlaybackOptions {
  filePath: string;
  mix: number;
}

export const DEFAULT_IMPULSE_RESPONSE_MIX = 0.15;

const IMPULSE_RESPONSE_DISPLAY_EXTENSION =
  /\.(irs|wav|wave|flac|aif|aiff|caf|ogg|oga|mp3|m4a|aac|opus)$/i;

export const normalizeImpulseResponseName = (name: string): string => {
  const normalized = String(name ?? '')
    .trim()
    .replace(IMPULSE_RESPONSE_DISPLAY_EXTENSION, '')
    .trim();
  return normalized || '未命名音效';
};
