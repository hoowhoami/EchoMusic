import type { Song, SongRelateGood } from '@/models/song';
import {
  EMPTY_RECORD,
  buildArtists,
  buildRelateGoods,
  formatPic,
  getArray,
  getCoverUrl,
  getRecord,
  isRecord,
  normalizeText,
  parseIntSafe,
  parseOptionalInt,
  pickValue,
  processSongTitle,
  readString,
  toRecord,
} from './shared';
import type { UnknownRecord } from './shared';

const cleanupAudioExtension = (value: string): string => {
  const extensions = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ape'];
  let output = value;
  for (const ext of extensions) {
    if (output.toLowerCase().endsWith(ext)) {
      output = output.slice(0, -ext.length);
    }
  }
  return output;
};

export const mapTopSong = (json: unknown): Song => {
  const record = toRecord(json);
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;

  let singerName = readString(pickValue(record.author_name, record.singername, record.singer), '');
  let title = processSongTitle(
    readString(pickValue(record.songname, record.filename, record.name, '未知歌曲')),
  );

  title = cleanupAudioExtension(title);
  singerName = cleanupAudioExtension(singerName);

  const artists = buildArtists(record, EMPTY_RECORD);
  const singers = artists.length > 0 ? artists : singerName ? [{ name: singerName }] : [];
  const relateGoods = buildRelateGoods(record, EMPTY_RECORD);
  const durationFromTimeLength = parseIntSafe(pickValue(record.time_length, 0));
  const durationRaw =
    durationFromTimeLength !== 0
      ? durationFromTimeLength
      : parseIntSafe(pickValue(record.timelength, record.duration, 0));
  const duration = durationFromTimeLength !== 0 ? durationRaw : Math.floor(durationRaw / 1000);
  const albumName = normalizeText(readString(pickValue(record.album_name, record.albumname, '')));
  const cover = formatPic(
    pickValue(record.album_sizable_cover, transParam.union_cover, record.cover, ''),
  );

  return {
    id: readString(
      pickValue(record.mixsongid, record.audio_id, record.album_audio_id, record.hash, ''),
    ),
    title: title || '未知歌曲',
    name: title || '未知歌曲',
    artist: normalizeText(
      singerName || (singers.length > 0 ? singers.map((item) => item.name).join(', ') : '未知歌手'),
    ),
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(pickValue(record.album_id, record.albumid, '')),
    duration,
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(pickValue(record.hash, record.hash_128, record.FileHash, '')),
    mixSongId: parseIntSafe(pickValue(record.mixsongid, record.album_audio_id, record.audio_id, 0)),
    mvHash: readString(pickValue(record.video_hash, record.mvhash, ''), ''),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id),
    ),
    privilege: parseOptionalInt(pickValue(record.privilege, undefined)),
    payType: parseOptionalInt(pickValue(record.pay_type, undefined)),
    oldCpy: parseOptionalInt(pickValue(record.old_cpy, record.media_old_cpy, undefined)),
    relateGoods,
  };
};

