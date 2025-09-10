import { api } from '@/utils/request';

// 获取歌手详情
// 说明 : 调用此接口 , 传入歌手 id, 可获得歌手信息
// 必选参数：
// id： 歌手 id
export const getSingerDetail = (id: number) => {
  return api.get('/artist/detail', {
    id,
  });
};

// 获取歌手单曲
// 说明 : 调用此接口 , 传入歌手 id, 可获得歌手歌曲
// 必选参数：
// id： 歌手 id
// 可选参数：
// page： 页码
// pagesize: 每页页数, 默认为 30
// sort: 排序，hot : 热门, new: 最新
export const getSingerSongs = ({ id = 0, page = 1, pagesize = 30, sort = 'hot' }) => {
  return api.get('/artist/audios', {
    id,
    page,
    pagesize,
    sort,
  });
};

// 关注歌手
// 说明：调用此接口, 传入歌手 id, 可以关注该歌手（需要登录）
// 必选参数：
// id: 歌手 id
export const followSinger = (id: number) => {
  return api.get('/artist/follow', {
    id,
  });
};

// 取消关注歌手
// 说明：调用此接口, 传入歌手 id, 可以取消关注该歌手（需要登录）
// 必选参数：
// id: 歌手 id
export const unfollowSinger = (id: number) => {
  return api.get('/artist/unfollow', {
    id,
  });
};
