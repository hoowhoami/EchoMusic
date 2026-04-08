import request from '@/utils/request';

/**
 * 获取歌曲播放地址
 */
export function getSongUrl(hash: string, quality = '', ppageId?: string | number) {
  return request.get('/song/url', {
    params: { hash, quality, ...(ppageId ? { ppage_id: ppageId } : {}) },
  });
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
 * 获取云盘歌曲播放地址
 */
export async function getCloudSongUrl(hash: string): Promise<string | null> {
  const res = await request.get('/user/cloud/url', {
    params: {
      hash,
    },
  });
  if (res && typeof res === 'object') {
    const record = res as { status?: number; data?: { url?: string } };
    if (record.status === 1 && record.data?.url) return record.data.url;
  }
  return null;
}

/**
 * 搜索歌词
 */
export function searchLyric(hash: string) {
  return request.get('/search/lyric', {
    params: {
      hash,
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
