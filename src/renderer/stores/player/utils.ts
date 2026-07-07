import type { Song } from '@/models/song';
import { isPlayableSong, isPaidSong } from '@/utils/song';
import type { usePlaylistStore } from '../playlist';
import type { AudioEffectValue, AudioQualityValue } from '../../types';
import type { TrackLoudness } from '@/utils/player';
import type { PlaybackNotice } from './types';

import logger from '@/utils/logger';
import { resolveCoverDisplayUrl } from '@/utils/cover';
import type { MediaSessionMeta, MediaSessionState } from '@/utils/player';

export const buildMediaMeta = (track: Song | undefined): MediaSessionMeta | null => {
  if (!track) return null;

  // 调试日志：打印原始封面 URL
  logger.debug('MediaSession', 'buildMediaMeta - original coverUrl:', track.coverUrl);

  const artwork = [96, 128, 192, 256, 384, 512].map((size) => {
    const url = resolveCoverDisplayUrl(track.coverUrl, size, { scope: 'media-session' });
    return {
      src: url,
      sizes: `${size}x${size}`,
      type: 'image/jpeg',
    };
  });

  // 调试日志：打印处理后的最大尺寸封面 URL
  logger.debug('MediaSession', 'buildMediaMeta - processed artwork[0]:', artwork[0]?.src);
  logger.debug(
    'MediaSession',
    'buildMediaMeta - processed artwork[last]:',
    artwork[artwork.length - 1]?.src,
  );

  return {
    title: track.name ?? track.title ?? '',
    artist: track.artist || '未知歌手',
    album: track.album ?? '',
    artwork,
  };
};

export const buildMediaState = (state: {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  playbackRate: number;
}): MediaSessionState => ({
  isPlaying: state.isPlaying,
  duration: state.duration,
  currentTime: state.currentTime,
  playbackRate: state.playbackRate,
});

export const buildStoppedPlaybackState = (state: { playbackRate: number }): MediaSessionState => ({
  isPlaying: false,
  duration: 0,
  currentTime: 0,
  playbackRate: state.playbackRate,
});

export const normalizeQuality = (value: string | undefined): AudioQualityValue => {
  if (
    value === '128' ||
    value === '320' ||
    value === 'flac' ||
    value === 'high' ||
    value === 'super'
  )
    return value;
  return 'high';
};

export const normalizeEffect = (value: string | undefined): AudioEffectValue => {
  const options: AudioEffectValue[] = [
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
  return options.includes(value as AudioEffectValue) ? (value as AudioEffectValue) : 'none';
};

export const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const findPlayableIndex = (
  songs: Song[],
  startIndex: number,
  forward: boolean,
  inclusive = true,
): number => {
  if (songs.length === 0) return -1;
  const normalizedStart = startIndex >= 0 ? startIndex % songs.length : 0;
  for (let step = 0; step < songs.length; step += 1) {
    const offset = inclusive ? step : step + 1;
    const index = forward
      ? (normalizedStart + offset) % songs.length
      : (normalizedStart - offset + songs.length) % songs.length;
    if (isPlayableSong(songs[index])) return index;
  }
  return -1;
};

export const resolveUrlFromResponse = (payload: unknown): string => {
  return resolveUrlsFromResponse(payload)[0] ?? '';
};

const appendUrlCandidate = (urls: string[], value: unknown) => {
  if (typeof value === 'string') {
    const url = value.trim();
    if (url && !urls.includes(url)) urls.push(url);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => appendUrlCandidate(urls, item));
  }
};

