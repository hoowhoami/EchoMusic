import request from '@/utils/request';
import { assertCommentLength } from '@/utils/commentLimits';
import type { Comment } from '@/models/comment';

export type CommentSendType = 'music' | 'album' | 'playlist' | 'song-barrage' | 'video-barrage';

export interface CommentSendResource {
  type: CommentSendType;
  id?: string;
  hash?: string;
  name?: string;
}

export function assertCommentSuccess(response: any) {
  const code = response?.err_code ?? response?.error_code ?? response?.errcode;
  if (!response || Number(response.status) !== 1 || (code != null && Number(code) !== 0)) {
    throw new Error(String(response?.msg || response?.message || '请求未成功，请稍后重试'));
  }
}

export async function sendComment(resource: CommentSendResource, content: string) {
  const barrage = resource.type.endsWith('-barrage');
  assertCommentLength(content, barrage);
  const path = barrage ? resource.type.replace('-', '/') : `comment/${resource.type}`;
  let response;
  try {
    response = await request.post(`/${path}/send`, {
      content,
      name: resource.name,
      ...(barrage
        ? { hash: resource.hash }
        : resource.type === 'music'
          ? { mixsongid: resource.id }
          : { id: resource.id }),
    });
  } catch (error) {
    const body = (error as { response?: { body?: { msg?: string; message?: string } } })?.response
      ?.body;
    if (body?.msg || body?.message) throw new Error(String(body.msg || body.message));
    throw error;
  }
  assertCommentSuccess(response);
  return response;
}

export async function getBarrage(type: 'song' | 'video', hash: string, page = 1) {
  const response = await request.get(`/${type}/barrage`, { params: { hash, page, pagesize: 100 } });
  assertCommentSuccess(response);
  return response;
}

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
  const params: Record<string, string> = { hash };
  if (specialId) params.special_id = specialId;
  return request.get('/comment/count', { params });
}

/**
 * 获取收藏数
 */
export function getFavoriteCount(mixsongids: string | number) {
  return request.get('/favorite/count', {
    params: { mixsongids },
  });
}

export interface FloorReplyRequest {
  root: Comment;
  target: Comment;
  content: string;
  resourceType: 'music' | 'album' | 'playlist';
  mixSongId?: string;
}

export async function sendFloorComment({
  root,
  target,
  content,
  resourceType,
  mixSongId,
}: FloorReplyRequest) {
  assertCommentLength(content);
  const specialId = root.specialId || root.specialChildId || root.special_child_id;
  const tid = root.tid || root.id;
  if (!specialId || !tid) throw new Error('缺少楼层信息，请刷新评论后再试');
  const topLevel = String(root.id) === String(target.id);
  if (!topLevel && !target.id) throw new Error('缺少回复目标，请重新选择评论');
  if (!content.trim()) throw new Error('回复内容不能为空');
  try {
    const response = await request.post('/comment/floor/send', {
      special_id: specialId,
      tid,
      pid: topLevel ? 0 : target.id,
      is_t: topLevel ? 1 : 0,
      content: content.trim(),
      resource_type: resourceType === 'music' ? 'song' : resourceType,
      code: root.code || undefined,
      mixsongid: resourceType === 'music' ? root.mixSongId || mixSongId : undefined,
      ...(topLevel ? {} : { reply_user_name: target.userName, reply_content: target.content }),
    });
    assertCommentSuccess(response);
  } catch (error) {
    const body = (error as { response?: { body?: { msg?: string; message?: string } } })?.response
      ?.body;
    if (body?.msg || body?.message) throw new Error(String(body.msg || body.message));
    throw error;
  }
}
