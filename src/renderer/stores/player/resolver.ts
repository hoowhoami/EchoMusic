import { getCloudSongUrl, getSongClimax, getSongPrivilegeLite, getSongUrl } from '@/api/music';
import type { Song, SongRelateGood } from '@/models/song';
import logger from '@/utils/logger';
import {
  doesRelateGoodMatchQuality,
  getSongQualityCandidates,
  resolveEffectiveSongQuality,
} from '@/utils/song';
import type { AudioQualityValue } from '../../types';
import type { PlayerState } from './state';
import {
  normalizeEffect,
  normalizeQuality,
  resolveTrackLoudness,
  resolveUrlFromResponse,
  summarizeSong,
} from './utils';
import type { ClimaxMark, ResolvedAudioSource } from './types';
import type { usePlaylistStore } from '../playlist';
import type { useSettingStore } from '../setting';

const privilegeLiteRequests = new Map<string, Promise<SongRelateGood[]>>();

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

    logger.info(
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
        logger.info('PlayerResolver', 'Preloaded privilege lite relateGoods', {
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

  const resolveVocalExtractUrl = async (
    url: string,
    effect: string,
    hash: string,
  ): Promise<string> => {
    if (effect !== 'vocal' && effect !== 'accompaniment') return url;
    if (!url.toLowerCase().includes('.mkv')) return url;

    const trackNum = effect === 'vocal' ? 2 : 1;
    const proxyUrl = `mpv-mkv://track=${trackNum}&url=${encodeURIComponent(url)}`;
    logger.info('PlayerResolver', 'Resolved MKV extract url', { effect, trackNum, hash });
    return proxyUrl;
  };

  const resolveAudioUrl = async (
    track: Song,
    options?: { forceReload?: boolean },
  ): Promise<ResolvedAudioSource> => {
    if (!track.hash) {
      logger.warn(
        'PlayerResolver',
        'Resolve audio url skipped because track hash is missing',
        summarizeSong(track),
      );
      return { url: '', quality: null, effect: 'none', loudness: null };
    }
    const canReuseCurrentSource =
      !!track.audioUrl &&
      !options?.forceReload &&
      !!state.currentTrackId &&
      String(track.id) === String(state.currentTrackId) &&
      track.audioUrl === state.currentAudioUrl;

    if (canReuseCurrentSource) {
      return {
        url: track.audioUrl!,
        quality: state.currentResolvedAudioQuality,
        effect: state.currentResolvedAudioEffect,
        loudness: null,
      };
    }

    const audioQuality = getEffectiveAudioQuality();
    const audioEffect = normalizeEffect(state.audioEffect);
    const compatibilityMode = settingStore.compatibilityMode ?? true;

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
          let effectUrl = resolveUrlFromResponse(effectRes);
          if (effectUrl) {
            effectUrl = await resolveVocalExtractUrl(effectUrl, audioEffect, effectHash);
            return {
              url: effectUrl,
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
        const url = resolveUrlFromResponse(res);
        if (url) {
          return { url, quality, effect: 'none', loudness: resolveTrackLoudness(res) };
        }
      } catch (error) {
        logger.warn('PlayerResolver', 'Fetch quality url failed:', error);
      }
    }

    if (compatibilityMode) {
      try {
        const res = await getSongUrl(track.hash);
        const url = resolveUrlFromResponse(res);
        if (url) {
          return {
            url,
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
      const url = resolveUrlFromResponse(res);
      if (url) {
        return {
          url,
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
    resolveVocalExtractUrl,
    resolveAudioUrl,
    fetchClimaxMarks,
  };
};
