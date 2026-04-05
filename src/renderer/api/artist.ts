import request from '@/utils/request';

/**
 * 获取歌手详情
 */
export function getArtistDetail(id: string | number) {
  return request.get('/artist/detail', { params: { id } });
}

/**
 * 获取歌手单曲
 */
export function getArtistSongs(
  id: string | number,
  page = 1,
  pagesize = 200,
  sort: 'hot' | 'new' = 'hot'
) {
  return request.get('/artist/audios', { params: { id, page, pagesize, sort } });
}

/**
 * 获取歌手专辑
 */
export function getArtistAlbums(
  id: string | number,
  page = 1,
  pagesize = 30,
  sort: 'hot' | 'new' = 'hot'
) {
  return request.get('/artist/albums', { params: { id, page, pagesize, sort } });
}

/**
 * 关注歌手
 */
export function followArtist(id: string | number) {
  return request.get('/artist/follow', { params: { id } });
}

/**
 * 取消关注歌手
 */
export function unfollowArtist(id: string | number) {
  return request.get('/artist/unfollow', { params: { id } });
}
