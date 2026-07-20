import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue } from '@/types';
import type { PlaybackSource, ResolvedAudioSource } from '@/stores/player/types';

export interface PluginAudioSourceResolveContext {
  track: Song;
  quality: AudioQualityValue;
  effect: AudioEffectValue;
  forceReload: boolean;
}

export type PluginAudioSourceResolveResult =
  | string
  | Partial<ResolvedAudioSource>
  | null
  | undefined
  | false;

export interface PluginAudioSourceResolverContribution {
  id?: string;
  order?: number;
  match?: (context: PluginAudioSourceResolveContext) => boolean | Promise<boolean>;
  resolve: (
    context: PluginAudioSourceResolveContext,
  ) => PluginAudioSourceResolveResult | Promise<PluginAudioSourceResolveResult>;
}

interface RegisteredPluginAudioSourceResolver {
  pluginId: string;
  id: string;
  order: number;
  match?: PluginAudioSourceResolverContribution['match'];
  resolve: PluginAudioSourceResolverContribution['resolve'];
  onError?: (source: string, error: unknown) => void;
}

const audioSourceResolvers: RegisteredPluginAudioSourceResolver[] = [];

const normalizeAudioQuality = (value: unknown): AudioQualityValue | null =>
  value === '128' || value === '320' || value === 'flac' || value === 'high' || value === 'super'
    ? value
    : null;

const normalizeAudioEffect = (value: unknown): AudioEffectValue => {
  const effects: AudioEffectValue[] = [
    'none',
    'piano',
    'vocal',
    'accompaniment',
    'subwoofer',
    'ancient',
    'surnay',
    'dj',
    'viper_tape',
    'viper_atmos',
    'viper_clear',
  ];
  return effects.includes(value as AudioEffectValue) ? (value as AudioEffectValue) : 'none';
};

const normalizePlaybackSource = (
  value: unknown,
  fallbackAudioTrackId?: number | null,
): PlaybackSource | null => {
  const source =
    typeof value === 'string'
      ? { url: value, audioTrackId: fallbackAudioTrackId ?? null }
      : (value as Partial<PlaybackSource> | null | undefined);
  const url = String(source?.url || '').trim();
  if (!url) return null;
  const rawAudioTrackId =
    source?.audioTrackId !== undefined && source.audioTrackId !== null
      ? Number(source.audioTrackId)
      : (fallbackAudioTrackId ?? null);
  const audioTrackId = Number(rawAudioTrackId);
  return {
    url,
    audioTrackId: Number.isFinite(audioTrackId) && audioTrackId > 0 ? audioTrackId : null,
  };
};

const normalizeResolvedAudioSource = (
  result: PluginAudioSourceResolveResult,
): ResolvedAudioSource | null => {
  const value = typeof result === 'string' ? { url: result } : result;
  if (!value || typeof value !== 'object') return null;

  const audioTrackId =
    value.audioTrackId !== undefined && value.audioTrackId !== null
      ? Number(value.audioTrackId)
      : null;
  const rawSources = Array.isArray(value.sources) ? value.sources : [];
  const firstSourceFromList =
    rawSources
      .map((item) => normalizePlaybackSource(item, audioTrackId))
      .find((item): item is PlaybackSource => !!item) ?? null;
  const source =
    normalizePlaybackSource(value.source, audioTrackId) ??
    normalizePlaybackSource(value.url, audioTrackId) ??
    firstSourceFromList;
  if (!source) return null;

  const sources: PlaybackSource[] = [source];
  rawSources.forEach((item) => {
    const candidate = normalizePlaybackSource(item, source.audioTrackId);
    if (
      candidate &&
      !sources.some(
        (existing) =>
          existing.url === candidate.url && existing.audioTrackId === candidate.audioTrackId,
      )
    ) {
      sources.push(candidate);
    }
  });

  const urls = [source.url];
  if (Array.isArray(value.urls)) {
    value.urls.forEach((item) => {
      const candidate = String(item || '').trim();
      if (candidate && !urls.includes(candidate)) urls.push(candidate);
    });
  }
  sources.forEach((item) => {
    if (!urls.includes(item.url)) urls.push(item.url);
  });

  const loudness = value.loudness;
  const normalizedLoudness: TrackLoudness | null =
    loudness &&
    typeof loudness === 'object' &&
    Number.isFinite(Number(loudness.lufs)) &&
    Number.isFinite(Number(loudness.gain)) &&
    Number.isFinite(Number(loudness.peak))
      ? {
          lufs: Number(loudness.lufs),
          gain: Number(loudness.gain),
          peak: Number(loudness.peak),
        }
      : null;

  return {
    url: source.url,
    urls,
    audioTrackId: source.audioTrackId,
    source,
    sources,
    quality: normalizeAudioQuality(value.quality),
    effect: normalizeAudioEffect(value.effect),
    loudness: normalizedLoudness,
  };
};

const sortAudioSourceResolvers = () => {
  audioSourceResolvers.sort(
    (left, right) =>
      left.order - right.order ||
      left.pluginId.localeCompare(right.pluginId, 'zh-Hans-CN') ||
      left.id.localeCompare(right.id, 'zh-Hans-CN'),
  );
};

export const registerPluginAudioSourceResolver = (
  pluginId: string,
  contribution: PluginAudioSourceResolverContribution,
  onError?: (source: string, error: unknown) => void,
) => {
  const id = String(contribution.id || 'default').trim() || 'default';
  const key = `${pluginId}:${id}`;
  const existingIndex = audioSourceResolvers.findIndex(
    (item) => item.pluginId === pluginId && item.id === id,
  );
  if (existingIndex >= 0) audioSourceResolvers.splice(existingIndex, 1);

  if (typeof contribution.resolve !== 'function') {
    throw new Error('音源解析 resolve 必须是函数');
  }

  audioSourceResolvers.push({
    pluginId,
    id,
    order: Number(contribution.order ?? 1000),
    match: contribution.match,
    resolve: contribution.resolve,
    onError,
  });
  sortAudioSourceResolvers();

  return () => {
    const index = audioSourceResolvers.findIndex((item) => `${item.pluginId}:${item.id}` === key);
    if (index >= 0) audioSourceResolvers.splice(index, 1);
  };
};

export const removeAudioSourceResolversByPlugin = (pluginId: string) => {
  for (let index = audioSourceResolvers.length - 1; index >= 0; index -= 1) {
    if (audioSourceResolvers[index].pluginId === pluginId) {
      audioSourceResolvers.splice(index, 1);
    }
  }
};

export const resolvePluginAudioSource = async (
  context: PluginAudioSourceResolveContext,
): Promise<ResolvedAudioSource | null> => {
  for (const resolver of audioSourceResolvers.slice()) {
    const source = `音源解析: ${resolver.id}`;
    try {
      const matched = resolver.match ? await resolver.match(context) : true;
      if (!matched) continue;

      const result = normalizeResolvedAudioSource(await resolver.resolve(context));
      if (result) return result;
    } catch (error) {
      resolver.onError?.(source, error);
    }
  }

  return null;
};
