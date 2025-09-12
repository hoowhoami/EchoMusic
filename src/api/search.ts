import { api } from '@/utils/request';

// 默认搜索词
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

// 搜索
// 说明: 调用此接口 , 传入搜索关键词可以搜索该音乐 / mv / 歌单 / 歌词 / 专辑 / 歌手
// 必选参数：
// keyword: 关键词
// 可选参数：
// page : 页数
// pagesize : 每页页数, 默认为 30
// type: 搜索类型；默认为单曲，special：歌单，lyric：歌词，song：单曲，album：专辑，author：歌手，mv：mv
export const getSearchResult = (
  keywords: string,
  type: string = 'song',
  page: number = 1,
  pagesize: number = 30,
) => {
  return api.get('/search', {
    keywords,
    page,
    pagesize,
    type,
  });
};
