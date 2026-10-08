import type { Song, SongRelateGood } from '@/models/song';
import { isPlayableSong, isPaidSong, isVipSong } from '@/utils/song';
import type { usePlaylistStore } from '../playlist';
import type { AudioEffectValue, AudioQualityValue } from '../../types';
export { resolveTrackLoudness } from '../../../shared/loudness';
import type { PlaybackNotice } from './types';

import { resolveCoverDisplayUrl } from '@/utils/cover';
import type { MediaSessionMeta, MediaSessionState } from '@/utils/player';

export const buildMediaMeta = (track: Song | undefined): MediaSessionMeta | null => {
  if (!track) return null;

  const coverSize = 512;
  const artwork = [
    {
      src: resolveCoverDisplayUrl(track.coverUrl, coverSize, { scope: 'media-session' }),
      sizes: `${coverSize}x${coverSize}`,
      type: 'image/jpeg',
    },
  ];

  return {
    title: track.name ?? track.title ?? '',
    artist: track.artist || '未知歌手',
    album: track.album ?? '',
    artwork,
  };
};

export const buildMediaState = (state: {
  playbackIntent?: { shouldPlay: boolean };
  enginePlayback?: { status: string };
  duration: number;
  currentTime: number;
  playbackRate: number;
}): MediaSessionState => ({
  isPlaying: Boolean(
    state.playbackIntent?.shouldPlay || state.enginePlayback?.status === 'playing',
  ),
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
    value === 'viper_tape'
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

/** Prefer the source/player's reported cause over account-level permission guesses. */
export const resolveAudioFailureReason = (
  error: unknown,
  track?: Song | null,
  qualitySwitch = false,
  qualityPermission?: SongRelateGood,
): string | undefined => {
  if (!error) return undefined;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const outer = record(error);
  const response = record(outer.response);
  const payload = record(response.body ?? response.data ?? outer.response ?? error);
  const data = record(payload.data);
  const messages = [
    payload.msg,
    payload.message,
    payload.errmsg,
    payload.error,
    payload.reason,
    data.msg,
    data.message,
    data.errmsg,
    data.reason,
    outer.message,
    typeof error === 'string' ? error : undefined,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const message = messages.find((value) => /[\u4e00-\u9fff]/.test(value)) ?? messages[0];

  if (message && /[\u4e00-\u9fff]/.test(message)) return message.trim().slice(0, 160);
  if (message && /\b(?:need|require)\w*\b.*VIP|VIP.*\b(?:required|only)\b/i.test(message))
    return qualitySwitch ? '所选音质需要 VIP 权限' : '当前歌曲需要 VIP 权限';
  // APK UrlRequestor maps tracker status 2 to "need charge", not specifically VIP.
  // Prefer authorization and the requested quality's rights over the song label.
  if (Number(payload.status ?? data.status) === 2) {
    const authorization = record(payload.auth_through ?? data.auth_through);
    const readNumber = (value: unknown): number | undefined => {
      if (typeof value !== 'number' && typeof value !== 'string') return undefined;
      if (typeof value === 'string' && !value.trim()) return undefined;
      const number = Number(value);
      return Number.isInteger(number) ? number : undefined;
    };
    const payType =
      readNumber(authorization.pay_type ?? payload.pay_type ?? data.pay_type) ??
      qualityPermission?.payType ??
      track?.payType;
    const goodsType = authorization.goods_type ?? qualityPermission?.goodsType;
    const failProcess =
      readNumber(authorization.fail_process ?? payload.fail_process ?? data.fail_process) ??
      qualityPermission?.failProcess;
    const allQualityFree =
      readNumber(authorization.all_quality_free) ?? qualityPermission?.allQualityFree;
    if (goodsType === 'album') return '需要购买歌曲或专辑后播放';
    if (allQualityFree === 1) return '此音源需要额外的播放授权';
    // APK f0.f / f0.j distinguish VIP/music-package payment paths by bits 4/8.
    if (
      payType !== undefined &&
      (payType & 1) !== 0 &&
      (failProcess === undefined || (failProcess & 12) !== 0)
    )
      return qualitySwitch ? '所选音质需要 VIP 权限' : '当前歌曲需要 VIP 权限';
    if (payType !== undefined && (payType & 1) === 0 && (payType & 2) !== 0)
      return '需要购买歌曲或专辑后播放';
    return '此音源需要付费授权';
  }
  if (!message) return undefined;
  if (/insufficient prepared audio|replacement ended before hand-off/i.test(message))
    return '新音源缓冲不足，未能完成切换';
  if (/timed? out|timeout/i.test(message)) return '音源加载超时，请稍后重试';
  if (/\b403\b|forbidden|unauthorized/i.test(message)) return '音源访问被拒绝';
  if (/decode|invalid data|unsupported.*(?:codec|format)/i.test(message)) return '音频解码失败';
  if (/network|offline|connection|fetch failed/i.test(message)) return '网络连接异常';
  return undefined;
};

export const resolvePlaybackNotice = (params: {
  code: string;
  track?: Song | null;
  autoNextEnabled?: boolean;
  autoNextDelaySeconds?: number;
  isUserNovip?: boolean;
  error?: unknown;
}): PlaybackNotice => {
  const trackId = params.track ? String(params.track.id) : null;
  const requiresPurchase = Boolean(params.track && isPaidSong(params.track));
  const requiresVip = Boolean(params.isUserNovip && params.track && isVipSong(params.track));
  const autoNextDelay = Math.max(0, Math.floor(params.autoNextDelaySeconds ?? 0));
  const autoNextDetail = params.autoNextEnabled
    ? `${autoNextDelay > 0 ? `${autoNextDelay} 秒后` : '即将'}尝试下一首`
    : '请稍后重试';

  const vipReason = requiresVip ? '当前歌曲需要 VIP 权限' : null;
  const errorReason = resolveAudioFailureReason(
    params.error,
    params.track,
    params.code.startsWith('audio-quality-'),
  );

  if (
    params.code === 'audio-quality-unavailable' ||
    params.code === 'audio-quality-switch-failed' ||
    params.code === 'audio-source-unavailable' ||
    params.code === 'audio-source-switch-failed'
  ) {
    const isQualitySwitch = params.code.startsWith('audio-quality-');
    const unavailable = params.code.endsWith('-unavailable');
    return {
      code: params.code,
      title: isQualitySwitch ? '音质切换失败' : '音源切换失败',
      reason:
        errorReason ||
        (isQualitySwitch
          ? unavailable
            ? requiresVip
              ? '所选音质可能需要 VIP 权限'
              : requiresPurchase
                ? '所选音质可能需要购买或账号权限'
                : '暂时无法获取所选音质音源'
            : '暂时无法应用所选音质'
          : unavailable
            ? '暂时无法获取云盘音源'
            : '暂时无法切换到云盘音源'),
      detail: isQualitySwitch ? '已保留原音质，继续播放' : '已保留原音源，继续播放',
      trackId,
    };
  }

  if (params.code === 'track-not-playable') {
    return {
      code: params.code,
      title: '播放失败',
      reason: errorReason || vipReason || '当前歌曲暂不可播放',
      detail: autoNextDetail,
      trackId,
    };
  }

  if (params.code === 'audio-url-unavailable') {
    return {
      code: params.code,
      title: '播放失败',
      reason:
        errorReason ||
        vipReason ||
        (requiresPurchase ? '可能需要购买或账号权限' : '暂时无法获取可用音源'),
      detail: autoNextDetail,
      trackId,
    };
  }

  if (params.code === 'audio-effect-unavailable' || params.code === 'audio-effect-apply-failed') {
    return {
      code: params.code,
      title: '歌曲音效未生效',
      reason:
        params.code === 'audio-effect-unavailable'
          ? '未能获取所选音效音源，已使用普通音源'
          : '所选音效切换失败，请重试或选择其他音效',
      detail: '已保留你的选择，可再次点击重试',
      trackId,
    };
  }

  if (params.code === 'audio-effect-cloud-fallback') {
    return {
      code: params.code,
      title: '音效不可用',
      reason: '已回退云盘文件播放',
      detail: '当前曲目暂不支持所选音效',
      trackId,
    };
  }

  return {
    code: params.code,
    title: '播放失败',
    reason:
      errorReason ||
      vipReason ||
      (requiresPurchase ? '可能需要购买或账号权限' : '音频加载或播放过程中出现异常'),
    detail: autoNextDetail,
    trackId,
  };
};
