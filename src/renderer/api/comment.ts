import request from '@/utils/request';

/**
 * 获取歌曲评论
 */
export function getMusicComments(
  mixSongId: string | number,
  page = 1,
  pagesize = 30,
  options?: {
    showClassify?: boolean;
    showHotwordList?: boolean;
    sort?: number;
  },
) {
  const { showClassify = false, showHotwordList = false, sort = 2 } = options ?? {};
  return request.get('/comment/music', {
    params: {
      mixsongid: mixSongId,
      page,
      pagesize,
      show_classify: showClassify ? 1 : 0,
      show_hotword_list: showHotwordList ? 1 : 0,
      sort,
    },
  });
}

/**
 * 获取歌曲分类评论
 */
export function getMusicClassifyComments(
  mixSongId: string | number,
  typeId: string | number,
  page = 1,
  pagesize = 30,
  sort = 2,
) {
  return request.get('/comment/music/classify', {
    params: {
      mixsongid: mixSongId,
      type_id: typeId,
      page,
      pagesize,
      sort,
    },
  });
}

/**
 * 获取歌曲热词评论
 */
export function getMusicHotwordComments(
  mixSongId: string | number,
  hotWord: string,
  page = 1,
  pagesize = 30,
  sort = 2,
) {
  return request.get('/comment/music/hotword', {
    params: {
      mixsongid: mixSongId,
      hot_word: hotWord,
      page,
      pagesize,
      sort,
    },
  });
}

/**
 * 获取歌单评论
 */
export function getPlaylistComments(
  id: string | number,
  page = 1,
  pagesize = 30,
  options?: { showClassify?: boolean; showHotwordList?: boolean },
) {
  const { showClassify = false, showHotwordList = false } = options ?? {};
  return request.get('/comment/playlist', {
    params: {
      id,
      page,
      pagesize,
      show_classify: showClassify ? 1 : 0,
      show_hotword_list: showHotwordList ? 1 : 0,
    },
  });
}

/**
 * 获取专辑评论
 */
export function getAlbumComments(
  id: string | number,
  page = 1,
  pagesize = 30,
  options?: { showClassify?: boolean; showHotwordList?: boolean },
) {
  const { showClassify = false, showHotwordList = false } = options ?? {};
  return request.get('/comment/album', {
    params: {
      id,
      page,
      pagesize,
      show_classify: showClassify ? 1 : 0,
      show_hotword_list: showHotwordList ? 1 : 0,
    },
  });
}

/**
 * 获取楼层评论
 */
export function getFloorComments(params: {
  specialId: string | number;
  tid: string | number;
  mixSongId?: string | number;
  code?: string;
  resourceType?: 'music' | 'playlist' | 'album';
  page?: number;
  pagesize?: number;
}) {
  return request.get('/comment/floor', {
    params: {
      special_id: params.specialId,
      tid: params.tid,
      mixsongid: params.mixSongId,
      code: params.code,
      resource_type: params.resourceType,
      page: params.page ?? 1,
      pagesize: params.pagesize ?? 30,
    },
  });
}

/**
 * 获取评论数
 */
export function getCommentCount(hash: string, specialId?: string) {
  return request.get('/comment/count', {
    params: {
      hash,
      special_id: specialId,
    },
  });
}

/**
 * 获取收藏数
 */
export function getFavoriteCount(mixsongids: string | number) {
  return request.get('/favorite/count', {
    params: { mixsongids },
  });
}
