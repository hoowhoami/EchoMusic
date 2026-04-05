import type { PlaylistMeta } from '@/models/playlist';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { RankMeta } from '@/models/rank';
import type { Comment } from '@/models/comment';
import type { Song } from '@/models/song';
import {
  EMPTY_RECORD,
  formatPic,
  getArray,
  getRecord,
  isRecord,
  parseIntSafe,
  parseOptionalInt,
  pickValue,
  readString,
  resolvePlaylistOriginalId,
  toRecord,
} from './shared';
import { mapPlaylistSong } from './song';
import { splitValidSongs } from '../song';

export interface PlaylistTrackQueryContext {
  listid?: number;
  listCreateGid?: string;
  listCreateUserid?: number;
  currentUserId?: number;
}

export const resolvePlaylistTrackQueryId = (
  fallbackId: string | number,
  context: PlaylistTrackQueryContext = {},
): string => {
  const { listid, listCreateGid } = context;

  if (listCreateGid) {
    return String(listCreateGid);
  }

  if (listid !== undefined && listid !== null && String(listid) !== '') {
    return String(listid);
  }

  return String(fallbackId);
};


export const mapPlaylistMeta = (json: unknown): PlaylistMeta => {
  const record = toRecord(json);
  const extra = getRecord(record, 'extra') ?? EMPTY_RECORD;
  const isUserPlaylist =
    Object.prototype.hasOwnProperty.call(record, 'list_create_userid') &&
    (Object.prototype.hasOwnProperty.call(record, 'listid') ||
      Object.prototype.hasOwnProperty.call(record, 'specialid'));

  if (isUserPlaylist) {
    const typeValue = parseOptionalInt(record.type);
    const isDefault = record.is_def === 1 || record.is_default === 1 || record.is_def === 2;
    const baseMeta: PlaylistMeta = {
      id: parseIntSafe(pickValue(record.listid, record.specialid, 0)),
      listid: parseIntSafe(record.listid),
      globalCollectionId: readString(
        pickValue(record.global_collection_id, record.gid, record.specialid, ''),
      ),
      listCreateGid: readString(record.list_create_gid, ''),
      listCreateUserid: parseOptionalInt(record.list_create_userid),
      listCreateListid: parseOptionalInt(record.list_create_listid),
      musiclibId: parseOptionalInt(record.musiclib_id),
      ipId: parseOptionalInt(pickValue(record.ip_id, extra.ip_id, record.id)),
      name: readString(pickValue(record.name, record.specialname, '')),
      pic: formatPic(pickValue(record.pic, record.imgurl, record.cover, record.img, '')),
      intro: readString(pickValue(record.intro, record.description, record.desc, ''), ''),
      nickname: readString(
        pickValue(record.nickname, record.username, record.list_create_username, ''),
      ),
      userPic: formatPic(
        pickValue(record.user_pic, record.avatar, record.create_user_pic, record.pic, ''),
      ),
      tags: readString(record.tags, ''),
      playCount: parseIntSafe(
        pickValue(record.play_count, record.playcount, record.count, record.play_total, 0),
      ),
      count: parseIntSafe(pickValue(record.song_count, record.songcount, record.count, 0)),
      isPrivate: record.is_pri === 1 || record.is_private === 1,
      heat: parseOptionalInt(
        pickValue(record.collectcount, record.collect_count, record.collect_total),
      ),
      publishDate: readString(pickValue(record.publishtime, record.publish_time, '')).split(' ')[0],
      createTime: parseOptionalInt(pickValue(record.create_time, record.addtime)),
      updateTime: parseOptionalInt(record.update_time),
      source: parseIntSafe(pickValue(record.source, 1)),
      type: typeValue,
      isDefault,
      songs: undefined,
    };
    return {
      ...baseMeta,
      specialid: baseMeta.listid ?? baseMeta.id,
      specialname: baseMeta.name,
      imgurl: baseMeta.pic || undefined,
      playcount: baseMeta.playCount,
      songcount: baseMeta.count,
      collectcount: baseMeta.heat,
      publishtime: baseMeta.publishDate,
      create_user_pic: baseMeta.userPic || undefined,
      list_create_username: baseMeta.nickname || undefined,
      originalId: resolvePlaylistOriginalId(baseMeta),
    };
  }

  const typeValue = parseOptionalInt(record.type);
  const isDefault = record.is_def === 1 || record.is_default === 1 || record.is_def === 2;
  const baseMeta: PlaylistMeta = {
    id: parseIntSafe(
      pickValue(record.specialid, record.listid, record.global_collection_id, extra.specialid, 0),
    ),
    listid: parseOptionalInt(pickValue(record.listid, record.specialid, extra.specialid)),
    globalCollectionId: readString(
      pickValue(record.global_collection_id, record.gid, record.specialid, extra.global_collection_id, ''),
    ),
    listCreateGid: readString(
      pickValue(
        record.list_create_gid,
        record.global_collection_id,
        record.gid,
        record.specialid,
        extra.global_collection_id,
        extra.global_special_id,
        extra.specialid,
        '',
      ),
    ),
    listCreateUserid: parseOptionalInt(
      pickValue(record.list_create_userid, extra.list_create_userid, record.userid, record.suid),
    ),
    listCreateListid: parseOptionalInt(
      pickValue(record.list_create_listid, extra.specialid, record.specialid),
    ),
    musiclibId: parseOptionalInt(pickValue(record.musiclib_id, extra.musiclib_id)),
    ipId: parseOptionalInt(pickValue(record.ip_id, extra.ip_id, record.id)),
    name: readString(pickValue(record.specialname, record.name, record.title, '')),
    pic: formatPic(
      pickValue(record.flexible_cover, record.pic, record.imgurl, record.img, record.image_url, ''),
    ),
    intro: readString(
      pickValue(record.intro, record.description, record.desc, record.sub_title, ''),
      '',
    ),
    nickname: readString(
      pickValue(record.nickname, record.username, record.author, record.list_create_username, extra.list_create_username, ''),
    ),
    userPic: formatPic(
      pickValue(record.user_pic, record.avatar, record.create_user_pic, record.author_pic, ''),
    ),
    tags: readString(record.tags, ''),
    playCount: parseIntSafe(
      pickValue(record.playcount, record.play_count, record.count, record.play_total, extra.play_count, 0),
    ),
    count: parseIntSafe(
      pickValue(record.song_count, record.songcount, record.count, extra.song_count, 0),
    ),
    isPrivate: false,
    heat: parseOptionalInt(
      pickValue(record.collectcount, record.collect_count, record.collect_total),
    ),
    publishDate: readString(pickValue(record.publishtime, record.publish_time, '')).split(' ')[0],
    createTime: parseOptionalInt(pickValue(record.create_time, record.addtime)),
    updateTime: parseOptionalInt(record.update_time),
    source: parseIntSafe(pickValue(record.source, 1)),
    type: typeValue,
    isDefault,
    songs: undefined,
  };
  return {
    ...baseMeta,
    specialid: baseMeta.listid ?? baseMeta.id,
    specialname: baseMeta.name,
    imgurl: baseMeta.pic || undefined,
    playcount: baseMeta.playCount,
    songcount: baseMeta.count,
    collectcount: baseMeta.heat,
    publishtime: baseMeta.publishDate,
    create_user_pic: baseMeta.userPic || undefined,
    list_create_username: baseMeta.nickname || undefined,
    originalId: resolvePlaylistOriginalId(baseMeta),
  };
};

