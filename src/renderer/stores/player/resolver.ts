import { getCloudSongUrl, getSongClimax, getSongPrivilegeLite, getSongUrl } from '@/api/music';
import type { CloudAudioSource, Song, SongRelateGood } from '@/models/song';
import logger from '@/utils/logger';
import { normalizeCoverUrl } from '@/utils/cover';
import {
  doesRelateGoodMatchQuality,
  getSongQualityCandidates,
  resolveEffectiveSongQuality,
} from '@/utils/song';
import {
  resolvePluginAudioSource,
  transformPluginAudioSource,
  type PluginAudioSourceTransformStage,
} from '@/plugins/audioSource';
import { getCloudAudioSourceForSong } from '@/services/cloudAudioIndex';
import type { AudioQualityValue } from '../../types';
import type { PlayerState } from './state';
import {
  normalizeEffect,
  normalizeQuality,
  resolveTrackLoudness,
  resolveUrlsFromResponse,
  summarizeSong,
} from './utils';
import type { ClimaxMark, PlaybackSource, ResolvedAudioSource } from './types';
import type { usePlaylistStore } from '../playlist';
import type { useSettingStore } from '../setting';

const privilegeLiteRequests = new Map<string, Promise<SongRelateGood[]>>();

const getPrivilegeTrackRecord = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object') return null;
  const source =
    'data' in (payload as Record<string, unknown>) ? (payload as { data?: unknown }).data : payload;
  if (!Array.isArray(source)) return null;
  const first = source[0];
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
};

const getRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readMetadataString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
};

export const parseTrackMetadataFromPrivilege = (payload: unknown): Partial<Song> => {
  const record = getPrivilegeTrackRecord(payload);
  if (!record) return {};
  const info = getRecord(record.info);
  const transParam = getRecord(record.trans_param ?? record.transParam);
  const albumAudioId = readMetadataString(
    record.album_audio_id,
    record.albumAudioId,
    record.mixsongid,
  );
  const coverUrl = normalizeCoverUrl(
    readMetadataString(
      info.image,
      info.img,
      record.album_sizable_cover,
      record.sizable_cover,
      transParam.union_cover,
    ),
    400,
  );
  const durationMs = Number(info.duration ?? record.timelength ?? 0);
  const albumId = readMetadataString(record.album_id, record.albumId);

  return {
    ...(albumAudioId ? { albumAudioId, mixSongId: albumAudioId } : {}),
    ...(coverUrl ? { coverUrl, cover: coverUrl } : {}),
    ...(Number.isFinite(durationMs) && durationMs > 0
      ? { duration: durationMs > 10_000 ? durationMs / 1000 : durationMs }
      : {}),
    ...(albumId && albumId !== '0' ? { albumId } : {}),
    ...(readMetadataString(record.albumname, record.album_name)
      ? {
          albumName: readMetadataString(record.albumname, record.album_name),
          album: readMetadataString(record.albumname, record.album_name),
        }
      : {}),
    ...(readMetadataString(record.id, record.audio_id)
      ? { songId: readMetadataString(record.id, record.audio_id) }
      : {}),
  };
};

type PlayerTrackInfo = {
  id: number;
  type: string;
  codec?: string;
  selected?: boolean;
  title?: string;
  lang?: string;
};

const VOCAL_TRACK_KEYWORDS = ['人声', 'vocal', 'voice', 'vox', 'stem'];
const ACCOMPANIMENT_TRACK_KEYWORDS = [
  '伴奏',
  'accompaniment',
  'instrumental',
  'karaoke',
  'backing',
  'music',
];

