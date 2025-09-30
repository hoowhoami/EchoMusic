import { api } from '@/utils/request';

// 每日推荐
// 说明：调用此接口，可以获取每日推荐列表
// 可选参数：
// platform：设备类型，默认为 ios,支持 android 和 ios
export const getEverydayRecommend = (platform: 'android' | 'ios' = 'ios') => {
  return api.get('/everyday/recommend', {
    platform,
  });
};

// 编辑精选
// 说明 : 调用此接口 , 可获取编辑精选数据
export const getTopIP = () => {
  return api.get('/top/ip');
};

// 编辑精选数据
// 说明 : 调用此接口 , 可获取编辑对应数据
// 必选参数：
// id: ip id
// 可选参数：
// type: 数据类型，audios: 音乐, albums: 专辑, videos: 视频, author_list: 歌手
// page： 页码
// pagesize: 每页页数, 默认为 30
export const getIPData = ({ id = 0, type = '', page = 1, pagesize = 30 }) => {
  return api.get('/ip', {
    id,
    type,
    page,
    pagesize,
  });
};

// 编辑精选歌单
// 说明：调用此接口，可获取编辑精选歌单数据
// 必选参数：
// id: ip id
// 可选参数：
// page： 页码
// pagesize: 每页页数, 默认为 30
export const getTopPlaylistByIP = ({ id = 0, page = 1, pagesize = 30 }) => {
  return api.get('/ip/playlist', {
    id,
    page,
    pagesize,
  });
};