export const mapAlbumMeta = (json: unknown): AlbumMeta => {
  const record = toRecord(json);
  return {
    id: parseIntSafe(pickValue(record.AlbumId, record.albumid, record.album_id, record.id, 0)),
    albumid: parseIntSafe(pickValue(record.AlbumId, record.albumid, record.album_id, record.id, 0)),
    album_id: parseIntSafe(pickValue(record.AlbumId, record.albumid, record.album_id, record.id, 0)),
    name: readString(
      pickValue(record.AlbumName, record.albumname, record.album_name, record.name, ''),
    ),
    albumname: readString(
      pickValue(record.AlbumName, record.albumname, record.album_name, record.name, ''),
    ) || undefined,
    album_name: readString(
      pickValue(record.AlbumName, record.albumname, record.album_name, record.name, ''),
    ) || undefined,
    pic: formatPic(
      pickValue(
        record.img,
        record.Image,
        record.imgurl,
        record.sizable_cover,
        record.pic,
        record.cover,
        '',
      ),
    ),
    intro: readString(pickValue(record.intro, record.album_intro, '')),
    singerName: readString(
      pickValue(
        record.SingerName,
        record.singername,
        record.singer_name,
        record.author_name,
        record.singer,
        '',
      ),
    ),
    singerId: parseIntSafe(
      pickValue(
        record.SingerId,
        record.SingerID,
        record.singerid,
        record.author_id,
        record.singer_id,
        0,
      ),
    ),
    publishTime: readString(
      pickValue(
        record.PublishTime,
        record.publishtime,
        record.publish_time,
        record.publish_date,
        '',
      ),
    ).split(' ')[0],
    songCount: parseIntSafe(
      pickValue(
        record.SongCount,
        record.song_count,
        record.count,
        record.songcount,
        record.total_count,
        0,
      ),
    ),
    playCount: parseIntSafe(pickValue(record.play_count, record.play_times, record.playcount, 0)),
    heat: parseIntSafe(pickValue(record.heat, record.collect_count, record.collectcount, 0)),
    language: readString(record.language, ''),
    type: readString(record.type, ''),
    company: readString(record.company, ''),
    imgurl: formatPic(
      pickValue(
        record.img,
        record.Image,
        record.imgurl,
        record.sizable_cover,
        record.pic,
        record.cover,
        '',
      ),
    ) || undefined,
    sizable_cover: formatPic(
      pickValue(record.sizable_cover, record.imgurl, record.img, record.pic, record.cover, ''),
    ) || undefined,
    singername: readString(
      pickValue(record.SingerName, record.singername, record.singer_name, record.author_name, record.singer, ''),
    ) || undefined,
    singerid: parseIntSafe(
      pickValue(record.SingerId, record.SingerID, record.singerid, record.author_id, record.singer_id, 0),
    ),
    publishtime: readString(
      pickValue(record.PublishTime, record.publishtime, record.publish_time, record.publish_date, ''),
    ).split(' ')[0] || undefined,
    songcount: parseIntSafe(
      pickValue(record.SongCount, record.song_count, record.count, record.songcount, record.total_count, 0),
    ),
    playcount: parseIntSafe(pickValue(record.play_count, record.play_times, record.playcount, 0)),
    collectcount: parseIntSafe(pickValue(record.heat, record.collect_count, record.collectcount, 0)),
  };
};

