import request from '@/utils/request';

/**
 * 获取推荐歌单
 */
export function getRecommendPlaylists() {
  return request.get('/playlist/recommend');
}

/**
 * 获取歌单详情
 */
export function getPlaylistDetail(ids: string) {
  return request.get('/playlist/detail', {
    params: { ids }
  });
}

/**
 * 获取歌单所有歌曲
 */
export function getPlaylistTracks(id: string | number, page = 1, pagesize = 30) {
  return request.get('/playlist/track/all', {
    params: { id, page, pagesize }
  });
}

/**
 * 获取歌单所有歌曲 (新版 - 支持用户歌单)
 */
export function getPlaylistTracksNew(listid: string | number, page = 1, pagesize = 30) {
  return request.get('/playlist/track/all/new', {
    params: { listid, page, pagesize }
  });
}

/**
 * 获取用户歌单
 */
export function getUserPlaylists(page = 1, pagesize = 30) {
  return request.get('/user/playlist', {
    params: { page, pagesize }
  });
}

/**
 * 获取排行榜列表
 */
export function getRanks() {
  return request.get('/rank/list');
}

/**
 * 获取歌单分类
 */
export function getPlaylistTags() {
  return request.get('/playlist/tags');
}

/**
 * 获取排行榜推荐列表
 */
export function getRankTop() {
  return request.get('/rank/top');
}

/**
 * 获取推荐歌单 (分类)
 */
export function getPlaylistByCategory(categoryId = '0', withsong = 0, withtag = 1) {
  return request.get('/top/playlist', {
    params: {
      category_id: categoryId,
      withsong,
      withtag,
    },
  });
}

/**
 * 获取编辑精选
 */
export function getTopIP() {
  return request.get('/top/ip');
}

/**
 * 获取排行榜歌曲
 */
export function getRankSongs(rankid: number, page = 1, pagesize = 100) {
  return request.get('/rank/audio', {
    params: { rankid, page, pagesize }
  });
}

/**
 * 向歌单添加歌曲
 * @param listid 歌单 ID
 * @param data 歌曲数据，格式: name|hash|albumid|mixsongid
 */
export function addPlaylistTrack(listid: string | number, data: string) {
  return request.get('/playlist/tracks/add', {
    params: { listid, data }
  });
}

/**
 * 从歌单删除歌曲
 * @param listid 歌单 ID
 * @param fileids 歌曲文件 ID (mixsongid)，多个用逗号隔开
 */
export function deletePlaylistTrack(listid: string | number, fileids: string) {
  return request.get('/playlist/tracks/del', {
    params: { listid, fileids }
  });
}

/**
 * 收藏歌单 (拷贝到用户歌单)
 * @param name 歌单名称
 * @param list_create_userid 原歌单创建者
 * @param list_create_listid 原歌单 ID
 * @param list_create_gid 原歌单 GID
 * @param source 来源 (1: 歌单, 2: 专辑)
 */
export function addPlaylist(
  name: string,
  params: {
    is_pri?: number;
    type?: number;
    list_create_userid?: number;
    list_create_listid?: number;
    list_create_gid?: string;
    source?: number;
  } = {}
) {
  return request.get('/playlist/add', {
    params: {
      name,
      is_pri: params.is_pri ?? 0,
      type: params.type ?? 1,
      source: params.source ?? 1,
      ...(params.list_create_userid !== undefined
        ? { list_create_userid: params.list_create_userid }
        : {}),
      ...(params.list_create_listid !== undefined
        ? { list_create_listid: params.list_create_listid }
        : {}),
      ...(params.list_create_gid ? { list_create_gid: params.list_create_gid } : {}),
    },
  });
}

/**
 * 取消收藏歌单 / 删除歌单
 */
export function deletePlaylist(listid: string | number) {
  return request.get('/playlist/del', {
    params: { listid },
  });
}
