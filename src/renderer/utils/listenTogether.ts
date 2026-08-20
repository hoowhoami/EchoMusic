import type { Song } from '@/models/song';
import { normalizeCoverUrl } from '@/utils/cover';
import { mapTopSong } from '@/utils/mappers/song';
import type {
  ListenTogetherAudioRef,
  ListenTogetherChannel,
  ListenTogetherMember,
  ListenTogetherMemberPreview,
  ListenTogetherMessage,
  ListenTogetherRemotePlayback,
  ListenTogetherRoom,
  ListenTogetherRoomType,
  ListenTogetherSongOrder,
  ListenTogetherTag,
} from '@/models/listenTogether';

export const asListenTogetherRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return '';
};

const readNumber = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
};

const readOptionalNumber = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
};

const readBoolean = (record: Record<string, unknown>, fallback: boolean, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (value === 0 || value === '0') return false;
    if (value === 1 || value === '1') return true;
  }
  return fallback;
};

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  if (!normalized || (!normalized.startsWith('{') && !normalized.startsWith('['))) return value;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return value;
  }
};

const unwrapData = (payload: unknown): unknown => {
  let value = parseJsonValue(payload);
  for (let depth = 0; depth < 5; depth += 1) {
    const record = asListenTogetherRecord(value);
    if (!record || !('data' in record)) return value;
    value = parseJsonValue(record.data);
  }
  return value;
};

const getDataRecord = (payload: unknown) => asListenTogetherRecord(unwrapData(payload)) ?? {};

const getDataList = (payload: unknown): unknown[] => {
  const data = unwrapData(payload);
  if (Array.isArray(data)) return data;
  const record = asListenTogetherRecord(data);
  if (!record) return [];
  for (const key of [
    'list',
    'songs',
    'audios',
    'items',
    'members',
    'member_list',
    'user_list',
    'audio_list',
    'music_list',
  ]) {
    const parsed = parseJsonValue(record[key]);
    if (Array.isArray(parsed)) return parsed;
  }
  for (const key of ['info', 'room_info', 'member_info']) {
    if (!(key in record)) continue;
    const nested = getDataList(record[key]);
    if (nested.length) return nested;
  }
  return [];
};

const mapTag = (value: unknown): ListenTogetherTag | null => {
  const record = asListenTogetherRecord(value);
  if (!record) return null;
  const id = readString(record, 'tag_id', 'music_style_id', 'fm_id', 'id');
  const name = readString(record, 'tag_name', 'music_style_name', 'name');
  if (!id && !name) return null;
  return { id, name };
};

const mapTagList = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(mapTag)
    .filter((item): item is ListenTogetherTag => Boolean(item));

const STUDY_MUSIC_STYLE_NAMES: Record<string, string> = {
  '5': '杂食',
  '10': '轻音乐',
  '29': '治愈',
  '32': '安静',
  '37': '元气',
};

const mapDelimitedTags = (
  value: unknown,
  names: Record<string, string> = {},
): ListenTogetherTag[] => {
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: names[id] || id }));
};

const mapAudioRef = (value: unknown): ListenTogetherAudioRef | null => {
  const record = asListenTogetherRecord(value);
  if (!record) return null;
  const hash = readString(record, 'hash', 'file_hash', 'audio_hash');
  if (!hash) return null;
  return {
    hash,
    mixSongId: readString(
      record,
      'mixsongid',
      'mixSongId',
      'mix_song_id',
      'album_audio_id',
      'audio_id',
    ),
  };
};

const mapMemberPreview = (value: unknown): ListenTogetherMemberPreview | null => {
  const source = asListenTogetherRecord(value);
  const record = {
    ...(source ?? {}),
    ...(asListenTogetherRecord(source?.user_info) ?? {}),
    ...(asListenTogetherRecord(source?.member_info) ?? {}),
  };
  const userId = readString(record, 'userid', 'user_id', 'uid', 'id');
  if (!userId) return null;
  return {
    userId,
    nickname:
      readString(record, 'nick_name', 'nickname', 'username', 'user_name', 'name') || '房间成员',
    avatarUrl: normalizeCoverUrl(
      readString(record, 'user_pic', 'avatar', 'headimg', 'head_img', 'img', 'pic'),
      120,
    ),
    studyStatus: readNumber(record, 'study_status'),
  };
};