export const mapAlbumDetailMeta = (json: unknown): AlbumMeta => {
  const record = toRecord(json);
  const extra = getRecord(record, 'extra') ?? EMPTY_RECORD;
  return {
    id: parseIntSafe(pickValue(record.album_id, record.albumid, record.id, extra.album_id, 0)),
    albumid: parseIntSafe(pickValue(record.album_id, record.albumid, record.id, extra.album_id, 0)),
    album_id: parseIntSafe(pickValue(record.album_id, record.albumid, record.id, extra.album_id, 0)),
    name: readString(pickValue(record.album_name, record.albumname, record.name, extra.album_name, '')),
    albumname: readString(pickValue(record.album_name, record.albumname, record.name, extra.album_name, '')) || undefined,
    album_name: readString(pickValue(record.album_name, record.albumname, record.name, extra.album_name, '')) || undefined,
    pic: formatPic(
      pickValue(
        record.sizable_cover,
        record.imgurl,
        record.img,
        record.pic,
        record.cover,
        extra.sizable_cover,
        extra.cover,
        '',
      ),
    ),
    intro: readString(pickValue(record.intro, record.album_intro, extra.intro, '')),
    singerName: readString(
      pickValue(
        record.author_name,
        record.singername,
        record.singer,
        extra.singer_name,
        extra.author_name,
        getArray(record.authors)?.[0] && isRecord(getArray(record.authors)?.[0]) ? (getArray(record.authors)?.[0] as Record<string, unknown>).author_name : undefined,
        '',
      ),
    ),
    singerId: parseIntSafe(
      pickValue(
        record.author_id,
        record.singerid,
        record.singer_id,
        record.AuthorId,
        extra.author_id,
        extra.singer_id,
        extra.singerid,
        getArray(record.authors)?.[0] && isRecord(getArray(record.authors)?.[0]) ? (getArray(record.authors)?.[0] as Record<string, unknown>).author_id : undefined,
        0,
      ),
    ),
    publishTime: readString(
      pickValue(record.publish_date, record.publishtime, record.publish_time, extra.publish_time, ''),
    ).split(' ')[0],
    songCount: parseIntSafe(pickValue(record.song_count, record.songcount, record.count, record.total_count, extra.song_count, extra.count, 0)),
    playCount: parseIntSafe(
      pickValue(record.play_count, record.play_times, record.playcount, extra.play_count, 0),
    ),
    heat: parseIntSafe(pickValue(record.heat, record.collect_count, record.collectcount, 0)),
    language: readString(record.language, ''),
    type: readString(record.type, ''),
    company: readString(record.company, ''),
    imgurl: formatPic(
      pickValue(record.sizable_cover, record.imgurl, record.img, record.pic, record.cover, extra.sizable_cover, extra.cover, ''),
    ) || undefined,
    sizable_cover: formatPic(
      pickValue(record.sizable_cover, record.imgurl, record.img, record.pic, record.cover, extra.sizable_cover, extra.cover, ''),
    ) || undefined,
    singername: readString(
      pickValue(
        record.author_name,
        record.singername,
        record.singer,
        extra.singer_name,
        extra.author_name,
        getArray(record.authors)?.[0] && isRecord(getArray(record.authors)?.[0]) ? (getArray(record.authors)?.[0] as Record<string, unknown>).author_name : undefined,
        '',
      ),
    ) || undefined,
    singerid: parseIntSafe(
      pickValue(
        record.author_id,
        record.singerid,
        record.singer_id,
        record.AuthorId,
        extra.author_id,
        extra.singer_id,
        extra.singerid,
        getArray(record.authors)?.[0] && isRecord(getArray(record.authors)?.[0]) ? (getArray(record.authors)?.[0] as Record<string, unknown>).author_id : undefined,
        0,
      ),
    ),
    publishtime: readString(
      pickValue(record.publish_date, record.publishtime, record.publish_time, extra.publish_time, ''),
    ).split(' ')[0] || undefined,
    songcount: parseIntSafe(pickValue(record.song_count, record.songcount, record.count, record.total_count, extra.song_count, extra.count, 0)),
    playcount: parseIntSafe(pickValue(record.play_count, record.play_times, record.playcount, extra.play_count, 0)),
    collectcount: parseIntSafe(pickValue(record.heat, record.collect_count, record.collectcount, 0)),
  };
};

