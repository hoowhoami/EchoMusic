import { api } from '@/utils/request';

// 专辑详情
// 说明: 调用此接口 ,传入专辑 id 可获取专辑详情
// 必选参数：
// id: 专辑 id
export const getAlbumDetail = (id: number) => {
  return api.get('/album/detail', { id });
};

// 专辑音乐列表
// 说明: 调用此接口 ,传入专辑 id 可获取专辑音乐列表
// 必选参数：
// id: 专辑 id
// 可选参数：
// page : 页数
// pagesize : 每页页数, 默认为 30
export const getAlbumSongs = (id: number, page = 1, pagesize = 30) => {
  return api.get('/album/songs', { id, page, pagesize });
};

// 新碟上架
// 说明: 调用此接口 , 可获取新碟上架列表
// 可选参数：
// type : 1：华语；2：欧美；3：日本；4：韩国；推荐为空，默认为空
// page : 页数
// pagesize : 每页页数, 默认为 30
export const getAlbumTop = () => {
  return api.get('/top/album');
};
