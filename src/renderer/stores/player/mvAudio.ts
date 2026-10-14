import { getSongMv, getVideoUrl } from '@/api/video';
import type { Song } from '@/models/song';
import type { VideoMeta } from '@/models/video';
import { useUserStore } from '../user';
import { captureUserSession } from '@/utils/userSession';
import { mapVideoMetaList } from '@/utils/mappers/video';
import logger from '@/utils/logger';
import type { PlayerErrorPayload } from '../../../shared/playerError';
import { toRecord } from '../../../shared/object';
import type { ResolvedAudioSource } from './types';

export const captureMvAudioSession = () => captureUserSession(useUserStore());

export const canFallbackToMvAudio = (error: PlayerErrorPayload): boolean => {
  if (error.errorCode) return error.errorCode === 'decode' || error.errorCode === 'network';
  // IPC promise rejections may only retain the native error message.
  if (/superseded|cancelled|stale|output|device|dsp|filter|seek/i.test(error.message)) return false;
  return /decode|invalid data|unsupported.*(?:codec|format)|(?:open|load).*?(?:audio|media|source)|network|HTTP|timed out/i.test(
    error.message,
  );
};

const isPlatformShortVideo = (mv: VideoMeta): boolean =>
  // Kugou's video parser classifies is_short != 0 as short video. Titles/tags
  // describe editions; even a release labelled 短版 may be classified as an MV.
  Number(mv.raw?.is_short) !== 0;

export const pickCatalogMv = (payload: unknown): VideoMeta | null => {
  if (Number(toRecord(payload).status) !== 1) return null;
  return (
    mapVideoMetaList(payload)
      .filter((mv) => {
        const raw = mv.raw ?? {};
        return (
          // The relation is supplied by the endpoint. Kugou's MvInfoKmrProtocol
          // rebinds returned album_audio_id to the request, rather than rejecting
          // linked editions with a different album_audio_id. No 官方版 tag is required.
          Number(raw.is_publish) === 1 &&
          raw.is_ugc != null &&
          Number(raw.is_ugc) === 0 &&
          raw.is_short != null &&
          !isPlatformShortVideo(mv) &&
          raw.is_other != null &&
          Number(raw.is_other) === 0 &&
          (raw.__status === undefined || Number(raw.__status) === 1) &&
          mv.duration > 0 &&
          !!mv.sources?.length
        );
      })
      .sort((a, b) => Number(b.recommend) - Number(a.recommend))[0] ?? null
  );
};

export const resolveMvAudioSource = async (
  track: Song,
  isCurrent: () => boolean,
  onUnavailable?: (reason: string) => void,
): Promise<ResolvedAudioSource | null> => {
  const albumAudioId = String(track.albumAudioId ?? track.mixSongId ?? '').trim();
  if (!isCurrent()) return null;
  const unavailable = (reason: string, context?: Record<string, unknown>) => {
    if (isCurrent()) {
      onUnavailable?.(reason);
      logger.info('PlayerMvAudio', 'MV audio fallback unavailable', {
        trackId: track.id,
        albumAudioId,
        reason,
        ...context,
      });
    }
    return null;
  };
  if (!/^[1-9]\d*$/.test(albumAudioId)) return unavailable('缺少歌曲关联 ID，无法查询曲库 MV');
  try {
    logger.info('PlayerMvAudio', 'Resolving catalog MV audio', {
      trackId: track.id,
      albumAudioId,
    });
    const payload = await getSongMv(albumAudioId);
    if (!isCurrent()) return null;
    const mv = pickCatalogMv(payload);
    if (!mv) {
      const versions = mapVideoMetaList(payload);
      const reason =
        versions.length && versions.every(isPlatformShortVideo)
          ? '关联视频均被平台标记为短视频，未找到可用 MV'
          : '未找到符合条件的曲库 MV';
      return unavailable(reason, {
        versions: versions.map((version) => ({
          videoId: version.videoId,
          title: version.title,
          duration: version.duration,
          albumAudioId: version.raw?.album_audio_id,
          ugc: version.raw?.is_ugc,
          other: version.raw?.is_other,
          short: isPlatformShortVideo(version),
          tags: version.tags?.map((tag) => tag.name),
        })),
      });
    }
    logger.info('PlayerMvAudio', 'Catalog MV selected', {
      trackId: track.id,
      videoId: mv.videoId,
      duration: mv.duration,
    });
    // Keep one small source per container/codec family, at most three. Video
    // resolution does not describe audio quality, and video bytes still cost traffic.
    const codecs = new Set<string>();
    const candidates = [...(mv.sources ?? [])]
      .sort((a, b) => (a.size || Infinity) - (b.size || Infinity))
      .filter((source) => {
        const codec = source.codec ?? '';
        if (codecs.has(codec)) return false;
        codecs.add(codec);
        return true;
      })
      .slice(0, 3);
    const results = await Promise.allSettled(candidates.map((source) => getVideoUrl(source.hash)));
    if (!isCurrent()) return null;
    const urls = new Set<string>();
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const root = toRecord(result.value);
      if (Number(root.status) !== 1) return;
      const data = toRecord(root.data);
      const entry = toRecord(data[candidates[index].hash.toLowerCase()]);
      const backups = Array.isArray(entry.backupdownurl) ? entry.backupdownurl : [];
      for (const value of [entry.downurl, entry.url, entry.play_url, ...backups]) {
        if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) urls.add(value.trim());
      }
    });
    if (!urls.size) return unavailable('曲库 MV 播放地址获取失败');
    const sources = [...urls].map((url) => ({ url, audioTrackId: null }));
    return {
      url: sources[0].url,
      urls: [...urls],
      source: sources[0],
      sources,
      sourceKind: 'mv',
      quality: null,
      effect: 'none',
      loudness: null,
    };
  } catch (error) {
    logger.warn('PlayerMvAudio', 'Catalog MV audio resolution failed', error);
    return unavailable('曲库 MV 查询失败，请稍后重试');
  }
};