export const mapArtistMeta = (json: unknown): ArtistMeta => {
  const record = toRecord(json);
  const id = parseIntSafe(
    pickValue(record.AuthorId, record.singerid, record.id, record.author_id, record.singer_id, 0),
  );
  const name = readString(
    pickValue(record.AuthorName, record.singername, record.author_name, record.name, record.singer_name, ''),
  );
  const pic = formatPic(
    pickValue(
      record.Avatar,
      record.imgurl,
      record.avatar,
      record.pic,
      record.image,
      record.singer_img,
      record.sizable_avatar,
      '',
    ),
  );
  const songCount = parseIntSafe(
    pickValue(record.AudioCount, record.song_count, record.songcount, record.audio_count, record.song_num, 0),
  );
  const albumCount = parseIntSafe(
    pickValue(record.AlbumCount, record.album_count, record.albumcount, record.album_num, 0),
  );
  const mvCount = parseIntSafe(
    pickValue(record.VideoCount, record.mv_count, record.mvcount, record.mv_num, 0),
  );
  const fansCount = parseIntSafe(
    pickValue(record.FansNum, record.fansnums, record.fans_count, record.fans, record.fans_num, record.fanscount, 0),
  );

  return {
    id,
    singerid: id,
    author_id: id,
    name,
    author_name: name || undefined,
    singername: name || undefined,
    pic,
    imgurl: pic || undefined,
    avatar: pic || undefined,
    intro: readString(
      pickValue(record.intro, record.long_intro, record.profile, record.singer_intro, ''),
    ),
    songCount,
    songcount: songCount,
    albumCount,
    albumcount: albumCount,
    mvCount,
    mvcount: mvCount,
    fansCount,
    fanscount: fansCount,
  };
};