const mapAvatarOnlyPreview = (
  value: unknown,
  index: number,
): ListenTogetherMemberPreview | null => {
  const avatarUrl = normalizeCoverUrl(
    typeof value === 'string'
      ? value
      : readString(asListenTogetherRecord(value) ?? {}, 'url', 'avatar', 'user_pic', 'pic'),
    120,
  );
  if (!avatarUrl) return null;
  return {
    userId: `avatar:${index}:${avatarUrl}`,
    nickname: '在线听众',
    avatarUrl,
    studyStatus: 1,
    anonymous: true,
  };
};

const mergeMemberPreviews = (
  ...groups: ReadonlyArray<ReadonlyArray<ListenTogetherMemberPreview>>
) => {
  const result: ListenTogetherMemberPreview[] = [];
  for (const member of groups.flat()) {
    const sameUser = result.some(
      (item) => !item.anonymous && !member.anonymous && item.userId === member.userId,
    );
    const sameAvatar =
      member.avatarUrl && result.some((item) => item.avatarUrl === member.avatarUrl);
    if (!sameUser && !sameAvatar) result.push(member);
  }
  return result;
};

export const mapListenTogetherRoom = (
  value: unknown,
  base?: ListenTogetherRoom | null,
  forcedRoomType?: ListenTogetherRoomType,
): ListenTogetherRoom => {
  const source = asListenTogetherRecord(value) ?? {};
  const extraRoomRecord = asListenTogetherRecord(parseJsonValue(source.extra_room_info)) ?? {};
  const ownerRecord = {
    ...(asListenTogetherRecord(source.user_info) ?? {}),
    ...(asListenTogetherRecord(source.owner_info) ?? {}),
  };
  const songRecord = {
    ...(asListenTogetherRecord(source.current_audio) ?? {}),
    ...(asListenTogetherRecord(source.audio) ?? {}),
    ...(asListenTogetherRecord(source.song_info) ?? {}),
  };
  const record = {
    ...extraRoomRecord,
    ...(asListenTogetherRecord(source.room_info) ?? {}),
    ...(asListenTogetherRecord(source.base_info) ?? {}),
    ...source,
  };
  const switchRecord = asListenTogetherRecord(parseJsonValue(record.switch)) ?? {};
  const chatSwitch = readOptionalNumber(switchRecord, 'chat');
  const rawMemberPreviews = [
    record.member_list,
    record.members,
    record.user_list,
    record.online_user_list,
  ].flatMap((items) => (Array.isArray(items) ? items : []));
  const structuredMemberPreviews = rawMemberPreviews
    .map(mapMemberPreview)
    .filter((item): item is ListenTogetherMemberPreview => Boolean(item));
  // 概念版众乐房列表/详情的 cover_urls 只公开在线听众头像，不包含 userid。
  // 它不是麦位成员接口的数据，但仍应作为可见成员预览保留下来。
  const avatarOnlyPreviews = (Array.isArray(record.cover_urls) ? record.cover_urls : [])
    .map(mapAvatarOnlyPreview)
    .filter((item): item is ListenTogetherMemberPreview => Boolean(item));
  const memberPreviews = mergeMemberPreviews(
    structuredMemberPreviews,
    avatarOnlyPreviews,
    base?.memberPreviews ?? [],
  );
  const rawAudios = Array.isArray(record.audios) ? record.audios : [];
  const currentAudio = mapAudioRef({ ...record, ...songRecord });
  const audios = [...rawAudios, ...(currentAudio ? [currentAudio] : [])]
    .map(mapAudioRef)
    .filter((item): item is ListenTogetherAudioRef => Boolean(item));
  const ownerId =
    readString(ownerRecord, 'userid', 'owner_id', 'uid') ||
    readString(record, 'userid', 'owner_id', 'uid') ||
    base?.ownerId ||
    '';
  const ownerName =
    readString(ownerRecord, 'nick_name', 'nickname', 'owner_name') ||
    readString(record, 'nick_name', 'nickname', 'owner_name') ||
    base?.ownerName ||
    '房主';
  const authors = (Array.isArray(songRecord.authors) ? songRecord.authors : [])
    .map((author) => {
      const authorRecord = asListenTogetherRecord(author);
      return authorRecord ? readString(authorRecord, 'author_name', 'name') : '';
    })
    .filter(Boolean)
    .join('、');
  const directTag = mapTag(record);
  const tags = mapTagList(record.tag_list);
  if (directTag && !tags.some((tag) => tag.id === directTag.id && tag.name === directTag.name)) {
    tags.push(directTag);
  }
  const sourceRoomType = readOptionalNumber(record, 'room_type');
  const explicitStudyRoomKind = readString(record, 'study_room_kind');
  const roomType = (forcedRoomType ??
    base?.roomType ??
    sourceRoomType ??
    1) as ListenTogetherRoomType;
  const studyRoomKind =
    roomType === 1
      ? explicitStudyRoomKind === 'official' || explicitStudyRoomKind === 'community'
        ? explicitStudyRoomKind
        : sourceRoomType === 1
          ? 'official'
          : sourceRoomType === 0
            ? 'community'
            : base?.studyRoomKind
      : undefined;
  const memberCount = readOptionalNumber(
    record,
    'member_count',
    'online_count',
    'online_user_count',
    'all_user_count',
    'member_num',
  );
  const memberLimit = readOptionalNumber(record, 'member_limit');
  const studyCount = readOptionalNumber(record, 'study_num');
  const musicType = readOptionalNumber(record, 'music_type');
  const whiteNoiseType = readOptionalNumber(record, 'white_noise_type');
  const hidden = readOptionalNumber(record, 'is_hide');
  const roomStatus = readOptionalNumber(record, 'room_status');
  const explicitClosed =
    hidden !== undefined ? hidden === 1 : roomStatus !== undefined ? roomStatus === 0 : undefined;
  const roomTag = readString(record, 'room_tag');
  const musicStyle = readString(record, 'music_style');
  const musicStyleTags = mapTagList(record.music_style_list);
  const detailMusicStyleTags = mapDelimitedTags(musicStyle, {
    ...STUDY_MUSIC_STYLE_NAMES,
    ...Object.fromEntries((base?.musicStyles ?? []).map((tag) => [tag.id, tag.name])),
  });

  return {
    id: readString(record, 'room_id', 'roomid', 'groupid', 'id') || base?.id || '',
    name:
      readString(record, 'room_name', 'room_theme', 'name') ||
      base?.name ||
      (roomType === 0 ? `${ownerName}的众乐房` : '自习室'),
    ownerId,
    ownerName,
    ownerAvatarUrl:
      readString(ownerRecord, 'user_pic', 'avatar', 'img') ||
      readString(record, 'user_pic', 'avatar', 'img') ||
      base?.ownerAvatarUrl ||
      '',
    roomType,
    studyRoomKind,
    memberCount: memberCount ?? (memberPreviews.length || base?.memberCount || 0),
    memberLimit: memberLimit ?? base?.memberLimit,
    studyCount: studyCount ?? base?.studyCount ?? 0,
    allowChat:
      chatSwitch !== undefined
        ? chatSwitch === 1
        : readBoolean(record, base?.allowChat ?? true, 'allow_chat'),
    channelId: readString(record, 'global_collection_id', 'channel_id') || base?.channelId || '',
    channelName: readString(record, 'channel_name') || base?.channelName || '',
    currentSongName:
      readString(songRecord, 'song_name', 'songname', 'audio_name') ||
      readString(record, 'songname', 'ori_audio_name', 'audio_name') ||
      base?.currentSongName ||
      '',
    currentArtistName:
      authors ||
      readString(songRecord, 'author_name', 'singer_name', 'singername') ||
      readString(record, 'author_name', 'singer_name', 'singername') ||
      base?.currentArtistName ||
      '',
    notice: readString(record, 'room_notice', 'notice') || base?.notice || '',
    musicType: musicType ?? base?.musicType,
    whiteNoiseType: whiteNoiseType ?? base?.whiteNoiseType,
    roomTag: roomTag || base?.roomTag,
    musicStyle: musicStyle || base?.musicStyle,
    closed: explicitClosed ?? base?.closed ?? false,
    closeReason:
      readString(record, 'show_msg', 'close_reason', 'closeReason') || base?.closeReason || '',
    tags: tags.length ? tags : (base?.tags ?? []),
    musicStyles: musicStyleTags.length
      ? musicStyleTags
      : detailMusicStyleTags.length
        ? detailMusicStyleTags
        : (base?.musicStyles ?? []),
    memberPreviews,
    audios: audios.length ? audios : (base?.audios ?? []),
  };
};

