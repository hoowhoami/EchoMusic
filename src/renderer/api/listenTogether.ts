import request from '@/utils/request';
import {
  getListenTogetherRoomBiz,
  type ListenTogetherAudioRef,
  type ListenTogetherCreateInput,
  type ListenTogetherMusicRoomCreateInput,
  type ListenTogetherRoomType,
  type ListenTogetherStudyRoomCreateInput,
} from '@/models/listenTogether';

const routes = {
  study: '/listen/together/study',
  music: '/listen/together/music',
  room: '/listen/together/room',
  chat: '/listen/together/chat',
  discovery: '/listen/together/discovery',
} as const;

export class ListenTogetherApiError extends Error {
  readonly code: number;
  readonly payload: unknown;

  constructor(message: string, code = 0, payload?: unknown) {
    super(message);
    this.name = 'ListenTogetherApiError';
    this.code = code;
    this.payload = payload;
  }
}

let requestSequence = 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const errorMessageByCode = (code: number) => {
  // 20002 在房间域表示“群组不存在”，并不是通用鉴权错误；鉴权失败使用 51002。
  if (code === 51002) return '请先登录后再使用一起听';
  if (code === 20003) return '房间音乐配置不完整';
  if (code === 20006) return '账号当前已有未结束的众乐房会话';
  if (code === 55004) return '已达到房间创建上限，请先管理已有房间';
  return code ? `一起听服务暂不可用（${code}）` : '一起听服务暂不可用';
};

const extractErrorPayload = (error: unknown) => {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  return response?.body ?? record?.body ?? null;
};

const ensureSuccess = (payload: unknown) => {
  const record = asRecord(payload);
  if (!record) return payload;
  const code = Number(record.error_code ?? record.errcode ?? 0);
  const failed = Number(record.status ?? 1) === 0 || code !== 0;
  if (!failed) return payload;
  const message = String(record.error_msg ?? record.error ?? record.msg ?? '').trim();
  throw new ListenTogetherApiError(message || errorMessageByCode(code), code, payload);
};

const callListenTogetherEndpoint = async (
  endpoint: (typeof routes)[keyof typeof routes],
  operation: string,
  params: Record<string, unknown> = {},
) => {
  requestSequence = (requestSequence + 1) % 1000;
  try {
    const payload = await request.post(endpoint, params, {
      params: {
        operation,
        timestamp: `${Date.now()}${String(requestSequence).padStart(3, '0')}`,
      },
    });
    return ensureSuccess(payload);
  } catch (error) {
    if (error instanceof ListenTogetherApiError) throw error;
    const payload = extractErrorPayload(error);
    if (payload) return ensureSuccess(payload);
    throw new ListenTogetherApiError(
      error instanceof Error && error.message ? error.message : '一起听网络请求失败',
      0,
      error,
    );
  }
};

export const getListenTogetherRooms = (params: {
  roomType: ListenTogetherRoomType;
  page?: number;
  pageSize?: number;
  sort?: number;
  tagId?: string;
}) =>
  callListenTogetherEndpoint(params.roomType === 0 ? routes.music : routes.study, 'list', {
    page: params.page ?? 1,
    pagesize: params.pageSize ?? 20,
    sort: params.sort ?? 0,
    tag_id: params.tagId ?? '',
    tags: params.tagId ?? '',
  });

export const getCreatedListenTogetherStudyRooms = () =>
  callListenTogetherEndpoint(routes.study, 'created_rooms');

export const getListenTogetherMusicRoomHistory = (lastId = 0) =>
  callListenTogetherEndpoint(routes.music, 'history', { last_id: lastId });

export const deleteCreatedListenTogetherStudyRoom = (roomId: string, channelId: string) =>
  callListenTogetherEndpoint(routes.study, 'delete_created_room', {
    room_id: roomId,
    global_collection_id: channelId,
  });

export const getListenTogetherRoomDetail = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(roomType === 0 ? routes.music : routes.study, 'detail', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const getListenTogetherMembers = (
  roomId: string,
  roomType: ListenTogetherRoomType,
  pageSize = 100,
  memberType: 1 | 2 = 1,
) =>
  callListenTogetherEndpoint(roomType === 0 ? routes.music : routes.study, 'members', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
    page: 1,
    pagesize: pageSize,
    member_type: memberType,
  });

export const searchListenTogetherChannels = (keyword: string) =>
  callListenTogetherEndpoint(routes.discovery, 'channel_search', {
    keyword,
    page: 1,
    position: 1,
  });

export const checkListenTogetherMinor = () =>
  callListenTogetherEndpoint(routes.room, 'check_minor');

export const createListenTogetherGroup = (input: ListenTogetherCreateInput) => {
  if (input.roomType === 1) {
    return callListenTogetherEndpoint(routes.room, 'create', {
      biz: getListenTogetherRoomBiz(input.roomType),
      room_privacy: 3,
      biz_defined_data: [{ key: 'lyric_switch', value: 1 }],
    });
  }
  return callListenTogetherEndpoint(routes.room, 'create', {
    biz: getListenTogetherRoomBiz(input.roomType),
    introduction: input.name.trim(),
    room_privacy: input.privacy,
    capacity: input.capacity ?? 5,
    background_url: input.backgroundUrl,
  });
};

