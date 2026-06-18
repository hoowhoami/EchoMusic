import type { Song, SongArtist, SongRelateGood } from '@/models/song';
import {
  EMPTY_RECORD,
  formatPic,
  getArray,
  isRecord,
  normalizeCoverUrl,
  normalizeText,
  parseIntSafe,
  parseOptionalInt,
  pickValue,
  processSongTitle,
  readString,
  toRecord,
} from './shared';

/** 听歌识曲单条匹配结果 */
export interface RecognizeMatch {
  /** 映射后的可播放歌曲 */
  song: Song;
  /** 匹配置信度（0~1，越大越准；由上游 dist 距离换算而来） */
  confidence: number;
}

/** 从匹配项构建关联音质列表 */
const buildRecognizeRelateGoods = (record: Record<string, unknown>): SongRelateGood[] => {
  const relateGoods: SongRelateGood[] = [];
  const hash320 = readString(pickValue(record.hash_320, ''), '');
  const hashFlac = readString(pickValue(record.hash_flac, ''), '');
  const hashHigh = readString(pickValue(record.hash_high, ''), '');
  if (hash320) relateGoods.push({ hash: hash320, quality: '320' });
  if (hashFlac) relateGoods.push({ hash: hashFlac, quality: 'flac' });
  if (hashHigh) relateGoods.push({ hash: hashHigh, quality: 'high' });
  return relateGoods;
};

/** 解析歌手列表（优先使用 authors 数组，回退到 singername 拆分） */
const buildRecognizeArtists = (
  record: Record<string, unknown>,
  singerName: string,
): SongArtist[] => {
  const authors = (getArray(record.authors) ?? []).filter((item) => isRecord(item)) as Record<
    string,
    unknown
  >[];
  if (authors.length > 0) {
    const artists = authors
      .map((author) => ({
        id: readString(pickValue(author.author_id, author.singerid, ''), ''),
        name: readString(pickValue(author.author_name, author.singername, ''), ''),
      }))
      .filter((artist) => artist.name.length > 0);
    if (artists.length > 0) return artists;
  }
  return singerName
    .split(/[、,&/]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ id: '', name }));
};

/**
 * 将听歌识曲（/audio/match）返回的单条结果映射为可播放的 Song
 * 字段命名与酷狗指纹接口保持一致，并对常见别名做兜底取值
 */
export const mapRecognizeSong = (json: unknown): Song => {
  const record = toRecord(json);
  const albumRecord = (getArray(record.album)?.find((item) => isRecord(item)) ??
    EMPTY_RECORD) as Record<string, unknown>;

  const suffix = readString(pickValue(record.songNameSuffix, record.song_name_suffix, ''), '');
  const baseTitle = processSongTitle(
    readString(pickValue(record.songname, record.filename, record.name, '未知歌曲')),
  );
  const title = suffix ? `${baseTitle} (${suffix})` : baseTitle;

  const singerName = normalizeText(
    readString(pickValue(record.singername, record.author_name, record.singer, '未知歌手')),
  );
  const singers = buildRecognizeArtists(record, singerName);

  const albumName = normalizeText(
    readString(pickValue(albumRecord.albumname, record.album_name, record.albumname, '')),
  );
  const albumId = readString(
    pickValue(albumRecord.albumid, albumRecord.album_id, record.album_id, record.albumid, ''),
  );

  const cover = formatPic(
    pickValue(
      record.union_cover,
      albumRecord.sizable_cover,
      record.album_sizable_cover,
      record.cover,
      '',
    ),
  );

  const timeLengthMs = parseIntSafe(
    pickValue(record.timelength, record.timelength_128, record.timelength_320, record.duration, 0),
  );
  const duration = timeLengthMs > 1000 ? Math.floor(timeLengthMs / 1000) : timeLengthMs;

  return {
    id: readString(
      pickValue(
        record.album_audio_id,
        record.mixsongid,
        record.audio_id,
        record.songid,
        record.hash,
        '',
      ),
    ),
    songId: readString(pickValue(record.songid, record.song_id, record.audio_id, '')),
    title,
    name: title,
    artist: singerName,
    artists: singers,
    singers,
    album: albumName,
    albumName,
    albumId,
    duration,
    coverUrl: normalizeCoverUrl(cover, 400),
    cover,
    audioUrl: '',
    hash: readString(
      pickValue(
        record.hash,
        record.hash_128,
        record.FileHash,
        record.hash_320,
        record.hash_flac,
        '',
      ),
    ),
    mixSongId: parseIntSafe(pickValue(record.album_audio_id, record.mixsongid, record.audio_id, 0)),
    fileId: parseOptionalInt(pickValue(record.audio_id, record.fileid, record.file_id)),
    privilege: parseOptionalInt(pickValue(record.privilege, undefined)),
    payType: parseOptionalInt(pickValue(record.pay_type, undefined)),
    relateGoods: buildRecognizeRelateGoods(record),
  };
};

/**
 * 将 /audio/match 的 data 列表映射为带置信度的匹配结果
 * 上游 dist 为「距离」（越小越匹配），换算为置信度 confidence = 1 - dist，并按置信度降序排序
 */
export const mapRecognizeMatches = (list: unknown): RecognizeMatch[] => {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => isRecord(item))
    .map((item) => {
      const record = item as Record<string, unknown>;
      const distRaw = parseFloat(readString(pickValue(record.dist, 0), '0'));
      const dist = Number.isFinite(distRaw) ? Math.min(Math.max(distRaw, 0), 1) : 1;
      return { song: mapRecognizeSong(record), confidence: 1 - dist };
    })
    .sort((a, b) => b.confidence - a.confidence);
};