export const mapPlaylistSong = (json: unknown): Song => {
  const record = toRecord(json);
  const audioInfo = getRecord(record, 'audio_info') ?? EMPTY_RECORD;

  const hash = readString(pickValue(record.hash, audioInfo.hash_128, audioInfo.hash));
  const rawName = readString(
    pickValue(
      record.songname,
      record.filename,
      record.name,
      record.audio_name,
      audioInfo.songname,
      audioInfo.filename,
      audioInfo.name,
      '',
    ),
  );

  let singerName = readString(
    pickValue(
      record.author_name,
      record.singername,
      record.singer,
      audioInfo.author_name,
      audioInfo.singername,
      '',
    ),
  );

  if (!singerName && rawName.includes(' - ')) {
    singerName = rawName.split(' - ')[0];
  }

  let title = processSongTitle(rawName);
  title = cleanupAudioExtension(title);
  singerName = cleanupAudioExtension(singerName);

  const albumInfo =
    getRecord(record, 'albuminfo') ?? getRecord(record, 'album_info') ?? EMPTY_RECORD;
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;
  const cover = formatPic(
    pickValue(
      record.cover,
      record.pic,
      record.img,
      record.album_sizable_cover,
      audioInfo.img,
      transParam.union_cover,
      albumInfo.cover,
      albumInfo.sizable_cover,
      '',
    ),
  );

  const durationRaw = parseIntSafe(
    pickValue(record.timelen, audioInfo.duration_128, audioInfo.duration, 0),
  );

  const relateGoods = buildRelateGoods(record, audioInfo);
  const artists = buildArtists(record, audioInfo);
  const singers = artists.length > 0 ? artists : singerName ? [{ name: singerName }] : [];

  const privilegeDownload =
    getRecord(record, 'privilege_download') ??
    getRecord(record, 'privilegeDownload') ??
    EMPTY_RECORD;

  const privilege = parseOptionalInt(
    pickValue(record.privilege, audioInfo.privilege, privilegeDownload.privilege, undefined),
  );

  let payType: number | undefined;
  const downloadList = getArray(record.download);
  const firstDownload = downloadList?.[0];
  if (isRecord(firstDownload)) {
    payType = parseOptionalInt(firstDownload.pay_type ?? firstDownload.PayType);
  }
  if (payType === undefined) {
    payType = parseOptionalInt(pickValue(record.pay_type, record.PayType, record.payType));
  }

  const oldCpy = parseOptionalInt(
    pickValue(record.media_old_cpy, record.old_cpy, record.mediaOldCpy),
  );
  const albumName = normalizeText(
    readString(
      pickValue(record.albumname, record.album_name, albumInfo.name, albumInfo.album_name, ''),
    ),
  );
  const source = readString(pickValue(record.source, ''), '') || undefined;

  return {
    id: readString(pickValue(record.mixsongid, record.audio_id, audioInfo.audio_id, hash)),
    title: title || '未知歌曲',
    name: title || '未知歌曲',
    artist: normalizeText(singerName || '未知歌手'),
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(
      pickValue(albumInfo.id, albumInfo.album_id, record.album_id, record.albumid, ''),
    ),
    duration: Math.floor(durationRaw / 1000),
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash,
    mvHash: readString(pickValue(record.video_hash, record.mvhash, ''), ''),
    mixSongId: parseIntSafe(
      pickValue(record.mixsongid, record.album_audio_id, record.audio_id, audioInfo.audio_id, 0),
    ),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id),
    ),
    privilege,
    relateGoods,
    source,
    oldCpy,
    payType,
  };
};

export const mapArtistSong = (artistId: string | number, json: unknown): Song => {
  const record = toRecord(json);
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;
  const audioInfo = getRecord(record, 'audio_info') ?? EMPTY_RECORD;
  const hash = readString(record.hash, '');
  const artists = buildArtists(record, audioInfo);
  const fallbackArtistName = normalizeText(readString(record.author_name, '未知歌手'));
  const singers =
    artists.length > 0
      ? artists
      : [{ id: readString(artistId, '') || undefined, name: fallbackArtistName || '未知歌手' }];
  const privilegeDownload =
    getRecord(record, 'privilege_download') ??
    getRecord(record, 'privilegeDownload') ??
    EMPTY_RECORD;
  const albumName = normalizeText(readString(record.album_name, ''));
  const cover = formatPic(readString(transParam.union_cover, ''));

  return {
    id: readString(pickValue(record.mixsongid, record.album_audio_id, hash)),
    title: readString(record.audio_name, '未知歌曲'),
    name: readString(record.audio_name, '未知歌曲'),
    artist: fallbackArtistName || '未知歌手',
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(pickValue(record.album_id, record.albumid, ''), ''),
    duration: Math.floor(parseIntSafe(pickValue(record.timelength, 0)) / 1000),
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash,
    mixSongId: parseIntSafe(pickValue(record.mixsongid, record.album_audio_id, 0)),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id),
    ),
    privilege: parseOptionalInt(
      pickValue(record.privilege, privilegeDownload.privilege, undefined),
    ),
    relateGoods: buildRelateGoods(record, audioInfo),
    oldCpy: parseOptionalInt(pickValue(record.old_cpy, record.media_old_cpy)),
    payType: parseOptionalInt(pickValue(record.pay_type, record.PayType, record.payType)),
  };
};