export const mapArtistDetailMeta = (json: unknown): ArtistMeta => {
  const record = toRecord(json);
  let introStr = '';
  if (Array.isArray(record.long_intro)) {
    introStr = record.long_intro
      .map((entry) => readString(isRecord(entry) ? entry.content : '', ''))
      .join('\n\n');
  } else {
    introStr = readString(pickValue(record.long_intro, record.intro, record.profile, ''), '');
  }

  const id = parseIntSafe(
    pickValue(record.AuthorId, record.author_id, record.singerid, record.singer_id, record.id, 0),
  );
  const name = readString(
    pickValue(record.AuthorName, record.author_name, record.singername, record.name, ''),
  );
  const pic = formatPic(
    pickValue(record.sizable_avatar, record.Avatar, record.imgurl, record.pic, record.avatar, record.image, ''),
  );
  const songCount = parseIntSafe(
    pickValue(record.AudioCount, record.song_count, record.songcount, record.audio_count, record.song_num, 0),
  );
  const albumCount = parseIntSafe(
    pickValue(record.AlbumCount, record.album_count, record.albumcount, record.album_num, 0),
  );
  const mvCount = parseIntSafe(
    pickValue(record.VideoCount, record.mv_count, record.mvcount, record.mv_num, 0),
  );
  const fansCount = parseIntSafe(
    pickValue(record.FansNum, record.fansnums, record.fanscount, record.fans_count, record.fans_num, 0),
  );
  const isFollowed =
    pickValue(record.is_followed, record.is_follow, record.followed, record.follow, 0) === 1 ||
    pickValue(record.is_followed, record.is_follow, record.followed, record.follow, false) === true;

  return {
    id,
    singerid: id,
    author_id: id,
    name,
    author_name: name || undefined,
    singername: name || undefined,
    pic,
    imgurl: pic || undefined,
    avatar: pic || undefined,
    intro: introStr,
    songCount,
    songcount: songCount,
    albumCount,
    albumcount: albumCount,
    mvCount,
    mvcount: mvCount,
    fansCount,
    fanscount: fansCount,
    isFollowed,
  };
};

export const mapRankMeta = (json: unknown): RankMeta => {
  const record = toRecord(json);
  const typeInfo = getRecord(record, 'type_info') ?? EMPTY_RECORD;
  const id = parseIntSafe(pickValue(record.rankid, record.id, 0));
  const name = readString(pickValue(record.rankname, record.name, record.title, ''), '');
  const pic = formatPic(pickValue(record.imgurl, record.pic, record.cover, record.image, ''));
  const rankTypeId = parseOptionalInt(pickValue(record.ranktype, record.rank_type, record.type));
  const type = readString(pickValue(record.type, record.rank_type, ''), '');
  const group = readString(
    pickValue(record.group, record.rank_type_name, record.type_name, typeInfo.name, typeInfo.title, ''),
    '',
  );
  const rankTypeName = readString(
    pickValue(record.rank_type_name, record.type_name, group, typeInfo.name, typeInfo.title, ''),
    '',
  );
  const updateFrequency = readString(
    pickValue(record.updatefrequency, record.updateFrequency, record.update, ''),
    '',
  );

  return {
    id,
    rankid: id,
    name,
    rankname: name,
    pic,
    imgurl: pic || undefined,
    rankType: rankTypeId,
    type: type || undefined,
    group: group || undefined,
    rankTypeName: rankTypeName || undefined,
    typeName: rankTypeName || undefined,
    updateFrequency: updateFrequency || undefined,
    updatefrequency: updateFrequency || undefined,
  };
};

