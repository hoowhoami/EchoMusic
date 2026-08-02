import { search } from '@/api/search';
import { mapSearchSong } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { ExternalTrack } from '../../shared/external';
import logger from '@/utils/logger';

const normalizeForCompare = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[\(（].*?[\)）]/g, '')
    .replace(/[\[【].*?[\]】]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
};

const titleScore = (a: string, b: string): number => {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // 字符 Jaccard 近似
  const setA = new Set(na);
  const setB = new Set(nb);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
};

const artistScore = (extArtist: string, candArtist: string): number => {
  const ext = normalizeForCompare(extArtist);
  const cand = normalizeForCompare(candArtist);
  if (!ext) return 0.5; // 无来源歌手信息时给中性分
  if (!cand) return 0;
  if (ext === cand) return 1;
  // 拆分多歌手：以 / 或 & 等
  const extParts = extArtist
    .split(/[\/、&,]/)
    .map((s) => normalizeForCompare(s))
    .filter(Boolean);
  const candParts = candArtist
    .split(/[\/、&,]/)
    .map((s) => normalizeForCompare(s))
    .filter(Boolean);
  for (const ep of extParts) {
    for (const cp of candParts) {
      if (ep === cp || ep.includes(cp) || cp.includes(ep)) return 0.9;
    }
  }
  return 0;
};

const durationScore = (a?: number, b?: number): number => {
  if (!a || !b) return 0.5;
  const delta = Math.abs(a - b);
  if (delta <= 5) return 1;
  if (delta <= 15) return 0.5;
  return 0;
};

const scoreCandidate = (ext: ExternalTrack, song: Song): number => {
  const t = titleScore(ext.title, song.name ?? song.title ?? '');
  const a = artistScore(ext.artist, song.artist);
  const d = durationScore(ext.duration, song.duration);
  return 0.55 * t + 0.3 * a + 0.15 * d;
};

export const MATCH_HIGH_CONFIDENCE_SCORE = 0.72;
export const MATCH_ACCEPTABLE_SCORE = 0.4;

const normalizeSearchKeyword = (value: string): string => value.replace(/\s+/g, ' ').trim();

const addKeyword = (keywords: string[], value: string) => {
  const keyword = normalizeSearchKeyword(value);
  if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
};

const buildKeywords = (track: ExternalTrack): string[] => {
  const title = normalizeSearchKeyword(track.title);
  const artist = normalizeSearchKeyword(track.artist);
  const keywords: string[] = [];

  addKeyword(keywords, [title, artist].filter(Boolean).join(' '));
  addKeyword(keywords, title);
  addKeyword(keywords, [artist, title].filter(Boolean).join(' '));

  for (const artistPart of artist
    .split(/[\/、&,]/)
    .map(normalizeSearchKeyword)
    .filter(Boolean)) {
    addKeyword(keywords, [title, artistPart].filter(Boolean).join(' '));
    addKeyword(keywords, [artistPart, title].filter(Boolean).join(' '));
  }

  return keywords;
};

export interface SearchMatchResult {
  song: Song;
  score: number;
  /** 产生最佳候选的搜索关键词 */
  keyword: string;
  /** 搜索结果中的歌曲 id（audioid/scid），用于云盘上传关联，缺失时为 undefined */
  audioId?: string | number;
  /** 搜索结果中的专辑音频 id（mixsongid），用于云盘上传关联，缺失时为 undefined */
  albumAudioId?: string | number;
}

const normalizePositiveNumericId = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  return /^0+$/.test(text) ? undefined : text;
};

/** 从搜索结果记录中提取 audio_id（歌曲 id，audioid/scid） */
const extractAudioId = (item: unknown): string | number | undefined => {
  const record = item as {
    Auditoid?: unknown;
    Audioid?: unknown;
    audioid?: unknown;
    audio_id?: unknown;
    fileid?: unknown;
    file_id?: unknown;
    Scid?: unknown;
    scid?: unknown;
    base?: unknown;
    audio_info?: unknown;
  };
  const base = record?.base as
    | {
        audio_id?: unknown;
        Audioid?: unknown;
        audioid?: unknown;
        fileid?: unknown;
        file_id?: unknown;
      }
    | undefined;
  const audioInfo = record?.audio_info as
    | {
        audio_id?: unknown;
        Audioid?: unknown;
        audioid?: unknown;
        fileid?: unknown;
        file_id?: unknown;
      }
    | undefined;
  return normalizePositiveNumericId(
    record?.Audioid ??
      record?.audioid ??
      record?.audio_id ??
      record?.fileid ??
      record?.file_id ??
      record?.Scid ??
      record?.scid ??
      record?.Auditoid ??
      base?.audio_id ??
      base?.Audioid ??
      base?.audioid ??
      base?.fileid ??
      base?.file_id ??
      audioInfo?.audio_id ??
      audioInfo?.Audioid ??
      audioInfo?.audioid ??
      audioInfo?.fileid ??
      audioInfo?.file_id,
  );
};

/** 从搜索结果记录中提取 album_audio_id（mixsongid） */
const extractAlbumAudioId = (item: unknown): string | number | undefined => {
  const record = item as {
    album_audio_id?: unknown;
    mixsongid?: unknown;
    MixSongID?: unknown;
    base?: unknown;
    audio_info?: unknown;
  };
  const base = record?.base as
    | { album_audio_id?: unknown; mixsongid?: unknown; MixSongID?: unknown }
    | undefined;
  const audioInfo = record?.audio_info as
    | { album_audio_id?: unknown; mixsongid?: unknown; MixSongID?: unknown }
    | undefined;
  return normalizePositiveNumericId(
    record?.album_audio_id ??
      record?.mixsongid ??
      record?.MixSongID ??
      base?.album_audio_id ??
      base?.mixsongid ??
      base?.MixSongID ??
      audioInfo?.album_audio_id ??
      audioInfo?.mixsongid ??
      audioInfo?.MixSongID,
  );
};

export const findBestMatch = async (track: ExternalTrack): Promise<SearchMatchResult | null> => {
  const keywords = buildKeywords(track);
  if (keywords.length === 0) return null;
  let best: SearchMatchResult | null = null;
  for (const keyword of keywords) {
    let lists: unknown[] = [];
    try {
      const res = await search(keyword, 'song', 1, 5);
      const data = (res as { data?: { lists?: unknown; list?: unknown } })?.data ?? {};
      const raw = data.lists ?? data.list;
      lists = Array.isArray(raw) ? raw : [];
    } catch (e) {
      logger.warn('SongMatching', `search failed: ${keyword}`, e);
      continue;
    }

    for (const item of lists) {
      const song = mapSearchSong(item);
      if (!song.hash) continue;
      const score = scoreCandidate(track, song);
      if (!best || score > best.score) {
        best = {
          song,
          score,
          keyword,
          audioId: extractAudioId(item),
          albumAudioId: extractAlbumAudioId(item),
        };
        if (score >= MATCH_HIGH_CONFIDENCE_SCORE) return best;
      }
    }
  }
  return best;
};

const MATCH_THINK_BASE_MS = 250;
const MATCH_THINK_JITTER_MS = 250;

/** 搜索匹配请求间隔（毫秒），导入歌单、云盘上传等场景复用 */
export const matchThinkDelay = (): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, MATCH_THINK_BASE_MS + Math.random() * MATCH_THINK_JITTER_MS),
  );