export const mapAlbumSong = (json: unknown): Song => {
  const record = toRecord(json);
  const base = getRecord(record, 'base') ?? EMPTY_RECORD;
  const audioInfo = getRecord(record, 'audio_info') ?? EMPTY_RECORD;
  const albumInfo = getRecord(record, 'album_info') ?? EMPTY_RECORD;
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;
  const copyright = getRecord(record, 'copyright') ?? EMPTY_RECORD;
  const deprecated = getRecord(record, 'deprecated') ?? EMPTY_RECORD;
  const artists = buildArtists(record, audioInfo);
  const fallbackArtistName = normalizeText(
    readString(pickValue(base.author_name, base.AuthorName, record.author_name, '未知歌手')),
  );
  const singers =
    artists.length > 0
      ? artists
      : [
          {
            id: readString(pickValue(base.author_id, base.AuthorId), '') || undefined,
            name: fallbackArtistName,
          },
        ];
  const albumName = normalizeText(
    readString(pickValue(albumInfo.album_name, record.album_name, '')),
  );
  const cover = formatPic(
    pickValue(record.pic, record.img, audioInfo.img, albumInfo.cover, transParam.union_cover, ''),
  );

  return {
    id: readString(pickValue(base.audio_id, record.audio_id, audioInfo.audio_id, '')),
    title: processSongTitle(readString(pickValue(base.audio_name, record.songname, '未知歌曲'))),
    name: processSongTitle(readString(pickValue(base.audio_name, record.songname, '未知歌曲'))),
    artist: fallbackArtistName,
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(
      pickValue(
        base.album_id,
        base.albumid,
        record.album_id,
        record.albumid,
        albumInfo.album_id,
        '',
      ),
      '',
    ),
    duration: Math.floor(parseIntSafe(pickValue(audioInfo.duration, record.timelength, 0)) / 1000),
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(pickValue(audioInfo.hash, record.hash, '')),
    mvHash: readString(pickValue(record.video_hash, record.mvhash, ''), ''),
    mixSongId: parseIntSafe(
      pickValue(
        base.mixsongid,
        base.album_audio_id,
        base.audio_id,
        record.mixsongid,
        record.album_audio_id,
        record.audio_id,
        0,
      ),
    ),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id, audioInfo.audio_id),
    ),
    privilege: parseOptionalInt(pickValue(record.privilege, copyright.privilege, undefined)),
    relateGoods: buildRelateGoods(record, audioInfo),
    oldCpy: parseOptionalInt(pickValue(deprecated.old_cpy, record.old_cpy, record.media_old_cpy)),
    payType: parseOptionalInt(
      pickValue(deprecated.pay_type, record.pay_type, record.PayType, record.payType),
    ),
  };
};

export const mapRankSong = (json: unknown): Song => {
  const record = toRecord(json);
  const audioInfo = getRecord(record, 'audio_info') ?? EMPTY_RECORD;
  const albumInfo = getRecord(record, 'album_info') ?? EMPTY_RECORD;
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;
  const deprecated = getRecord(record, 'deprecated') ?? EMPTY_RECORD;
  const privilegeDownload =
    getRecord(record, 'privilege_download') ??
    getRecord(record, 'privilegeDownload') ??
    EMPTY_RECORD;
  const artists = buildArtists(record, audioInfo);
  const fallbackArtistName = normalizeText(
    readString(pickValue(record.author_name, record.singername, record.singer, '未知歌手')),
  );
  const singers = artists.length > 0 ? artists : [{ name: fallbackArtistName || '未知歌手' }];
  const cover = formatPic(
    pickValue(albumInfo.sizable_cover, transParam.union_cover, record.img, record.pic, ''),
  );
  const durationRaw = parseIntSafe(pickValue(audioInfo.duration_128, audioInfo.duration, 0));
  const privilege = parseOptionalInt(pickValue(record.privilege, privilegeDownload.privilege));
  const oldCpy = parseOptionalInt(pickValue(deprecated.old_cpy, record.old_cpy));
  const payType = parseOptionalInt(pickValue(deprecated.pay_type, record.pay_type));
  const albumName = normalizeText(
    readString(pickValue(albumInfo.album_name, record.album_name, '')),
  );
  const relateGoods = buildRelateGoods(record, audioInfo);

  return {
    id: readString(pickValue(record.audio_id, record.mixsongid, audioInfo.audio_id, '')),
    title: processSongTitle(readString(pickValue(record.songname, record.name, '未知歌曲'))),
    name: processSongTitle(readString(pickValue(record.songname, record.name, '未知歌曲'))),
    artist: fallbackArtistName,
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(
      pickValue(record.album_id, record.albumid, albumInfo.id, albumInfo.album_id, ''),
      '',
    ),
    duration: Math.floor(durationRaw / 1000),
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(pickValue(audioInfo.hash_128, audioInfo.hash, record.hash, '')),
    mixSongId: parseIntSafe(
      pickValue(record.mixsongid, record.album_audio_id, record.audio_id, audioInfo.audio_id, 0),
    ),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id, audioInfo.audio_id),
    ),
    privilege,
    relateGoods,
    oldCpy,
    payType,
  };
};