export const mapListenTogetherRoomList = (payload: unknown, roomType: ListenTogetherRoomType) =>
  getDataList(payload)
    .map((item) => mapListenTogetherRoom(item, null, roomType))
    .filter((room) => room.id && !room.closed);

export const getListenTogetherRoomPageInfo = (payload: unknown) => {
  const data = getDataRecord(payload);
  return {
    total: readNumber(data, 'total'),
    ended: readBoolean(data, false, 'is_end'),
    notice: readString(data, 'notice_content'),
  };
};

export const mapListenTogetherMemberList = (
  payload: unknown,
  memberType?: 1 | 2,
): ListenTogetherMember[] =>
  getDataList(payload)
    .map((value): ListenTogetherMember | null => {
      const preview = mapMemberPreview(value);
      const record = asListenTogetherRecord(value);
      if (!preview || !record) return null;
      return {
        ...preview,
        studyTime: readNumber(record, 'study_time'),
        ...(memberType ? { memberType } : {}),
      };
    })
    .filter((item): item is ListenTogetherMember => Boolean(item));

const getSystemMessageText = (message: Record<string, unknown>, type: number) => {
  const nickname =
    readString(message, 'nickname', 'nick_name', 'username', 'user_name', 'name') || '房间成员';
  const flag = readString(message, 'flag_name');
  const target = readString(message, 'flag_nickname');
  const alert = readString(message, 'alert', 'content', 'text', 'title', 'prompt');
  const action = readNumber(message, 'action', 'event');
  const songName = readString(message, 'songname', 'song_name');

  // 上游对部分系统事件已经给出可展示文案，优先保留 APP 原文。
  if (alert) return alert;

  switch (type) {
    case 2001:
      return `${nickname} 开始了学习`;
    case 2002:
      return `${nickname} 结束了学习`;
    case 2003:
      return target
        ? `${nickname} 向 ${target} 的 Flag「${flag || '专注学习'}」递了奶茶`
        : `${nickname} 为「${flag || '专注学习'}」递了奶茶`;
    case 2004:
      return `${nickname} 进入了房间`;
    case 2005:
      return `${nickname} 离开了房间`;
    case 2006:
      return `${nickname} 暂停了学习`;
    case 2007:
      return `${nickname} 恢复了学习`;
    case 2008:
      return '房间信息已更新';
    case 2009:
      return '房间歌单已更新';
    case 2010:
      return `${nickname} 立下了 Flag「${flag || '专注学习'}」`;
    case 810:
      return action === 2 ? `${nickname} 离开了房间` : `${nickname} 进入了房间`;
    case 820:
      return '房主已结束一起听';
    case 821: {
      const roomSwitch = asListenTogetherRecord(parseJsonValue(message.switch));
      const chat = roomSwitch ? readOptionalNumber(roomSwitch, 'chat') : undefined;
      if (chat === 1) return '已开启聊天';
      if (chat === 2) return '已关闭聊天';
      return '房间信息已更新';
    }
    case 830:
      return `${nickname} 更新了房间成员设置`;
    case 3001:
      return '房主开始了一起听';
    case 3002:
      return '房主结束了一起听';
    case 3003:
      return '房间歌单已更新';
    case 3004:
      return songName ? `已切换至《${songName}》` : '房主切换了歌曲';
    case 3005:
      return '房间播放状态已更新';
    case 4001:
      return `${nickname}已加入一起听`;
    case 4002:
      return `${nickname} 离开了房间`;
    case 4003:
      return `${nickname} 为房间打了 call`;
    case 4004:
      return songName ? `${nickname} 收藏了《${songName}》` : `${nickname} 收藏了歌曲`;
    case 4005:
      return `${nickname} 关注了房主`;
    case 5100:
      return songName ? `${nickname} 点播了《${songName}》` : `${nickname} 发起了点歌请求`;
    default:
      return flag ? `${nickname}：${flag}` : `${nickname} 更新了房间状态`;
  }
};

