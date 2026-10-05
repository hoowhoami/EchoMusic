import request from '@/utils/request';
import { getUserVerify } from './user';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
import { getCurrentRequestOrigin, runWithRequestOrigin } from '@/utils/serverInterceptors';

export interface AudioImagePortrait {
  id?: number;
  file_hash?: string;
  sizable_portrait?: string;
  filename?: string;
  publish_time?: string;
  source?: number;
}

export interface AudioImageAuthor {
  author_id?: number;
  author_name?: string;
  is_publish?: number;
  res_hash?: string;
  avatar?: string;
  sizable_avatar?: string;
  audio_publish_date?: string;
  imgs?: Record<string, AudioImagePortrait[] | undefined>;
}

export type PersonalFmMode = 'normal' | 'small' | 'peak' | 'radio';

export type PersonalFmAction =
  | 'play'
  | 'login'
  | 'garbage'
  | 'cancel_garbage'
  | 'click_red'
  | 'cancel_red'
  | 'download'
  | 'black_singer'
  | 'cancel_black_singer'
  | 'update_recommend_source'
  | 'change_song_pool';

export interface PersonalFmParams {
  hash?: string;
  songid?: string | number;
  playtime?: string | number;
  mode?: PersonalFmMode | string;
  action?: PersonalFmAction | string;
  song_pool_id?: string | number;
  is_overplay?: string | number;
  remain_songcnt?: string | number;
  cur_mark?: string | number;
}

export interface EverydayStyleRecommendParams {
  platform?: 'ios' | 'android';
  tagids?: string;
}

export interface HomeDiscoverParams {
  support?: 'only_song' | string;
  recallType?: 'song' | 'mv' | 'album' | 'songlist' | 'radio' | 'anchor' | string;
  todayPlayNum?: number;
  pagesize?: number;
  goKyExtra?: Array<{ key: string; val: string }>;
}

export interface CloudSongUrlResult {
  url: string;
  urls: string[];
  payload: CloudSongUrlResponse;
}

export interface CloudSongUrlData {
  url?: string;
  backup_url?: string | string[];
  backupUrl?: string | string[];
  hash?: string;
  fileSize?: string | number;
  extName?: string;
  volume?: number;
  volume_gain?: number;
  volumeGain?: number;
  volume_peak?: number;
  volumePeak?: number;
}

export interface CloudSongUrlResponse {
  status?: number;
  error_code?: number;
  data?: CloudSongUrlData;
}

const normalizeCloudSongUrls = (data: CloudSongUrlData): string[] => {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const url = value.trim();
    if (url) urls.add(url);
  };

  add(data.url);
  const backups = data.backup_url ?? data.backupUrl;
  if (Array.isArray(backups)) {
    backups.forEach(add);
  } else {
    add(backups);
  }
  return [...urls];
};

export interface SongUrlOptions {
  albumId?: string | number;
  albumAudioId?: string | number;
  auth?: string;
}

/**
 * 获取歌曲播放地址，由 Auth 聚合接口完成歌曲授权和地址获取。
 */
export async function getSongUrl(
  hash: string,
  quality = '',
  ppageId?: string | number,
  options?: SongUrlOptions,
) {
  const origin = getCurrentRequestOrigin();
  const isCurrentSession = captureUserSession(useUserStore());
  let auth = options?.auth;
  if (!auth) {
    const response = await getUserVerify();
    if (!isCurrentSession()) throw new Error('登录状态已变化，请重新发起操作');
    auth = response?.data?.auth;
    if (response?.status !== 1 || typeof auth !== 'string' || !auth.trim()) {
      const error = new Error(response?.msg || '获取歌曲播放授权失败');
      (error as Error & { response?: unknown }).response = response;
      throw error;
    }
  }
  // 授权请求后的异步续体仍沿用调用方来源，避免插件请求进入自身拦截器。
  return runWithRequestOrigin(origin, () =>
    request.get('/song/url/auth/merge', {
      params: {
        hash,
        quality,
        auth,
        ...(ppageId ? { ppage_id: ppageId } : {}),
        ...(options?.albumId ? { album_id: options.albumId } : {}),
        ...(options?.albumAudioId ? { album_audio_id: options.albumAudioId } : {}),
      },
    }),
  );
}

/**
 * 获取歌曲播放权限/音质信息
 */
export function getSongPrivilegeLite(hash: string, albumId?: string | number) {
  return request.get('/privilege/lite', {
    params: {
      hash,
      album_id: albumId,
    },
  });
}

/**
 * 批量获取歌曲元信息。一起听歌单有时只返回 hash，需要用该接口补齐歌名、歌手和封面。
 */
export function getAudioMetadata(hashes: string[]) {
  const normalized = Array.from(new Set(hashes.map((hash) => String(hash).trim()).filter(Boolean)));
  return request.get('/audio', {
    params: { hash: normalized.join(',') },
  });
}