export const mapSearchSong = (json: unknown): Song => {
  const record = toRecord(json);
  const hq = getRecord(record, 'HQ') ?? EMPTY_RECORD;
  const sq = getRecord(record, 'SQ') ?? EMPTY_RECORD;
  const hiRes = getRecord(record, 'Res') ?? EMPTY_RECORD;
  const singersRaw = getArray(record.Singers) ?? [];

  const artists = singersRaw
    .filter((item) => isRecord(item))
    .map((item) => ({
      id: readString(
        pickValue(
          (item as UnknownRecord).id,
          (item as UnknownRecord).AuthorId,
          (item as UnknownRecord).author_id,
          (item as UnknownRecord).singerid,
          (item as UnknownRecord).singer_id,
          '',
        ),
        '',
      ),
      name: readString(
        pickValue(
          (item as UnknownRecord).name,
          (item as UnknownRecord).AuthorName,
          (item as UnknownRecord).author_name,
          (item as UnknownRecord).singername,
          '',
        ),
        '',
      ),
    }))
    .filter((item) => item.name.length > 0);

  const relateGoods: SongRelateGood[] = [];
  if (hq.Hash) relateGoods.push({ hash: readString(hq.Hash, ''), quality: '320' });
  if (sq.Hash) relateGoods.push({ hash: readString(sq.Hash, ''), quality: 'flac' });
  if (hiRes.Hash) relateGoods.push({ hash: readString(hiRes.Hash, ''), quality: 'high' });

  const albumName = normalizeText(readString(pickValue(record.AlbumName, '')));
  const cover = formatPic(readString(pickValue(record.Image, ''), ''));

  return {
    id: readString(pickValue(record.MixSongID, record.Audioid, record.FileHash, '')),
    title: processSongTitle(readString(pickValue(record.SongName, record.FileName, '未知歌曲'))),
    name: processSongTitle(readString(pickValue(record.SongName, record.FileName, '未知歌曲'))),
    artist: normalizeText(
      artists.length > 0
        ? artists.map((item) => item.name).join(', ')
        : readString(pickValue(record.SingerName, '未知歌手')),
    ),
    artists,
    singers: artists,
    album: albumName,
    albumName,
    albumId: readString(pickValue(record.AlbumID, record.AlbumId, record.albumid, '')),
    duration: parseIntSafe(pickValue(record.Duration, 0)),
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(pickValue(record.FileHash, '')),
    mvHash: readString(pickValue(record.video_hash, record.mvhash, record.MVHash, ''), ''),
    mixSongId: parseIntSafe(pickValue(record.MixSongID, 0)),
    fileId: parseOptionalInt(
      pickValue(record.Audioid, record.audio_id, record.fileid, record.file_id),
    ),
    privilege: parseOptionalInt(pickValue(record.AlbumPrivilege, undefined)),
    relateGoods,
    oldCpy: parseOptionalInt(pickValue(record.OldCpy, undefined)),
    payType: parseOptionalInt(pickValue(record.PayType, undefined)),
  };
};

