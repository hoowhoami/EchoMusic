import { api } from '@/utils/request';

//
export const getSearchDefault = () => {
  return api.get('/search/default');
};

// 热搜列表
export const getSearchHot = () => {
  return api.get('/search/hot');
};

// 搜索建议
// 说明 : 调用此接口 , 传入搜索关键词可获得搜索建议 , 搜索结果同时包含单曲 , 歌手 , 歌单信息
// 可选参数：
// albumTipCount : 专辑返回数量
// correctTipCount : 目前未知，可能是歌单
// mvTipCount : MV 返回数量
// musicTipCount : 音乐返回数量
export const getSearchSuggest = (
  keywords: string,
  albumTipCount: number = 10,
  correctTipCount: number = 0,
  mvTipCount: number = 0,
  musicTipCount: number = 10,
) => {
  return api.get('/search/suggest', {
    keywords,
    albumTipCount,
    correctTipCount,
    mvTipCount,
    musicTipCount,
  });
};
