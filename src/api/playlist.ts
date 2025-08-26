import { api } from '@/utils/request';

// 获取用户歌单
export const getPlaylist = (page: number = 1, pagesize: number = 100) => {
  return api.get('/user/playlist', { page, pagesize });
};

// 收藏歌单/新建歌单
// is_pri: 是否设为隐私，0：公开，1：隐私，仅支持创建歌单时传入
// type: 1：为收藏歌单，0：创建歌单, 默认为 0
// list_create_gid：歌单 list_create_gid
export const addPlaylist = (
  name: string,
  is_pri: number = 0,
  type: number = 0,
  list_create_gid: string = '',
) => {
  return api.get('/playlist/add', { name, is_pri, type, list_create_gid });
};

// 取消收藏歌单/删除歌单
// listid: 用户歌单 listid
export const deletePlaylist = (listid: string) => {
  return api.get('/playlist/del', { listid });
};

// 对歌单添加歌曲
// listid: 用户歌单 listid
// data: 歌曲数据, 格式为 歌曲名称|歌曲 hash|专辑 id|(mixsongid/album_audio_id)，最少需要 歌曲名称以及歌曲 hash(若返回错误则需要全部参数)， 支持多个，每 个以逗号分隔
export const addPlaylistTrack = (listid: string, data: string) => {
  return api.get('/playlist/track/add', { listid, data });
};

// 对歌单删除歌曲
// listid: 用户歌单 listid
// fileids: 歌单中歌曲的 fileid，可多个,用逗号隔开
export const deletePlaylistTrack = (listid: string, fileids: string) => {
  return api.get('/playlist/track/del', { listid, fileids });
};

// 获取歌单详情
// ids: global_collection_id 可以传多个，用逗号分隔
export const getPlaylistDetail = (ids: string) => {
  return api.get('/playlist/detail', { ids });
};

// id: global_collection_id
export const getPlaylistTrackAll = (id: string, page: number = 1, pagesize: number = 300) => {
  return api.get('/playlist/track/all', { id, page, pagesize });
};