export const mapListenTogetherMessageList = (payload: unknown): ListenTogetherMessage[] =>
  getDataList(payload)
    .map((value) => {
      const record = asListenTogetherRecord(parseJsonValue(value));
      if (!record) return null;
      const message =
        asListenTogetherRecord(parseJsonValue(record.message ?? record.msg ?? record.content)) ??
        record;
      const type =
        readNumber(message, 'msgtype', 'msg_type', 'type') || readNumber(record, 'msgtype');
      const userId = readString(message, 'userid', 'uid') || readString(record, 'uid', 'userid');
      const nickname =
        readString(message, 'nickname', 'nick_name', 'username', 'user_name', 'name') || '房间成员';
      const text =
        type === 801
          ? readString(message, 'alert', 'message', 'content', 'text', 'msg')
          : getSystemMessageText(message, type);
      if (!text) return null;
      const rawTimestamp = readNumber(record, 'addtime', 'timestamp', 'time');
      const sentAt =
        rawTimestamp > 0 && rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
      return {
        id: readString(record, 'msgid', 'id') || `${userId}:${sentAt}:${text}`,
        userId,
        nickname,
        avatarUrl: readString(message, 'img', 'avatar', 'avatar_url', 'user_pic', 'pic'),
        type,
        text,
        sentAt,
        online: readBoolean(record, false, 'is_online'),
        system: type !== 801,
      };
    })
    .filter((item): item is ListenTogetherMessage => Boolean(item))
    .sort((left, right) => left.sentAt - right.sentAt);

