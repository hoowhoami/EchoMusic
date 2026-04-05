import request from '@/utils/request';

/**
 * 获取专辑详情
 */
export function getAlbumDetail(id: string | number) {
  return request.get('/album/detail', {
    params: { id },
  });
}

/**
 * 获取专辑歌曲
 */
export function getAlbumSongs(id: string | number, page = 1, pagesize = 30) {
  return request.get('/album/songs', {
    params: { id, page, pagesize },
  });
}

/**
 * 收藏专辑
 */
export function favoriteAlbum(id: string | number, name: string, singerId?: number) {
  return request.get('/playlist/add', {
    params: {
      name,
      is_pri: 0,
      type: 1,
      source: 2,
      ...(singerId !== undefined ? { list_create_userid: singerId } : {}),
      list_create_listid: id,
    },
  });
}

/**
 * 取消收藏专辑
 */
export function unfavoriteAlbum(listid: string | number) {
  return request.get('/playlist/del', {
    params: { listid },
  });
}
