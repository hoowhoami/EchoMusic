import type { SongRelateGood, SongArtist } from '@/models/song';
import { getCoverUrl } from '../cover';

export { getCoverUrl };

export type UnknownRecord = Record<string, unknown>;

export const EMPTY_RECORD: UnknownRecord = {};

export const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const toRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : EMPTY_RECORD);

export const getRecord = (record: UnknownRecord, key: string): UnknownRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

export const getArray = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

export const parseIntSafe = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const numericPart = String(value).match(/^\d+/)?.[0];
  if (numericPart) return Number.parseInt(numericPart, 10) || 0;
  return Number.parseInt(String(value), 10) || 0;
};

export const resolvePlaylistOriginalId = (meta: {
  id: number;
  listCreateListid?: number;
  globalCollectionId?: string;
}): number => {
  if (meta.listCreateListid && meta.listCreateListid !== 0) return meta.listCreateListid;
  if (meta.id !== 0) return meta.id;
  if (meta.globalCollectionId) return Number.parseInt(meta.globalCollectionId, 10) || 0;
  return 0;
};

export const parseOptionalInt = (value: unknown): number | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const readString = (value: unknown, fallback = ''): string => {
  if (value == null) return fallback;
  return String(value);
};

export const pickValue = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    return value;
  }
  return undefined;
};

const toRelateGood = (item: unknown): SongRelateGood | null => {
  if (!isRecord(item)) return null;
  const hash = readString(pickValue(item.hash, item.Hash, item.file_hash, item.fileHash), '');
  const quality = readString(pickValue(item.quality, item.Quality, item.q), '');
  const level = parseOptionalInt(
    pickValue(item.level, item.quality_level, item.qualityLevel, item.quality),
  );

  const good: SongRelateGood = {};
  if (hash) good.hash = hash;
  if (quality) good.quality = quality;
  if (level !== undefined) good.level = level;

  if (!good.hash && !good.quality && good.level === undefined) return null;
  return good;
};

export const buildArtists = (record: UnknownRecord, audioInfo: UnknownRecord): SongArtist[] => {
  const artists: SongArtist[] = [];
  const singerInfo = getArray(pickValue(record.singerinfo, audioInfo.singerinfo, record.authors));

  if (singerInfo) {
    for (const raw of singerInfo) {
      if (!isRecord(raw)) continue;
      const name = readString(
        pickValue(raw.name, raw.AuthorName, raw.author_name, raw.singername, raw.singer),
        '',
      ).trim();
      if (!name) continue;
      const id = pickValue(raw.id, raw.AuthorId, raw.author_id, raw.singerid, raw.singer_id);
      artists.push({
        id: id !== undefined && id !== null ? readString(id) : undefined,
        name,
      });
    }
  }

  if (artists.length === 0) {
    const fallbackName = readString(
      pickValue(
        record.AuthorName,
        record.author_name,
        record.singername,
        record.singer,
        audioInfo.AuthorName,
        audioInfo.author_name,
        audioInfo.singername,
      ),
      '',
    ).trim();

    const fallbackId = pickValue(
      record.AuthorId,
      record.author_id,
      record.singerid,
      record.singer_id,
      audioInfo.AuthorId,
      audioInfo.author_id,
      audioInfo.singerid,
      audioInfo.singer_id,
    );

    if (fallbackName) {
      artists.push({
        id: fallbackId !== undefined && fallbackId !== null ? readString(fallbackId) : undefined,
        name: fallbackName,
      });
    }
  }

  return artists;
};

export const buildRelateGoods = (
  record: UnknownRecord,
  audioInfo: UnknownRecord,
): SongRelateGood[] => {
  const goods: SongRelateGood[] = [];
  const rawGoods = getArray(
    pickValue(
      record.relate_goods,
      record.relateGoods,
      audioInfo.relate_goods,
      audioInfo.relateGoods,
    ),
  );

  if (rawGoods) {
    for (const item of rawGoods) {
      const good = toRelateGood(item);
      if (good) goods.push(good);
    }
  }

  const pushQualityHash = (hashValue: unknown, quality: string) => {
    const hash = readString(hashValue, '');
    if (hash) goods.push({ hash, quality });
  };

  pushQualityHash(pickValue(record.hash_320, audioInfo.hash_320), '320');
  pushQualityHash(pickValue(record.hash_flac, audioInfo.hash_flac), 'flac');
  pushQualityHash(pickValue(record.hash_high, audioInfo.hash_high), 'high');

  const hq = getRecord(record, 'HQ');
  const sq = getRecord(record, 'SQ');
  const res = getRecord(record, 'Res');
  if (hq) pushQualityHash(pickValue(hq.Hash, hq.hash), '320');
  if (sq) pushQualityHash(pickValue(sq.Hash, sq.hash), 'flac');
  if (res) pushQualityHash(pickValue(res.Hash, res.hash), 'high');

  return goods;
};

export const formatPic = (value: unknown): string => {
  if (!value) return '';
  let pic = String(value).replaceAll('{size}', '400');
  if (pic.startsWith('//')) {
    pic = `https:${pic}`;
  }
  return pic;
};

export const normalizeText = (raw: string): string => {
  return raw.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
};

export const processSongTitle = (rawName: string): string => {
  if (rawName.includes(' - ')) {
    const parts = rawName.split(' - ');
    if (parts.length > 1) return parts.slice(1).join(' - ');
  }
  return rawName;
};