export const resolveUrlsFromResponse = (payload: unknown): string[] => {
  if (!payload) return [];
  if (typeof payload === 'string') {
    const url = payload.trim();
    return url ? [url] : [];
  }
  if (Array.isArray(payload)) {
    const urls: string[] = [];
    appendUrlCandidate(urls, payload);
    return urls;
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const urls: string[] = [];
    appendUrlCandidate(urls, record.url);
    appendUrlCandidate(urls, record.play_url);
    appendUrlCandidate(urls, record.playUrl);
    appendUrlCandidate(urls, record.backupUrl);
    appendUrlCandidate(urls, record.backup_url);
    appendUrlCandidate(urls, record.backupUrls);
    if (urls.length > 0) return urls;
    if ('data' in record) return resolveUrlsFromResponse(record.data);
    if ('info' in record) return resolveUrlsFromResponse(record.info);
  }
  return [];
};

/** 从 API 响应中提取曲目响度信息 */
export const resolveTrackLoudness = (payload: unknown): TrackLoudness | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const source =
    typeof record.volume === 'number'
      ? record
      : typeof record.data === 'object' && record.data !== null
        ? (record.data as Record<string, unknown>)
        : null;
  if (!source || typeof source.volume !== 'number') return null;
  const lufs = source.volume as number;
  const gain =
    typeof source.volume_gain === 'number'
      ? (source.volume_gain as number)
      : typeof source.volumeGain === 'number'
        ? (source.volumeGain as number)
        : 0;
  const peak =
    typeof source.volume_peak === 'number'
      ? (source.volume_peak as number)
      : typeof source.volumePeak === 'number'
        ? (source.volumePeak as number)
        : 0;
  if (!Number.isFinite(lufs)) return null;
  if (lufs === 0 && gain === 0) return null;
  return { lufs, gain, peak: Math.max(0, peak) };
};

export const findTrackById = (
  id: string | null,
  list: Song[] | null | undefined,
  playlistStore: ReturnType<typeof usePlaylistStore>,
): Song | undefined => {
  if (!id) return undefined;
  const targetId = String(id);
  const pool = [
    list ?? [],
    playlistStore.activeQueue?.songs ?? [],
    playlistStore.defaultList,
    playlistStore.favorites,
  ];
  for (const group of pool) {
    const found = group.find((song) => String(song.id) === targetId);
    if (found) return found;
  }
  return undefined;
};

export const resolveTrackMxid = (track: Song | null | undefined): number | null => {
  if (!track) return null;
  const candidates = [track.mixSongId, track.fileId, track.id];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const summarizeSong = (track: Song | undefined) => {
  if (!track) return null;
  return {
    id: String(track.id),
    title: track.name ?? track.title ?? '',
    artist: track.artist || '未知歌手',
    album: track.album || '',
    duration: track.duration || 0,
    hash: track.hash || '',
    privilege: track.privilege ?? null,
    payType: track.payType ?? null,
    source: track.source || '',
  };
};

export const resolvePlaybackNotice = (params: {
  code: string;
  track?: Song | null;
  autoNextEnabled?: boolean;
  autoNextDelaySeconds?: number;
}): PlaybackNotice => {
  const trackId = params.track ? String(params.track.id) : null;
  const requiresPurchase = Boolean(params.track && isPaidSong(params.track));
  const autoNextDelay = Math.max(0, Math.floor(params.autoNextDelaySeconds ?? 0));
  const autoNextDetail = params.autoNextEnabled
    ? `${autoNextDelay > 0 ? `${autoNextDelay} 秒后` : '即将'}尝试下一首`
    : '请稍后重试';

  if (params.code === 'track-not-playable') {
    return {
      code: params.code,
      title: '播放失败',
      reason: '当前歌曲暂不可播放',
      detail: autoNextDetail,
      trackId,
    };
  }

  if (params.code === 'audio-url-unavailable') {
    return {
      code: params.code,
      title: '播放失败',
      reason: requiresPurchase ? '可能需要购买或账号权限' : '暂时无法获取可用音源',
      detail: autoNextDetail,
      trackId,
    };
  }

  return {
    code: params.code,
    title: '播放失败',
    reason: requiresPurchase ? '可能需要购买或账号权限' : '音频加载或播放过程中出现异常',
    detail: autoNextDetail,
    trackId,
  };
};