/** 按专辑歌曲 ID 批量获取歌曲、歌手和专辑信息。 */
export function getSongMetadata(albumAudioIds: string[]) {
  return request.get('/krm/audio', {
    params: {
      album_audio_id: [...new Set(albumAudioIds)].join(','),
      fields: 'album_info,base,authors.base',
    },
  });
}

/**
 * 获取云盘歌曲播放地址
 */
export async function getCloudSongUrl(
  hash: string,
  options?: {
    cloudFileId?: string | number;
    albumAudioId?: string | number;
    audioId?: string | number;
    name?: string;
  },
): Promise<CloudSongUrlResult | null> {
  const res = await request.get('/user/cloud/url', {
    params: {
      hash,
      ...(options?.cloudFileId ? { fileid: options.cloudFileId, kv_id: options.cloudFileId } : {}),
      ...(options?.albumAudioId ? { album_audio_id: options.albumAudioId } : {}),
      ...(options?.audioId ? { audio_id: options.audioId } : {}),
      ...(options?.name ? { name: options.name } : {}),
    },
  });
  if (res && typeof res === 'object') {
    const record = res as CloudSongUrlResponse;
    if (record.status === 1 && record.data?.url) {
      const urls = normalizeCloudSongUrls(record.data);
      return {
        url: record.data.url,
        urls,
        payload: record,
      };
    }
  }
  return null;
}

/**
 * 搜索歌词
 * @param hash 歌曲 hash
 * @param options.duration 歌曲时长（毫秒），来自歌曲自身 duration（秒）转毫秒
 * @param options.albumAudioId 歌曲的 album_audio_id，辅助提升匹配准确度
 * @param options.man 是否返回多个歌词：'no' 获取默认歌词，'yes' 获取歌词候选列表
 */
export function searchLyric(
  hash: string,
  options?: { duration?: number; albumAudioId?: string | number; man?: 'yes' | 'no' },
) {
  return request.get('/search/lyric', {
    params: {
      hash,
      man: options?.man ?? 'no',
      ...(options?.duration ? { duration: options.duration } : {}),
      ...(options?.albumAudioId ? { album_audio_id: options.albumAudioId } : {}),
    },
  });
}

/**
 * 获取歌词详情
 */
export function getLyric(id: string, accesskey: string) {
  return request.get('/lyric', {
    params: { id, accesskey, decode: 'true', fmt: 'krc' },
  });
}

/**
 * 获取新歌榜
 */
export function getNewSongs() {
  return request.get('/top/song');
}

/**
 * 获取新碟上架
 */
export function getAlbumTop(type = '') {
  return request.get('/top/album', {
    params: {
      ...(type ? { type } : {}),
    },
  });
}

/**
 * 获取每日推荐歌曲
 */
export function getEverydayRecommend() {
  return request.get('/everyday/recommend');
}

/**
 * 获取风格推荐歌曲
 */
export function getEverydayStyleRecommend(params: EverydayStyleRecommendParams = {}) {
  return request.get('/everyday/style/recommend', {
    params: {
      platform: params.platform ?? 'ios',
      ...(params.tagids ? { tagids: params.tagids } : {}),
    },
  });
}

export function getPersonalFm(params: PersonalFmParams = {}) {
  return request.get('/personal/fm', {
    params,
  });
}

/**
 * 首页刷歌推荐流。上游仅验证 only_song 可稳定返回歌曲内容。
 */
let discoverRequestTimestamp = 0;

export function getHomeDiscover(params: HomeDiscoverParams = {}) {
  discoverRequestTimestamp = Math.max(Date.now(), discoverRequestTimestamp + 1);
  return request.get('/home/discover', {
    params: {
      support: params.support ?? 'only_song',
      recall_type: params.recallType ?? 'song',
      timestamp: discoverRequestTimestamp,
    },
    headers: { 'X-Skip-Auth': '1' },
  });
}

/**
 * 获取歌曲高潮片段
 */
export function getSongClimax(hash: string) {
  return request.get('/song/climax', {
    params: { hash },
  });
}

/**
 * 获取歌曲榜单信息
 */
export function getSongRanking(albumAudioId: string | number) {
  return request.get('/song/ranking', {
    params: { album_audio_id: albumAudioId },
  });
}

/**
 * 获取歌曲榜单过滤
 */
export function getSongRankingFilter(albumAudioId: string | number, page = 1, pagesize = 30) {
  return request.get('/song/ranking/filter', {
    params: { album_audio_id: albumAudioId, page, pagesize },
  });
}

/**
 * 获取歌曲关联歌手图片
 */
export function getAudioImages(params: {
  hash: string;
  audioId?: string | number;
  albumAudioId?: string | number;
  filename?: string;
  count?: number;
}) {
  return request.get('/images/audio', {
    params: {
      hash: params.hash,
      audio_id: params.audioId,
      album_audio_id: params.albumAudioId,
      filename: params.filename,
      count: params.count ?? 5,
    },
  });
}
