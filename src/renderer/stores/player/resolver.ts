import { getCloudSongUrl, getSongClimax, getSongPrivilegeLite, getSongUrl } from '@/api/music';
import type { Song, SongRelateGood } from '@/models/song';
import logger from '@/utils/logger';
import {
  doesRelateGoodMatchQuality,
  getSongQualityCandidates,
  resolveEffectiveSongQuality,
} from '@/utils/song';
import { resolvePluginAudioSource } from '@/plugins/audioSource';
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
  if (!payload || typeof payload !== 'object') return [];
  const source =
    'data' in (payload as Record<string, unknown>) ? (payload as { data?: unknown }).data : payload;
  const list = Array.isArray(source) ? source : [];
  const first = list[0] as Record<string, unknown> | undefined;
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

  const ensureTrackRelateGoods = async (
    track: Song,
    options?: { forceRefresh?: boolean },
  ): Promise<SongRelateGood[]> => {
    const existing = track.relateGoods ?? [];
    if (existing.length > 0 && !options?.forceRefresh) return existing;
    if (!track.hash || track.source === 'cloud') return existing;

    const requestKey = `${track.hash}:${track.albumId ?? ''}`;
    const pending = privilegeLiteRequests.get(requestKey);
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
        track.relateGoods = relateGoods;
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
        return existing;
      } finally {
        privilegeLiteRequests.delete(requestKey);
      }
    })();

    privilegeLiteRequests.set(requestKey, request);
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
        loudness: null,
      };
    }

    const audioQuality = getEffectiveAudioQuality();
    const audioEffect = normalizeEffect(state.audioEffect);
    const compatibilityMode = settingStore.compatibilityMode ?? true;

    const pluginResolved = await resolvePluginAudioSource({
      track,
      quality: audioQuality,
      effect: audioEffect,
      forceReload: Boolean(options?.forceReload),
    });
    if (pluginResolved) return pluginResolved;

    if (!track.hash) {
      logger.warn(
        'PlayerResolver',
        'Resolve audio url skipped because track hash is missing',
        summarizeSong(track),
      );
      return { url: '', quality: null, effect: 'none', loudness: null };
    }

    if (track.source === 'cloud') {
      let cloudUrl: string | null = null;
      try {
        cloudUrl = await getCloudSongUrl(track.hash);
      } catch (error) {
        logger.error('PlayerResolver', 'Fetch cloud track audio url error:', error);
      }
      return { url: cloudUrl ?? '', quality: null, effect: 'none', loudness: null };
    }

    const relateGoods = await ensureTrackRelateGoods(track, { forceRefresh: true });

    if (audioEffect !== 'none') {
      const isVocalEffect = audioEffect === 'vocal' || audioEffect === 'accompaniment';
      const apiEffect = isVocalEffect ? 'acappella' : audioEffect;

      const matchedEffect = relateGoods.find((item) => item.quality === apiEffect && item.hash);
      const effectHashes = [matchedEffect?.hash, track.hash].filter(
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
            return {
              ...effectSource,
              quality: audioQuality,
              effect: audioEffect,
              loudness: resolveTrackLoudness(effectRes),
            };
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
        const urls = resolveUrlsFromResponse(res);
        if (urls.length > 0) {
          return {
            url: urls[0],
            urls,
            quality,
            effect: 'none',
            loudness: resolveTrackLoudness(res),
          };
        }
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch quality url failed:', error);
      }
    }

    if (compatibilityMode) {
      try {
        const res = await getSongUrl(track.hash);
        const urls = resolveUrlsFromResponse(res);
        if (urls.length > 0) {
          return {
            url: urls[0],
            urls,
            quality: getResolvedAudioQuality(track),
            effect: 'none',
            loudness: resolveTrackLoudness(res),
          };
        }
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch fallback url failed:', error);
      }
    }

    try {
      const res = await getSongUrl(track.hash, '', 356753938);
      const urls = resolveUrlsFromResponse(res);
      if (urls.length > 0) {
        return {
          url: urls[0],
          urls,
          quality: getResolvedAudioQuality(track),
          effect: 'none',
          loudness: resolveTrackLoudness(res),
        };
      }
    } catch (error) {
      logger.warn('PlayerResolver', 'Fetch fallback with ppage_id failed:', error);
    }

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
    resolveAudioUrl,
    fetchClimaxMarks,
  };
};
