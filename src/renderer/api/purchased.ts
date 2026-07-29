import request from '@/utils/request';

/**
 * 获取已购单曲
 */
export function getPurchasedSongs(page = 1, pagesize = 30) {
  return request.get('/user/purchased/songs', {
    params: { page, pagesize },
  });
}

/**
 * 获取已购专辑
 */
export function getPurchasedAlbum(page = 1, pagesize = 30) {
  return request.get('/user/purchased/albums', {
    params: { page, pagesize },
  });
}
