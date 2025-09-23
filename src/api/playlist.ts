import { api } from '@/utils/request';

// 获取用户歌单
// page：页数
// pagesize : 每页页数, 默认为 30
export const getPlaylist = (page: number = 1, pagesize: number = 30) => {
  return api.get('/user/playlist', { page, pagesize });
};

// 收藏歌单/新建歌单
// is_pri: 是否设为隐私，0：公开，1：隐私，仅支持创建歌单时传入
// type: 1：为收藏歌单，0：创建歌单, 默认为 0
// list_create_userid：歌单 list_create_userid
// list_create_listid：歌单 list_create_listid
export const addPlaylist = ({
  name = '',
  is_pri = 0,
  type = 0,
  list_create_userid = 0,
  list_create_listid = 0,
}) => {
  return api.get('/playlist/add', { name, is_pri, type, list_create_userid, list_create_listid });
};

// 取消收藏歌单/删除歌单
// listid: 用户歌单 listid
export const deletePlaylist = (listid: number) => {
  return api.get('/playlist/del', { listid });
};

// 对歌单添加歌曲
// listid: 用户歌单 listid
// data: 歌曲数据, 格式为 歌曲名称|歌曲 hash|专辑 id|(mixsongid/album_audio_id)，最少需要 歌曲名称以及歌曲 hash(若返回错误则需要全部参数)， 支持多个，每 个以逗号分隔
export const addPlaylistTrack = (listid: number, data: string) => {
  return api.get('/playlist/tracks/add', { listid, data });
};

// 对歌单删除歌曲
// listid: 用户歌单 listid
// fileids: 歌单中歌曲的 fileid，可多个,用逗号隔开
export const deletePlaylistTrack = (listid: number, fileids: string) => {
  return api.get('/playlist/tracks/del', { listid, fileids });
};

// 获取歌单详情
// ids: 歌单中的 global_collection_id，可以传多个，用逗号分隔
export const getPlaylistDetail = (ids: string) => {
  return api.get('/playlist/detail', { ids });
};

// 获取歌单所有歌曲
// id: 歌单中的 global_collection_id
// page : 页数
// pagesize : 每页页数, 默认为 30
export const getPlaylistTrackAll = (id: string, page: number = 1, pagesize: number = 30) => {
  return api.get('/playlist/track/all', { id, page, pagesize });
};

// 歌单分类
// 说明 : 调用此接口,可获取歌单分类,包含 category 信息
export const getPlaylistCategory = () => {
  return api.get('/playlist/tags');
};

// 获取歌单
// 说明 : 调用此接口 , 可获取歌单
// 必选参数：
// category_id: tag，0：推荐，11292：HI-RES，其他可以从 /playlist/tags 接口中获取（接口下的 tag_id 为 category_id的值）
// 可选参数：
// withsong: 是否返回歌曲列表（不全），0：不返回，1：返回
// withtag: 是否返回歌单分类，0：不返回，1：返回
export const getPlaylistByCategory = ({ category_id = '', withsong = 0, withtag = 1 }) => {
  return api.get('/top/playlist', { category_id, withsong, withtag });
};