export const configureListenTogetherRoom = (
  roomId: string,
  input: ListenTogetherStudyRoomCreateInput,
) =>
  callListenTogetherEndpoint(routes.study, 'configure', {
    room_id: roomId,
    room_name: input.name,
    room_notice: input.notice,
    global_collection_id: input.channelId,
    allow_chat: input.allowChat ? 1 : 0,
    room_tag: input.roomTag ?? '13,14',
    music_type: 1,
    music_style: input.musicStyles.join(','),
    audios: input.audios,
  });

export const initializeListenTogetherMusicRoom = (
  roomId: string,
  input: ListenTogetherMusicRoomCreateInput,
) =>
  callListenTogetherEndpoint(routes.music, 'initialize', {
    room_id: roomId,
    sendall: 1,
    audios: input.audios,
    progress_info: input.progressInfo,
  });

export const joinListenTogetherRoom = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(routes.room, 'join', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const getListenTogetherRoomState = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(routes.room, 'state', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const heartbeatListenTogetherRoom = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(routes.room, 'heartbeat', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const getListenTogetherStatus = (roomType: ListenTogetherRoomType, roomId = '') =>
  callListenTogetherEndpoint(routes.room, 'status', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const leaveListenTogetherRoom = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(routes.room, 'leave', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const dismissListenTogetherRoom = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(routes.room, 'dismiss', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
  });

export const sendListenTogetherMessage = (
  roomId: string,
  roomType: ListenTogetherRoomType,
  message: string,
  profile: { nickname?: string; avatarUrl?: string },
) =>
  callListenTogetherEndpoint(routes.chat, 'send', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
    message,
    alert: message,
    nickname: profile.nickname ?? '',
    img: profile.avatarUrl ?? '',
  });

export const getListenTogetherMessages = (
  roomId: string,
  roomType: ListenTogetherRoomType,
  maxId = '0',
) =>
  callListenTogetherEndpoint(routes.chat, 'history', {
    room_id: roomId,
    biz: getListenTogetherRoomBiz(roomType),
    maxid: maxId,
    pagesize: '50',
  });

export const syncListenTogetherPlayer = (roomId: string, roomType: ListenTogetherRoomType) =>
  callListenTogetherEndpoint(roomType === 0 ? routes.music : routes.study, 'sync_player', {
    room_id: roomId,
  });

export const switchListenTogetherMusicRoomSong = (
  roomId: string,
  audio: ListenTogetherAudioRef,
  options: { listVersion?: string; isAuto?: boolean } = {},
) =>
  callListenTogetherEndpoint(routes.music, 'switch_song', {
    room_id: roomId,
    act_type: 1,
    list_version: options.listVersion ?? '',
    is_auto: options.isAuto ? 1 : 0,
    hash: audio.hash,
    mixsongid: audio.mixSongId,
  });

export const updateListenTogetherMusicRoomPlayer = (
  roomId: string,
  operation:
    | { action: 1; playMode: 1 | 2 | 3 }
    | { action: 2; progress: number }
    | { action: 3; playing: boolean },
) =>
  callListenTogetherEndpoint(routes.music, 'player_operation', {
    room_id: roomId,
    action: operation.action,
    play_mode: operation.action === 1 ? operation.playMode : undefined,
    progress: operation.action === 2 ? operation.progress : undefined,
    pause: operation.action === 3 ? (operation.playing ? 1 : 2) : undefined,
  });

export const getListenTogetherPlaylist = (
  roomId: string,
  roomType: ListenTogetherRoomType,
  cursor?: ListenTogetherAudioRef,
) =>
  callListenTogetherEndpoint(roomType === 0 ? routes.music : routes.study, 'playlist', {
    room_id: roomId,
    pagesize: 50,
    audio: cursor,
  });

// 概念版听众端不会翻完整房主歌单，而是直接取服务端维护的近期播放队列。
export const getListenTogetherRecentPlaylist = (roomId: string) =>
  callListenTogetherEndpoint(routes.music, 'recent_playlist', {
    room_id: roomId,
  });

export const requestListenTogetherSong = (roomId: string, audio: ListenTogetherAudioRef) =>
  callListenTogetherEndpoint(routes.music, 'order_song', {
    room_id: roomId,
    hash: audio.hash,
    mixsongid: audio.mixSongId,
  });

export const getListenTogetherSongOrders = (roomId: string) =>
  callListenTogetherEndpoint(routes.music, 'song_order_list', { room_id: roomId });

export const removeListenTogetherSongOrder = (
  roomId: string,
  audio: ListenTogetherAudioRef,
  requesterId: string,
) =>
  callListenTogetherEndpoint(routes.music, 'remove_song', {
    room_id: roomId,
    hash: audio.hash,
    mixsongid: audio.mixSongId,
    order_userid: requesterId,
  });

export const addListenTogetherMusicRoomSongs = (
  roomId: string,
  audios: ListenTogetherAudioRef[],
  options: {
    action?: 1 | 4;
    listVersion?: string;
    progressInfo?: Record<string, unknown>;
    requesterId?: string;
  } = {},
) =>
  callListenTogetherEndpoint(routes.music, 'music_add', {
    room_id: roomId,
    action: options.action ?? (options.requesterId ? 4 : 1),
    list_version: options.listVersion ?? '',
    sendall: 1,
    audios,
    progress_info: options.progressInfo,
    order_userid: options.requesterId ?? '',
    source: options.requesterId ? 1 : undefined,
  });