export const mapHistorySong = (json: unknown): Song => {
  const record = toRecord(json);
  const info = getRecord(record, 'info');
  const base = mapPlaylistSong(info ?? record);
  const playedAt = parseIntSafe(
    pickValue(
      record.ot,
      record.play_time,
      record.played_time,
      record.last_play_time,
      record.listen_time,
      record.time,
      0,
    ),
  );
  const playCount = parseIntSafe(
    pickValue(record.pc, record.play_count, record.playcount, record.count, 0),
  );
  const mxid = parseIntSafe(
    pickValue(record.mxid, record.mixsongid, info?.mixsongid, info?.MixSongID, 0),
  );
  const historyIdentity = readString(
    pickValue(record.history_id, record.id, record.play_id, record.pid, record.bp, ''),
    '',
  );

  return {
    ...base,
    id:
      readString(base.id, '') ||
      (mxid > 0 ? String(mxid) : readString(pickValue(record.mxid, ''), '')),
    mixSongId: mxid > 0 ? mxid : base.mixSongId,
    lastPlayedAt: playedAt > 0 ? playedAt : undefined,
    playCount: playCount > 0 ? playCount : undefined,
    historyKey:
      historyIdentity ||
      (playedAt > 0
        ? `${String(mxid || base.mixSongId || base.id)}:${playedAt}`
        : `${String(mxid || base.mixSongId || base.id)}:${base.hash || base.id}`),
  };
};

export const mapCloudSong = (json: unknown): Song => {
  const record = toRecord(json);
  const audioInfo = getRecord(record, 'audio_info') ?? EMPTY_RECORD;
  const albumInfo = getRecord(record, 'album_info') ?? EMPTY_RECORD;
  const transParam = getRecord(record, 'trans_param') ?? EMPTY_RECORD;

  const rawName = readString(
    pickValue(record.songname, record.filename, record.name, audioInfo.songname, '未知歌曲'),
  );
  let singerName = readString(
    pickValue(record.singername, record.author_name, record.singer, audioInfo.author_name, ''),
  );
  if (!singerName && rawName.includes(' - ')) {
    singerName = rawName.split(' - ')[0];
  }

  const title = cleanupAudioExtension(processSongTitle(rawName));
  singerName = cleanupAudioExtension(singerName) || '未知歌手';

  const parsedSingers = buildArtists(record, audioInfo);
  const singers = parsedSingers.length > 0 ? parsedSingers : [{ name: singerName }];
  const albumName = normalizeText(
    readString(pickValue(record.albumname, record.album_name, albumInfo.album_name, '')),
  );
  const cover = formatPic(
    pickValue(record.cover, record.pic, albumInfo.sizable_cover, transParam.union_cover, ''),
  );
  const durationRaw = parseIntSafe(
    pickValue(record.duration, record.timelen, audioInfo.duration, audioInfo.duration_128, 0),
  );
  const duration =
    Object.prototype.hasOwnProperty.call(record, 'timelen') ||
    Object.prototype.hasOwnProperty.call(audioInfo, 'duration_128')
      ? Math.floor(durationRaw / 1000)
      : durationRaw;

  return {
    id: readString(
      pickValue(
        record.hash,
        audioInfo.hash,
        record.audio_id,
        record.mixsongid,
        audioInfo.audio_id,
        '',
      ),
    ),
    title,
    name: title,
    artist: normalizeText(singerName),
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId: readString(
      pickValue(record.albumid, record.album_id, albumInfo.id, albumInfo.album_id, ''),
      '',
    ),
    duration,
    coverUrl: getCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(pickValue(record.hash, audioInfo.hash, audioInfo.hash_128, '')),
    mvHash: readString(pickValue(record.video_hash, record.mvhash, ''), ''),
    mixSongId: parseIntSafe(
      pickValue(record.mixsongid, record.album_audio_id, record.audio_id, audioInfo.audio_id, 0),
    ),
    fileId: parseOptionalInt(
      pickValue(record.fileid, record.file_id, record.Audioid, record.audio_id, audioInfo.audio_id),
    ),
    source: 'cloud',
  };
};