const isMkvUrl = (url: string) => /\.mkv(?:[?#]|$)/i.test(url);

const normalizeTrackText = (track: PlayerTrackInfo) =>
  [track.title, track.lang, track.codec].filter(Boolean).join(' ').toLowerCase();

const getMkvFallbackTrackId = (tracks: PlayerTrackInfo[], effect: string): number | null => {
  const preferredTrackId = effect === 'vocal' ? 2 : 1;
  return (
    tracks.find((track) => Number(track.id) === preferredTrackId)?.id ??
    tracks[Math.min(preferredTrackId - 1, Math.max(0, tracks.length - 1))]?.id ??
    null
  );
};

export const parseRelateGoodsFromPrivilege = (payload: unknown): SongRelateGood[] => {
  const first = getPrivilegeTrackRecord(payload);
  const goods = (first?.relate_goods ?? first?.relateGoods ?? []) as unknown;
  if (!Array.isArray(goods)) return [];
  return goods
    .filter((item) => typeof item === 'object' && item !== null)
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({
      hash: typeof item.hash === 'string' ? item.hash : undefined,
      quality: typeof item.quality === 'string' ? item.quality : undefined,
      level: typeof item.level === 'number' ? item.level : undefined,
    }));
};

export const createResolver = (
  state: PlayerState,
  playlistStore: ReturnType<typeof usePlaylistStore>,
  settingStore: ReturnType<typeof useSettingStore>,
) => {
  const getEffectiveAudioQuality = (): AudioQualityValue => {
    return normalizeQuality(state.currentAudioQualityOverride ?? settingStore.defaultAudioQuality);
  };

  const getResolvedAudioQuality = (track: Pick<Song, 'relateGoods'>): AudioQualityValue => {
    return resolveEffectiveSongQuality(
      track,
      getEffectiveAudioQuality(),
      settingStore.compatibilityMode ?? true,
    );
  };

  const createPluginAudioSourceContext = (track: Song, forceReload = false) => ({
    track,
    quality: getEffectiveAudioQuality(),
    effect: normalizeEffect(state.audioEffect),
    forceReload,
  });

  const transformAudioSource = async (
    track: Song,
    source: ResolvedAudioSource,
    stage: PluginAudioSourceTransformStage,
    options?: { forceReload?: boolean },
  ) => {
    const sourceKind = stage === 'catalog' || stage === 'cloud' ? stage : 'plugin';
    return transformPluginAudioSource(
      createPluginAudioSourceContext(track, Boolean(options?.forceReload)),
      {
        ...source,
        sourceKind: source.sourceKind ?? sourceKind,
      },
      stage,
    );
  };

  const ensureTrackRelateGoods = async (
    track: Song,
    options?: { forceRefresh?: boolean; throwOnError?: boolean },
  ): Promise<SongRelateGood[]> => {
    const existing = track.relateGoods ?? [];
    if (existing.length > 0 && !options?.forceRefresh) return existing;
    if (!track.hash || track.source === 'cloud') return existing;

    const requestKey = `${track.hash}:${track.albumId ?? ''}`;
    const shouldShareRequest = !options?.throwOnError;
    const pending = shouldShareRequest ? privilegeLiteRequests.get(requestKey) : undefined;
    if (pending) return pending;

    logger.debug(
      'PlayerResolver',
      options?.forceRefresh
        ? 'Refreshing privilege lite for track before playback'
        : 'Preloading privilege lite for track',
      summarizeSong(track),
    );
    const request = (async () => {
      try {
        const privilegeRes = await getSongPrivilegeLite(track.hash, track.albumId);
        const relateGoods = parseRelateGoodsFromPrivilege(privilegeRes);
        const metadata = parseTrackMetadataFromPrivilege(privilegeRes);
        Object.assign(track, metadata, { relateGoods });
        if (
          state.currentTrackSnapshot &&
          String(state.currentTrackSnapshot.id) === String(track.id)
        ) {
          state.currentTrackSnapshot = {
            ...state.currentTrackSnapshot,
            ...metadata,
            relateGoods,
          };
        }
        logger.debug('PlayerResolver', 'Preloaded privilege lite relateGoods', {
          track: summarizeSong(track),
          count: relateGoods.length,
          qualities: relateGoods.map((item) => item.quality ?? item.level ?? 'unknown'),
        });
        return relateGoods;
      } catch (error) {
        logger.warn(
          'PlayerResolver',
          'Preload privilege lite failed:',
          error,
          summarizeSong(track),
        );
        if (options?.throwOnError) throw error;
        return existing;
      } finally {
        if (shouldShareRequest) {
          privilegeLiteRequests.delete(requestKey);
        }
      }
    })();

    if (shouldShareRequest) {
      privilegeLiteRequests.set(requestKey, request);
    }
    return request;
  };

  const resolveMkvExtractTrackId = async (
    url: string,
    effect: string,
    hash: string,
  ): Promise<number | null> => {
    if (effect !== 'vocal' && effect !== 'accompaniment') return null;
    if (!isMkvUrl(url)) return null;

    const fallbackTrackId = effect === 'vocal' ? 2 : 1;
    let tracks: PlayerTrackInfo[] = [];
    try {
      tracks = ((await window.electron?.player?.getTrackList(url)) ?? []).filter(
        (track): track is PlayerTrackInfo =>
          track?.type === 'audio' && Number.isFinite(Number(track.id)) && Number(track.id) > 0,
      );
    } catch (error) {
      logger.warn('PlayerResolver', 'Probe MKV audio tracks failed:', error, { effect, hash });
    }

    if (tracks.length === 0) {
      logger.debug('PlayerResolver', 'Using MKV fallback track without probe result', {
        effect,
        trackId: fallbackTrackId,
        hash,
      });
      return fallbackTrackId;
    }

    const keywords = effect === 'vocal' ? VOCAL_TRACK_KEYWORDS : ACCOMPANIMENT_TRACK_KEYWORDS;
    const matchedTrack =
      tracks.find((track) =>
        keywords.some((keyword) => normalizeTrackText(track).includes(keyword)),
      ) ?? null;
    const trackId = matchedTrack?.id ?? getMkvFallbackTrackId(tracks, effect);
    logger.debug('PlayerResolver', 'Resolved MKV extract track', {
      effect,
      trackId,
      hash,
      tracks,
    });
    return trackId;
  };

  const resolveVocalExtractSources = async (
    urls: string[],
    effect: string,
    hash: string,
  ): Promise<Pick<ResolvedAudioSource, 'url' | 'urls' | 'source' | 'sources' | 'audioTrackId'>> => {
    const primaryUrl = urls[0] ?? '';
    if ((effect !== 'vocal' && effect !== 'accompaniment') || !urls.some(isMkvUrl)) {
      return { url: primaryUrl, urls };
    }

    const probeUrl = urls.find(isMkvUrl) ?? primaryUrl;
    const audioTrackId = await resolveMkvExtractTrackId(probeUrl, effect, hash);
    const sources: PlaybackSource[] = urls.map((url) =>
      isMkvUrl(url) && audioTrackId ? { url, audioTrackId } : { url },
    );

    return {
      url: sources[0]?.url ?? primaryUrl,
      urls: sources.map((source) => source.url),
      audioTrackId,
      source: sources[0],
      sources,
    };
  };

  const resolveAudioUrl = async (
    track: Song,
    options?: { forceReload?: boolean },
  ): Promise<ResolvedAudioSource> => {
    const canReuseCurrentSource =
      !!track.audioUrl &&
      !options?.forceReload &&
      !!state.currentTrackId &&
      String(track.id) === String(state.currentTrackId) &&
      track.audioUrl === state.currentAudioUrl;

    if (canReuseCurrentSource) {
      return {
        url: track.audioUrl!,
        urls: state.currentAudioCandidateUrls.length
          ? [...state.currentAudioCandidateUrls]
          : [track.audioUrl!],
        audioTrackId: state.currentPlaybackSource?.audioTrackId ?? null,
        source: state.currentPlaybackSource ?? { url: track.audioUrl! },
        sources: state.currentAudioCandidateSources.length
          ? [...state.currentAudioCandidateSources]
          : state.currentAudioCandidateUrls.map((url) => ({
              url,
              audioTrackId: state.currentPlaybackSource?.audioTrackId ?? null,
            })),
        quality: state.currentResolvedAudioQuality,
        effect: state.currentResolvedAudioEffect,
        sourceKind: state.currentResolvedSourceKind,
        loudness: null,
      };
    }

    const audioQuality = getEffectiveAudioQuality();
    const audioEffect = normalizeEffect(state.audioEffect);
    const compatibilityMode = settingStore.compatibilityMode ?? true;
    const pluginAudioSourceContext = createPluginAudioSourceContext(
      track,
      Boolean(options?.forceReload),
    );
    const finalizeResolvedSource = async (
      source: ResolvedAudioSource,
      stage: Parameters<typeof transformPluginAudioSource>[2],
    ) => transformAudioSource(track, source, stage, options);
    const resolvePluginAt = async (
      position: NonNullable<Parameters<typeof resolvePluginAudioSource>[1]>,
    ): Promise<ResolvedAudioSource | null> =>
      resolvePluginAudioSource(pluginAudioSourceContext, position);
    const shouldUseCatalogSource =
      !!state.currentCatalogSourceOverrideTrackId &&
      String(state.currentCatalogSourceOverrideTrackId) === String(track.id);
    const shouldUseCloudSource =
      !shouldUseCatalogSource &&
      !!state.currentCloudSourceOverrideTrackId &&
      String(state.currentCloudSourceOverrideTrackId) === String(track.id);
    const getTrackCloudAudioSource = (): CloudAudioSource | null => {
      if (track.cloudAudioSource) return track.cloudAudioSource;
      if (!track.hash) return null;
      return {
        cloudFileId: track.cloudFileId,
        hash: track.hash,
        audioId: track.fileId,
        albumAudioId: track.albumAudioId ?? track.mixSongId,
        name: track.title || track.name,
      };
    };
    const syncTrackCloudAudioSource = (cloudAudioSource: CloudAudioSource | null) => {
      if (!cloudAudioSource?.hash) return;
      track.cloudAudioSource = cloudAudioSource;
      if (
        state.currentTrackSnapshot &&
        String(state.currentTrackSnapshot.id) === String(track.id)
      ) {
        state.currentTrackSnapshot = {
          ...state.currentTrackSnapshot,
          cloudAudioSource,
        };
      }
    };
    const ensureMatchedCloudAudioSource = async (): Promise<CloudAudioSource | null> => {
      const cloudAudioSource =
        track.cloudAudioSource?.hash || track.source === 'cloud'
          ? getTrackCloudAudioSource()
          : await getCloudAudioSourceForSong(track);
      syncTrackCloudAudioSource(cloudAudioSource);
      return cloudAudioSource;
    };
    const catalogTrack: Song =
      track.source === 'cloud'
        ? {
            ...track,
            source: undefined,
            hash: track.cloudAudioSource?.hashStd ?? '',
            relateGoods: track.relateGoods,
          }
        : track;
    let catalogLoudness: ReturnType<typeof resolveTrackLoudness> = null;

    const syncTrackRelateGoods = (relateGoods: Song['relateGoods']) => {
      if (!relateGoods || relateGoods.length === 0) return;
      track.relateGoods = relateGoods;
      if (
        state.currentTrackSnapshot &&
        String(state.currentTrackSnapshot.id) === String(track.id)
      ) {
        state.currentTrackSnapshot = {
          ...state.currentTrackSnapshot,
          relateGoods,
        };
      }
    };

    const rememberCatalogTrackLoudness = (payload: unknown) => {
      const loudness = resolveTrackLoudness(payload);
      if (loudness) catalogLoudness = loudness;
      return loudness;
    };

    const resolveCatalogTrackLoudness = async () => {
      if (catalogLoudness || !catalogTrack.hash || !settingStore.volumeNormalization) {
        return catalogLoudness;
      }
      try {
        const res = await getSongUrl(catalogTrack.hash);
        return rememberCatalogTrackLoudness(res);
      } catch (error) {
        logger.debug('PlayerResolver', 'Fetch catalog loudness for cloud source failed:', error, {
          track: summarizeSong(catalogTrack),
        });
        return null;
      }
    };

    const resolveCloudAudioSourceUrl = async (
      source: CloudAudioSource,
    ): Promise<ResolvedAudioSource | null> => {
      try {
        const cloudUrl = await getCloudSongUrl(source.hash, {
          cloudFileId: source.cloudFileId,
          albumAudioId: source.albumAudioId,
          audioId: source.audioId,
          name: source.name,
        });
        if (!cloudUrl) return null;
        const loudness =
          resolveTrackLoudness(cloudUrl.payload) ?? (await resolveCatalogTrackLoudness());
        return {
          url: cloudUrl.url,
          urls: cloudUrl.urls.length ? cloudUrl.urls : [cloudUrl.url],
          quality: source.quality ?? null,
          effect: 'none',
          sourceKind: 'cloud',
          loudness,
        };
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch cloud file url failed:', error, {
          cloudFileId: source.cloudFileId,
          hash: source.hash,
          matchBy: source.matchBy,
        });
        return null;
      }
    };
    const resolveMatchedCloudAudioSourceUrl = async (): Promise<ResolvedAudioSource | null> => {
      const cloudAudioSource = await ensureMatchedCloudAudioSource();
      if (!cloudAudioSource) return null;
      const resolved = await resolveCloudAudioSourceUrl(cloudAudioSource);
      return resolved;
    };
    let didTryCloudAudioSource = false;
    const tryCloudAudioSource = async () => {
      didTryCloudAudioSource = true;
      return resolveMatchedCloudAudioSourceUrl();
    };

    // 云盘页面播放的歌曲直接使用云盘文件，跳过优先级链（手动选择曲库音质时除外）
    if (!shouldUseCatalogSource && track.source === 'cloud' && track.cloudAudioSource?.hash) {
      const resolved = await tryCloudAudioSource();
      const transformed = resolved ? await finalizeResolvedSource(resolved, 'cloud') : null;
      if (transformed) return transformed;
    }

    const pluginResolved = await resolvePluginAt('before-catalog');
    if (pluginResolved) {
      return pluginResolved;
    }

    if (!shouldUseCloudSource && track.source !== 'cloud' && !track.cloudAudioSource?.hash) {
      void ensureMatchedCloudAudioSource().catch((error) => {
        logger.debug('PlayerResolver', 'Warm cloud audio source failed:', error, {
          track: summarizeSong(track),
        });
      });
    }

    if (shouldUseCloudSource) {
      const resolved = await tryCloudAudioSource();
      const transformed = resolved ? await finalizeResolvedSource(resolved, 'cloud') : null;
      if (transformed) return transformed;
    }

    if (!catalogTrack.hash) {
      const afterCatalogPlugin = await resolvePluginAt('after-catalog');
      if (afterCatalogPlugin) return afterCatalogPlugin;
      const resolved = didTryCloudAudioSource ? null : await tryCloudAudioSource();
      if (resolved) {
        const cloudResolved =
          audioEffect !== 'none'
            ? { ...resolved, noticeCode: 'audio-effect-cloud-fallback' }
            : resolved;
        const transformed = await finalizeResolvedSource(cloudResolved, 'cloud');
        if (transformed) return transformed;
      }
      const finalPlugin = await resolvePluginAt('final-fallback');
      if (finalPlugin) return finalPlugin;
      logger.warn(
        'PlayerResolver',
        'Resolve audio url skipped because track hash is missing',
        summarizeSong(catalogTrack),
      );
      return { url: '', quality: null, effect: 'none', loudness: null };
    }

    let relateGoods: SongRelateGood[] = [];
    try {
      relateGoods = await ensureTrackRelateGoods(catalogTrack, {
        forceRefresh: catalogTrack === track,
      });
    } catch (error) {
      logger.warn('PlayerResolver', 'Resolve privilege lite failed, continue playback:', error, {
        track: summarizeSong(catalogTrack),
      });
    }
    if (catalogTrack !== track) syncTrackRelateGoods(relateGoods);

    if (audioEffect !== 'none') {
      const isVocalEffect = audioEffect === 'vocal' || audioEffect === 'accompaniment';
      const apiEffect = isVocalEffect ? 'acappella' : audioEffect;

      const matchedEffect = relateGoods.find((item) => item.quality === apiEffect && item.hash);
      const effectHashes = [matchedEffect?.hash, catalogTrack.hash].filter(
        (value, index, list): value is string => !!value && list.indexOf(value) === index,
      );

      for (const effectHash of effectHashes) {
        try {
          const effectRes = await getSongUrl(effectHash, apiEffect);
          const rawEffectUrls = resolveUrlsFromResponse(effectRes);
          if (rawEffectUrls.length > 0) {
            const effectSource = await resolveVocalExtractSources(
              rawEffectUrls,
              audioEffect,
              effectHash,
            );
            const transformed = await finalizeResolvedSource(
              {
                ...effectSource,
                quality: audioQuality,
                effect: audioEffect,
                loudness: resolveTrackLoudness(effectRes),
              },
              'catalog',
            );
            if (transformed) return transformed;
          }
        } catch (error) {
          logger.warn('PlayerResolver', 'Fetch effect url failed:', error);
        }
      }
    }

    const candidates = getSongQualityCandidates(audioQuality, compatibilityMode);
    for (const quality of candidates) {
      const matched = relateGoods.find(
        (item) => doesRelateGoodMatchQuality(item, quality) && item.hash,
      );
      if (!matched?.hash) continue;
      try {
        const res = await getSongUrl(matched.hash, quality);
        const loudness = rememberCatalogTrackLoudness(res);
        const urls = resolveUrlsFromResponse(res);
        if (urls.length > 0) {
          const transformed = await finalizeResolvedSource(
            {
              url: urls[0],
              urls,
              quality,
              effect: 'none',
              loudness,
            },
            'catalog',
          );
          if (transformed) return transformed;
        }
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch quality url failed:', error);
      }
    }

    if (compatibilityMode) {
      try {
        const res = await getSongUrl(catalogTrack.hash);
        const loudness = rememberCatalogTrackLoudness(res);
        const urls = resolveUrlsFromResponse(res);
        if (urls.length > 0) {
          const transformed = await finalizeResolvedSource(
            {
              url: urls[0],
              urls,
              quality: getResolvedAudioQuality(catalogTrack),
              effect: 'none',
              loudness,
            },
            'catalog',
          );
          if (transformed) return transformed;
        }
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch fallback url failed:', error);
      }
    }

    try {
      const res = await getSongUrl(catalogTrack.hash, '', 356753938);
      const loudness = rememberCatalogTrackLoudness(res);
      const urls = resolveUrlsFromResponse(res);
      if (urls.length > 0) {
        const transformed = await finalizeResolvedSource(
          {
            url: urls[0],
            urls,
            quality: getResolvedAudioQuality(catalogTrack),
            effect: 'none',
            loudness,
          },
          'catalog',
        );
        if (transformed) return transformed;
      }
    } catch (error) {
      logger.warn('PlayerResolver', 'Fetch fallback with ppage_id failed:', error);
    }

    const afterCatalogPlugin = await resolvePluginAt('after-catalog');
    if (afterCatalogPlugin) return afterCatalogPlugin;

    const rawCloudFallback = didTryCloudAudioSource ? null : await tryCloudAudioSource();
    const cloudFallback = rawCloudFallback
      ? await finalizeResolvedSource(
          audioEffect !== 'none'
            ? { ...rawCloudFallback, noticeCode: 'audio-effect-cloud-fallback' }
            : rawCloudFallback,
          'cloud',
        )
      : null;
    if (cloudFallback) {
      return cloudFallback;
    }

    const finalPlugin = await resolvePluginAt('final-fallback');
    if (finalPlugin) return finalPlugin;
    logger.debug(
      'PlayerResolver',
      didTryCloudAudioSource
        ? 'Requested cloud source and catalog source are unavailable'
        : 'Catalog source unavailable, cloud fallback unavailable',
      {
        track: summarizeSong(track),
        effect: audioEffect,
      },
    );

    return { url: '', quality: null, effect: 'none', loudness: null };
  };

  const fetchClimaxMarks = async (track: Song) => {
    if (!track.hash) {
      state.climaxMarks = [];
      return;
    }
    const requestSeq = ++state.climaxRequestSeq;
    try {
      const res = await getSongClimax(track.hash);
      if (
        requestSeq !== state.climaxRequestSeq ||
        String(track.id) !== String(state.currentTrackId)
      ) {
        return;
      }
      const data = res && typeof res === 'object' ? (res as { data?: unknown }).data : undefined;
      const list = Array.isArray(data) ? data : [];
      const marks: ClimaxMark[] = [];
      const duration = track.duration || state.duration || 0;
      if (!(duration > 0) || list.length === 0) {
        state.climaxMarks = [];
        return;
      }
      const total = duration;

      list.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const record = item as Record<string, unknown>;
        const startRaw = record.start_time ?? record.starttime ?? record.start;
        const endRaw = record.end_time ?? record.endtime ?? record.end;
        const startMs = Number(startRaw);
        const endMs = Number(endRaw);
        if (!Number.isFinite(startMs) || startMs <= 0 || startMs >= total * 1000) return;

        const start = startMs / 1000;
        const end =
          Number.isFinite(endMs) && endMs > startMs ? Math.min(total, endMs / 1000) : start;
        const normalizedStart = start / total;
        const normalizedEnd = end / total;

        if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return;
        if (normalizedStart <= 0 || normalizedStart >= 1) return;
        if (normalizedEnd <= 0) return;

        marks.push({
          start: normalizedStart,
          end: Math.min(1, Math.max(normalizedStart, normalizedEnd)),
        });
      });

      state.climaxMarks = marks
        .sort((a, b) => a.start - b.start)
        .filter(
          (mark, index, arr) => index === 0 || Math.abs(mark.start - arr[index - 1].start) > 0.002,
        );
    } catch (error) {
      if (requestSeq === state.climaxRequestSeq) {
        state.climaxMarks = [];
      }
      logger.warn('PlayerResolver', 'Fetch climax marks failed:', error);
    }
  };

  return {
    getEffectiveAudioQuality,
    getResolvedAudioQuality,
    ensureTrackRelateGoods,
    resolveMkvExtractTrackId,
    resolveVocalExtractSources,
    transformAudioSource,
    resolveAudioUrl,
    fetchClimaxMarks,
  };
};