const stripMarkup = (value: string) => value.replace(/<[^>]*>/g, '').trim();

export const mapListenTogetherChannelList = (payload: unknown): ListenTogetherChannel[] =>
  getDataList(payload)
    .map((value) => {
      const record = asListenTogetherRecord(value);
      if (!record) return null;
      const id = readString(record, 'global_collection_id', 'channel_id', 'id');
      if (!id) return null;
      return {
        id,
        name: stripMarkup(readString(record, 'name', 'channel_name')) || '音乐频道',
        coverUrl: readString(record, 'channel_cover', 'pic', 'channel_avatar'),
        songCount: readNumber(record, 'song_count'),
        subscriberCount: readNumber(record, 'subscribe_count'),
        tags: mapTagList(record.tags),
      };
    })
    .filter((item): item is ListenTogetherChannel => Boolean(item));

const findSongArray = (value: unknown, depth = 0): unknown[] => {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    if (
      value.some((item) => {
        const record = asListenTogetherRecord(item);
        return Boolean(record && readString(record, 'hash', 'file_hash', 'audio_hash'));
      })
    ) {
      return value;
    }
    for (const item of value) {
      const nested = findSongArray(item, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }
  const record = asListenTogetherRecord(value);
  if (!record) return [];
  for (const key of [
    'list',
    'songs',
    'audios',
    'playlist',
    'song_info',
    'songs_info',
    'audio_list',
    'music_list',
    'data',
    'info',
  ]) {
    if (!(key in record)) continue;
    const nested = findSongArray(record[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
};

const mergeNestedSongRecord = (value: unknown): Record<string, unknown> => {
  const record = asListenTogetherRecord(parseJsonValue(value)) ?? {};
  const albumInfo = asListenTogetherRecord(parseJsonValue(record.album_info)) ?? {};
  const audio = asListenTogetherRecord(parseJsonValue(record.audio)) ?? {};
  const audioInfo = asListenTogetherRecord(parseJsonValue(record.audio_info)) ?? {};
  const songInfo = asListenTogetherRecord(parseJsonValue(record.song_info)) ?? {};
  const base = asListenTogetherRecord(parseJsonValue(record.base)) ?? {};
  const transParam = asListenTogetherRecord(parseJsonValue(record.trans_param)) ?? {};
  return {
    // 嵌套对象只作为顶层字段缺失时的补充，避免 album_info.name 覆盖歌曲名。
    ...albumInfo,
    ...audio,
    ...audioInfo,
    ...songInfo,
    ...base,
    ...record,
    album_info: albumInfo,
    audio,
    audio_info: audioInfo,
    song_info: songInfo,
    base,
    trans_param: transParam,
  };
};

export const mapListenTogetherSong = (value: unknown): Song | null => {
  const record = mergeNestedSongRecord(value);
  const metadata = mapTopSong(record);
  const serviceHash = readString(record, 'hash', 'file_hash', 'audio_hash');
  const upstreamOriginalHash = readString(record, 'original_hash', 'genting_hash');
  const preservedAlternateHash = readString(record, 'originalHash');
  // genting_hash 是房间游标/同步键，hash 才是播放器、封面和歌词使用的标准版权键。
  const hash = serviceHash || upstreamOriginalHash;
  if (!hash) return null;
  const serviceMixSongId = readString(
    record,
    'mixsongid',
    'mixSongId',
    'mix_song_id',
    'album_audio_id',
    'albumAudioId',
    'audio_id',
  );
  const upstreamOriginalMixSongId = readString(
    record,
    'original_album_audio_id',
    'genting_album_audio_id',
  );
  const preservedAlternateMixSongId = readString(record, 'originalAlbumAudioId');
  const mixSongId = serviceMixSongId || upstreamOriginalMixSongId;
  let duration = readNumber(record, 'duration', 'timelength', 'time_length');
  if (duration > 10_000) duration /= 1000;
  const explicitTitle = readString(
    record,
    'songname',
    'song_name',
    'title',
    'ori_audio_name',
    'audio_name',
  );
  const rawTitle = explicitTitle || readString(record, 'filename', 'name');
  const authors = (Array.isArray(record.authors) ? record.authors : [])
    .map((author) => {
      const authorRecord = asListenTogetherRecord(author);
      return authorRecord ? readString(authorRecord, 'author_name', 'name') : '';
    })
    .filter(Boolean)
    .join('、');
  const explicitArtist =
    authors ||
    readString(record, 'author_name', 'singername', 'singer_name', 'artist', 'author') ||
    (metadata.artist && metadata.artist !== '未知歌手' ? metadata.artist : '');
  const usableExplicitArtist =
    explicitArtist === '一起听' || explicitArtist === '未知歌手' ? '' : explicitArtist;
  const filenameParts = rawTitle.split(' - ');
  const filenameArtist = filenameParts.length > 1 ? filenameParts[0].trim() : '';
  const filenameTitle = filenameParts.length > 1 ? filenameParts.slice(1).join(' - ').trim() : '';
  const normalizedExplicitArtist = usableExplicitArtist.replaceAll(' ', '').toLowerCase();
  const normalizedFilenameArtist = filenameArtist.replaceAll(' ', '').toLowerCase();
  const shouldSplitFilename = Boolean(
    filenameArtist &&
    filenameTitle &&
    (!explicitTitle ||
      !usableExplicitArtist ||
      normalizedExplicitArtist === normalizedFilenameArtist ||
      normalizedExplicitArtist.includes(normalizedFilenameArtist)),
  );
  const resolvedTitle =
    (shouldSplitFilename ? filenameTitle : rawTitle) ||
    (metadata.name && metadata.name !== '未知歌曲' ? metadata.name : '') ||
    (metadata.title && metadata.title !== '未知歌曲' ? metadata.title : '');
  const resolvedArtist = usableExplicitArtist || (shouldSplitFilename ? filenameArtist : '');
  const coverUrl = normalizeCoverUrl(
    readString(
      record,
      'img',
      'cover',
      'cover_url',
      'coverUrl',
      'album_img',
      'album_sizable_cover',
      'sizable_cover',
      'cover_pic',
      'union_cover',
    ) ||
      metadata.coverUrl ||
      metadata.cover,
    400,
  );
  return {
    // /audio 返回的标准元数据包含歌手、专辑、音质等播放器所需字段。
    ...metadata,
    id: hash,
    songId: readString(record, 'songid', 'songId', 'song_id') || metadata.songId,
    title: resolvedTitle,
    name: resolvedTitle || metadata.name,
    artist: resolvedArtist,
    albumName: readString(record, 'album_name', 'albumName', 'album') || metadata.albumName,
    album: readString(record, 'album_name', 'albumName', 'album') || metadata.album,
    albumId: readString(record, 'album_id', 'albumId') || metadata.albumId,
    duration: duration || metadata.duration,
    coverUrl,
    cover: coverUrl || metadata.cover,
    audioUrl: readString(record, 'play_url', 'playurl', 'audioUrl', 'url') || metadata.audioUrl,
    hash,
    // 房间接口可能用 genting_hash 返回当前歌曲或要求它作为翻页游标，单独保留。
    originalHash:
      upstreamOriginalHash && upstreamOriginalHash !== hash
        ? upstreamOriginalHash
        : preservedAlternateHash,
    mixSongId,
    albumAudioId: mixSongId,
    originalAlbumAudioId:
      upstreamOriginalMixSongId && upstreamOriginalMixSongId !== mixSongId
        ? upstreamOriginalMixSongId
        : preservedAlternateMixSongId,
    listenTogetherCanPlay: readOptionalNumber(record, 'canplay'),
    listenTogetherGenting: readOptionalNumber(record, 'genting'),
    source: 'listen-together',
  };
};

export const mapListenTogetherSongList = (
  payload: unknown,
  fallback: ListenTogetherAudioRef[] = [],
) => {
  const rawList = findSongArray(unwrapData(payload));
  const fallbackByHash = new Map<string, Record<string, unknown>>();
  const fallbackByMixId = new Map<string, Record<string, unknown>>();
  const fallbackRecords = fallback.map((item) => mergeNestedSongRecord(item));
  fallbackRecords.forEach((record) => {
    const hashes = [
      readString(record, 'hash', 'file_hash', 'audio_hash'),
      readString(record, 'original_hash', 'genting_hash', 'originalHash'),
    ];
    hashes.forEach((hash) => {
      const normalized = hash.toLowerCase();
      if (normalized) fallbackByHash.set(normalized, record);
    });
    [
      readString(record, 'mixsongid', 'mixSongId', 'mix_song_id'),
      readString(record, 'album_audio_id', 'albumAudioId'),
      readString(record, 'original_album_audio_id', 'originalAlbumAudioId'),
    ].forEach((mixId) => {
      if (mixId && mixId !== '0') fallbackByMixId.set(mixId, record);
    });
  });
  const source = rawList.length
    ? rawList.map((item, index) => {
        const remote = mergeNestedSongRecord(item);
        const hashes = [
          readString(remote, 'original_hash', 'genting_hash', 'originalHash'),
          readString(remote, 'hash', 'file_hash', 'audio_hash'),
        ];
        const mixIds = [
          readString(remote, 'mixsongid', 'mixSongId', 'mix_song_id'),
          readString(remote, 'album_audio_id', 'albumAudioId'),
          readString(remote, 'original_album_audio_id', 'originalAlbumAudioId'),
        ];
        const fallbackRecord =
          hashes.map((hash) => fallbackByHash.get(hash.toLowerCase())).find(Boolean) ??
          mixIds.map((mixId) => fallbackByMixId.get(mixId)).find(Boolean) ??
          (rawList.length === fallbackRecords.length ? fallbackRecords[index] : undefined);
        const remoteDefinesOriginalIdentity = Boolean(
          readString(remote, 'original_hash', 'genting_hash'),
        );
        if (!fallbackRecord || remoteDefinesOriginalIdentity) {
          return { ...(fallbackRecord ?? {}), ...remote };
        }

        const remoteHash = readString(remote, 'hash', 'file_hash', 'audio_hash');
        const fallbackHash = readString(fallbackRecord, 'hash', 'file_hash', 'audio_hash');
        const fallbackOriginalHash = readString(
          fallbackRecord,
          'originalHash',
          'original_hash',
          'genting_hash',
        );
        const fallbackAlreadyResolved =
          Boolean(fallbackOriginalHash) &&
          fallbackOriginalHash.toLowerCase() === remoteHash.toLowerCase() &&
          fallbackHash.toLowerCase() !== remoteHash.toLowerCase();

        // /audio 会把房间里的 OGG hash 转成标准版权 hash，二者值不相等但响应顺序一致。
        // 再次拉房间歌单时不能反过来用 OGG hash 覆盖已经解析出的标准 hash。
        return {
          ...fallbackRecord,
          ...remote,
          hash: fallbackAlreadyResolved ? fallbackHash : remoteHash,
          originalHash:
            fallbackOriginalHash ||
            (fallbackHash.toLowerCase() !== remoteHash.toLowerCase() ? fallbackHash : ''),
          mixSongId: readString(
            fallbackRecord,
            'mixSongId',
            'mixsongid',
            'mix_song_id',
            'albumAudioId',
            'album_audio_id',
          ),
          albumAudioId: readString(
            fallbackRecord,
            'albumAudioId',
            'album_audio_id',
            'mixSongId',
            'mixsongid',
          ),
          originalAlbumAudioId: readString(
            fallbackRecord,
            'originalAlbumAudioId',
            'original_album_audio_id',
            'genting_album_audio_id',
          ),
        };
      })
    : fallback;
  const songs = source
    .map((item) => mapListenTogetherSong(item))
    .filter((item): item is Song => Boolean(item));
  return Array.from(new Map(songs.map((song) => [song.hash.toLowerCase(), song])).values());
};

export const mapListenTogetherSongOrders = (payload: unknown): ListenTogetherSongOrder[] =>
  getDataList(payload)
    .map((value) => {
      const record = asListenTogetherRecord(value);
      const songRecord = asListenTogetherRecord(record?.song_info);
      const userRecord = asListenTogetherRecord(record?.user_info) ?? {};
      if (!record || !songRecord) return null;
      const song = mapListenTogetherSong(songRecord);
      if (!song) return null;
      const requesterId = readString(userRecord, 'userid', 'user_id', 'uid');
      return {
        id: `${requesterId}:${song.hash.toLowerCase()}`,
        song,
        requesterId,
        requesterName: readString(userRecord, 'nick_name', 'nickname', 'name') || '房间成员',
        requesterAvatarUrl: readString(userRecord, 'user_pic', 'avatar', 'img', 'pic'),
      };
    })
    .filter((item): item is ListenTogetherSongOrder => Boolean(item));

const findPlaybackRecord = (value: unknown, depth = 0): Record<string, unknown> | null => {
  if (depth > 5) return null;
  const record = asListenTogetherRecord(value);
  if (!record) return null;
  const merged = mergeNestedSongRecord(record);
  const hasTrack = Boolean(readString(merged, 'hash', 'file_hash', 'audio_hash', 'cur_song'));
  const hasPosition = [
    'progress',
    'play_progress',
    'current_time',
    'current_position',
    'position',
    'play_pos',
    'play_time',
    'pos',
    'offset',
  ].some((key) => key in merged);
  if (hasTrack || hasPosition) return merged;
  for (const key of [
    'data',
    'player',
    'play_info',
    'progress_info',
    'current_audio',
    'audio',
    'song',
    'info',
  ]) {
    if (!(key in record)) continue;
    const nested = findPlaybackRecord(record[key], depth + 1);
    if (nested) return { ...record, ...nested };
  }
  return null;
};

export const mapListenTogetherRemotePlayback = (
  payload: unknown,
): ListenTogetherRemotePlayback | null => {
  const record = findPlaybackRecord(unwrapData(payload));
  if (!record) return null;
  const hash = readString(record, 'hash', 'file_hash', 'audio_hash', 'cur_song');
  if (!hash) return null;
  let position = readNumber(
    record,
    'progress',
    'play_progress',
    'current_time',
    'current_position',
    'position',
    'play_pos',
    'play_time',
    'pos',
    'offset',
  );
  if (position > 10_000) position /= 1000;
  const state = readString(record, 'play_status', 'playstate', 'state', 'status').toLowerCase();
  const paused = state === 'pause' || state === 'paused' || state === '0';
  const pauseCode = readOptionalNumber(record, 'pause');
  const receivedAt = Date.now();
  const rawSnapshotTimestamp = readNumber(
    record,
    'timestamp',
    'server_timestamp',
    'server_time',
    'update_time',
  );
  const normalizedSnapshotTimestamp =
    rawSnapshotTimestamp > 0 && rawSnapshotTimestamp < 10_000_000_000
      ? rawSnapshotTimestamp * 1000
      : rawSnapshotTimestamp;
  // 上游时间戳是房间进度快照的基准时间。只接受与本机相差不超过一分钟的值，
  // 防止某些接口把歌曲发布时间等同名字段误识别成播放时钟。
  const snapshotAt =
    normalizedSnapshotTimestamp > 0 && Math.abs(receivedAt - normalizedSnapshotTimestamp) <= 60_000
      ? normalizedSnapshotTimestamp
      : receivedAt;
  return {
    hash,
    mixSongId: readString(record, 'mixsongid', 'mix_song_id', 'album_audio_id', 'audio_id'),
    position: Math.max(0, position),
    playing:
      pauseCode !== undefined
        ? pauseCode === 1
        : !paused && readBoolean(record, true, 'is_playing', 'isplay', 'playing'),
    updatedAt: snapshotAt,
  };
};

export const extractListenTogetherRoomId = (payload: unknown, depth = 0): string => {
  if (depth > 6) return '';
  if (typeof payload === 'string' || typeof payload === 'number') {
    const candidate = String(payload).trim();
    return /^\d{6,}$/.test(candidate) ? candidate : '';
  }
  const record = asListenTogetherRecord(payload);
  if (!record) return '';
  const direct = readString(record, 'groupid', 'group_id', 'room_id', 'roomid');
  if (direct) return direct;
  for (const value of Object.values(record)) {
    const nested = extractListenTogetherRoomId(value, depth + 1);
    if (nested) return nested;
  }
  return '';
};

export const toListenTogetherAudioRefs = (songs: Song[], limit = 30) =>
  songs
    .filter((song) => Boolean(String(song.hash ?? '').trim()))
    .slice(0, limit)
    .map((song) => ({
      hash: String(song.hash).trim(),
      mixSongId: song.mixSongId ?? song.albumAudioId ?? '',
    }));
