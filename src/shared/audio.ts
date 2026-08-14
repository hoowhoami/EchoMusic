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

export interface DownloadCommunityImpulseResponseRequest {
  modelId: string | number;
  name: string;
  urls: string[];
}

export interface DownloadCommunityImpulseResponseResult {
  file?: ImpulseResponseFile;
  error?: string;
}

export interface ImpulseResponsePlaybackOptions {
  filePath: string;
  mix: number;
}

export const DEFAULT_IMPULSE_RESPONSE_MIX = 0.15;

const IMPULSE_RESPONSE_DISPLAY_EXTENSION =
  /\.(irs|wav|wave|flac|aif|aiff|caf|ogg|oga|mp3|m4a|aac|opus)$/i;
const COMMUNITY_IMPULSE_RESPONSE_EXTENSION = /\.(wav|wave)$/i;

export const normalizeCommunityImpulseResponseUrl = (
  value: unknown,
  requireAudioExtension = true,
): URL | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || (url.port && url.port !== '443')) return null;
    if (hostname !== 'kugou.com' && !hostname.endsWith('.kugou.com')) return null;
    if (requireAudioExtension && !COMMUNITY_IMPULSE_RESPONSE_EXTENSION.test(url.pathname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

export const normalizeImpulseResponseName = (name: string): string => {
  const normalized = String(name ?? '')
    .trim()
    .replace(IMPULSE_RESPONSE_DISPLAY_EXTENSION, '')
    .trim();
  return normalized || '未命名音效';
};