export const mapCommentItem = (item: unknown): Comment => {
  const record = toRecord(item);
  const likeRecord = getRecord(record, 'like');
  const userRecord = getRecord(record, 'user');
  const id = readString(pickValue(record.comment_id, record.id, ''), '');
  const userName = readString(
    pickValue(record.user_name, record.nickname, userRecord?.name, userRecord?.nickname, '匿名用户'),
    '匿名用户',
  );
  const avatar = readString(
    pickValue(record.user_pic, record.user_img, record.avatar, userRecord?.avatar, userRecord?.pic, ''),
    '',
  );
  const addTime = readString(pickValue(record.addtime, record.add_time, record.time, ''), '');
  const likeCount = parseIntSafe(
    pickValue(
      likeRecord?.count,
      record.like_count,
      record.likeCount,
      record.like_num,
      record.reply_like_count,
      record.count,
      0,
    ),
  );
  const replyCount = parseIntSafe(pickValue(record.reply_num, record.reply_count, record.replyCount, 0));
  const specialId = readString(
    pickValue(
      record.special_child_id,
      record.special_id,
      record.specialId,
      record.specialid,
      record.childrenid,
      '',
    ),
    '',
  );
  const tid = readString(pickValue(record.tid, record.id, record.comment_id, record.commentId, ''), '');
  const code = readString(record.code, '');
  const mixSongId = readString(
    pickValue(record.mixsongid, record.audio_id, record.album_audio_id, record.mixSongId, ''),
    '',
  );
  const isHot =
    pickValue(record.isHot, record.is_hot, record.hot, 0) === true ||
    parseIntSafe(pickValue(record.isHot, record.is_hot, record.hot, 0)) === 1;
  const isStar =
    pickValue(record.isStar, record.is_star, record.star, 0) === true ||
    parseIntSafe(pickValue(record.isStar, record.is_star, record.star, 0)) === 1;

  return {
    id,
    comment_id: id || undefined,
    userName,
    user_name: userName || undefined,
    userPic: avatar || undefined,
    user_pic: avatar || undefined,
    avatar,
    content: readString(record.content ?? ''),
    time: addTime,
    addTime: addTime || undefined,
    addtime: addTime || undefined,
    likeCount,
    like_count: likeCount,
    like: { count: likeCount },
    replyCount,
    replyNum: replyCount,
    reply_num: replyCount,
    isHot,
    isStar,
    raw: record,
    specialId: specialId || undefined,
    special_id: specialId || undefined,
    specialChildId: specialId || undefined,
    special_child_id: specialId || undefined,
    tid: tid || undefined,
    code: code || undefined,
    mixSongId: mixSongId || undefined,
    mixsongid: mixSongId || undefined,
    audio_id: readString(pickValue(record.audio_id, ''), '') || undefined,
    album_audio_id: readString(pickValue(record.album_audio_id, ''), '') || undefined,
  };
};


export interface PlaylistParseResult {
  songs: Song[];
  filteredCount: number;
}

export const parsePlaylistTracks = (payload: unknown): PlaylistParseResult => {
  const record = toRecord(payload);
  const candidates = [
    record.data,
    record.info,
    record.list,
    record.lists,
    record.songs,
    record.songlist,
    record.items,
    payload,
  ];

  let trackList: unknown[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      trackList = candidate;
      break;
    }
    if (isRecord(candidate)) {
      const nested =
        getArray(candidate.data) ??
        getArray(candidate.info) ??
        getArray(candidate.list) ??
        getArray(candidate.lists) ??
        getArray(candidate.songs) ??
        getArray(candidate.songlist) ??
        getArray(candidate.items);
      if (nested) {
        trackList = nested;
        break;
      }
    }
  }

  const mappedSongs = trackList.map((item) => mapPlaylistSong(item));
  return splitValidSongs(mappedSongs);
};
