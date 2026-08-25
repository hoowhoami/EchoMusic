export interface SpatialAudioEffectEntry {
  id: string;
  name: string;
  size: number;
  importedAt: number;
  format?: string;
  kind: 'imported-ir' | 'community-ir' | 'community-vpf' | 'community-combined';
  impulseResponsePath?: string;
  vpfPath?: string;
}

export interface ImportImpulseResponseResult {
  canceled: boolean;
  file?: SpatialAudioEffectEntry;
  files?: SpatialAudioEffectEntry[];
  error?: string;
  errors?: string[];
}

export interface DownloadCommunityAudioEffectRequest {
  modelId: string | number;
  name: string;
  impulseResponseUrls: string[];
  vpfUrls: string[];
}

export interface DownloadCommunityAudioEffectResult {
  file?: SpatialAudioEffectEntry;
  error?: string;
}

export interface AudioEffectPlaybackOptions {
  providerPath?: string | null;
  providerPresetJson?: string | null;
  providerResources?: Array<{ kind: string; path: string }>;
  providerMode?: 'headphone' | 'speaker';
  impulseResponsePath?: string | null;
}

export interface DspProviderInspection {
  providerId: string;
  providerVersion: string;
  latencyFrames: number;
  preferredBlockFrames: number;
  maxChannels: number;
  manifestJson: string;
  stateJson: string;
}

const AUDIO_EFFECT_DISPLAY_EXTENSION =
  /\.(irs|wav|wave|flac|aif|aiff|caf|ogg|oga|mp3|m4a|aac|opus|vpf)$/i;
const COMMUNITY_IMPULSE_RESPONSE_EXTENSION = /\.(irs|wav|wave)$/i;
const COMMUNITY_VPF_EXTENSION = /\.vpf$/i;

export type CommunityAudioResourceKind = 'impulse-response' | 'vpf';

export const normalizeCommunityAudioResourceUrl = (
  value: unknown,
  kind: CommunityAudioResourceKind | null,
  requireExtension = true,
): URL | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || (url.port && url.port !== '443')) return null;
    if (hostname !== 'kugou.com' && !hostname.endsWith('.kugou.com')) return null;
    if (!requireExtension || kind === null) return url;
    const extension =
      kind === 'vpf' ? COMMUNITY_VPF_EXTENSION : COMMUNITY_IMPULSE_RESPONSE_EXTENSION;
    return extension.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
};

export const normalizeCommunityImpulseResponseUrl = (
  value: unknown,
  requireAudioExtension = true,
): URL | null =>
  normalizeCommunityAudioResourceUrl(value, 'impulse-response', requireAudioExtension);

export const normalizeCommunityVpfUrl = (value: unknown): URL | null =>
  normalizeCommunityAudioResourceUrl(value, 'vpf');

export const normalizeAudioEffectName = (name: string): string => {
  const normalized = String(name ?? '')
    .trim()
    .replace(AUDIO_EFFECT_DISPLAY_EXTENSION, '')
    .trim();
  return normalized || '未命名音效';
};
