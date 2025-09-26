import { api } from '@/utils/request';

// 排行列表
// 说明：调用此接口，可以获取排行榜列表
// 可选参数：
// withsong：是否返回歌曲（部分）
export const getRankList = () => {
  return api.get('/rank/list');
};

// 排行榜歌曲列表
// 说明：调用此接口，可以获排行榜歌曲列表
// 必选参数：
// rankid：排行榜 id
// 可选参数：
// rank_cid：若需要返回往期歌曲列表，则该参数为必填，否则默认返回最新一期，/rank/vol 返回值中，volid 则为该参数
// page： 页码
// pagesize: 每页页数, 默认为 30
export const getRankSongList = ({ rankid = 0, rank_cid = undefined, page = 1, pagesize = 30 }) => {
  return api.get('/rank/audio', {
    rankid,
    rank_cid,
    page,
    pagesize,
  });
};

// 排行榜推荐列表
// 说明：调用此接口，可以获取排行榜推荐列表
export const getRankTop = () => {
  return api.get('/rank/top');
};
