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

const titleExtraRatio = (a: string, b: string): number => {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb || na === nb) return 0;
  if (!na.includes(nb) && !nb.includes(na)) return 0;
  return Math.abs(na.length - nb.length) / Math.max(1, Math.min(na.length, nb.length));
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

export interface MatchScoreDetails {
  title: number;
  artist: number;
  duration: number;
  titleExtraRatio: number;
  total: number;
}

const scoreCandidate = (ext: ExternalTrack, song: Song): MatchScoreDetails => {
  const title = titleScore(ext.title, song.name ?? song.title ?? '');
  const artist = artistScore(ext.artist, song.artist);
  const duration = durationScore(ext.duration, song.duration);
  return {
    title,
    artist,
    duration,
    titleExtraRatio: titleExtraRatio(ext.title, song.name ?? song.title ?? ''),
    total: 0.55 * title + 0.3 * artist + 0.15 * duration,
  };
};

export const MATCH_HIGH_CONFIDENCE_SCORE = 0.72;
const MATCH_ACCEPTABLE_SCORE = 0.4;
const IMPORT_PLAYLIST_TITLE_ACCEPTABLE_SCORE = 0.45;
const MATCH_TITLE_EXTRA_RATIO_LIMIT = 0.5;
const CLOUD_UPLOAD_ACCEPTABLE_SCORE = 0.65;
const CLOUD_UPLOAD_TITLE_ACCEPTABLE_SCORE = 0.85;
const CLOUD_UPLOAD_ARTIST_ACCEPTABLE_SCORE = 0.9;

// 先过滤明显不像同一首歌的候选，再由导入歌单/云盘上传决定业务阈值。
const hasUsableTitle = (match: SearchMatchResult): boolean =>
  match.scoreDetails.title >= IMPORT_PLAYLIST_TITLE_ACCEPTABLE_SCORE &&
  match.scoreDetails.titleExtraRatio <= MATCH_TITLE_EXTRA_RATIO_LIMIT;

const hasReliableCloudTitle = (match: SearchMatchResult): boolean =>
  match.scoreDetails.title >= CLOUD_UPLOAD_TITLE_ACCEPTABLE_SCORE &&
  match.scoreDetails.titleExtraRatio <= MATCH_TITLE_EXTRA_RATIO_LIMIT;

const isDefaultEarlyStopMatch = (match: SearchMatchResult): boolean =>
  match.score >= MATCH_HIGH_CONFIDENCE_SCORE && hasUsableTitle(match);

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
  scoreDetails: MatchScoreDetails;
  /** 产生最佳候选的搜索词 */
  searchText: string;
  /** 搜索结果中的歌曲 id（audioid/scid），用于云盘上传关联，缺失时为 undefined */
  audioId?: string | number;
  /** 搜索结果中的专辑音频 id（mixsongid），用于云盘上传关联，缺失时为 undefined */
  albumAudioId?: string | number;
}

export interface FindBestMatchOptions {
  /** 每个搜索词请求的候选数 */
  pageSize?: number;
  /** 最多尝试的搜索词数量 */
  maxKeywords?: number;
  /** 搜索词之间是否插入节流延迟 */
  delayBetweenSearches?: boolean;
  /** 命中可接受候选后是否提前停止后续搜索 */
  shouldStopEarly?: (match: SearchMatchResult) => boolean;
}

export const normalizePositiveNumericId = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  return /^0+$/.test(text) ? undefined : text;
};

/**
 * 酷狗 v3/search/song 响应中：audio_id 对应 Auditoid，album_audio_id 对应 MixSongID。
 * 其他接口（歌单/歌手/云盘等）字段常见为小写 audio_id / mixsongid，这里保留拼凑式防御。
 */
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
    record?.Auditoid ??
      record?.Audioid ??
      record?.audioid ??
      record?.audio_id ??
      record?.fileid ??
      record?.file_id ??
      record?.Scid ??
      record?.scid ??
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

/** 从搜索结果记录中提取 album_audio_id（MixSongID/mixsongid） */
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

export const findBestMatch = async (
  track: ExternalTrack,
  options: FindBestMatchOptions = {},
): Promise<SearchMatchResult | null> => {
  const keywords =
    typeof options.maxKeywords === 'number'
      ? buildKeywords(track).slice(0, Math.max(1, options.maxKeywords))
      : buildKeywords(track);
  if (keywords.length === 0) return null;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 5, 10));
  let best: SearchMatchResult | null = null;
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    let lists: unknown[] = [];
    try {
      const res = await search(keyword, 'song', 1, pageSize);
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
      const scoreDetails = scoreCandidate(track, song);
      if (!best || scoreDetails.total > best.score) {
        best = {
          song,
          score: scoreDetails.total,
          scoreDetails,
          searchText: keyword,
          audioId: extractAudioId(item),
          albumAudioId: extractAlbumAudioId(item),
        };
        if (options.shouldStopEarly?.(best) ?? isDefaultEarlyStopMatch(best)) return best;
      }
    }
    if (options.delayBetweenSearches && i + 1 < keywords.length) {
      await matchThinkDelay();
    }
  }
  return best;
};

export const isCloudUploadMatchAcceptable = (match: SearchMatchResult): boolean => {
  if (!hasUsableTitle(match) || !hasReliableCloudTitle(match)) return false;
  if (match.score >= MATCH_HIGH_CONFIDENCE_SCORE) return true;
  return (
    match.score >= CLOUD_UPLOAD_ACCEPTABLE_SCORE &&
    match.scoreDetails.artist >= CLOUD_UPLOAD_ARTIST_ACCEPTABLE_SCORE
  );
};

export const isImportPlaylistMatchAcceptable = (match: SearchMatchResult): boolean => {
  return match.score >= MATCH_ACCEPTABLE_SCORE && hasUsableTitle(match);
};

export const explainImportPlaylistMatchRejection = (match: SearchMatchResult): string => {
  const details = match.scoreDetails;
  const reasons: string[] = [];
  if (match.score < MATCH_ACCEPTABLE_SCORE) {
    reasons.push(`相似度过低 (${match.score.toFixed(2)})`);
  }
  if (details.title < IMPORT_PLAYLIST_TITLE_ACCEPTABLE_SCORE) {
    reasons.push(`标题相似度过低 (${details.title.toFixed(2)})`);
  }
  if (details.titleExtraRatio > MATCH_TITLE_EXTRA_RATIO_LIMIT) {
    reasons.push('候选标题包含过多额外内容');
  }
  return reasons.join('，') || `相似度过低 (${match.score.toFixed(2)})`;
};

export const explainCloudUploadMatchRejection = (match: SearchMatchResult): string => {
  const details = match.scoreDetails;
  const reasons: string[] = [];
  if (match.score < CLOUD_UPLOAD_ACCEPTABLE_SCORE) {
    reasons.push(`score ${match.score.toFixed(3)} < ${CLOUD_UPLOAD_ACCEPTABLE_SCORE}`);
  }
  if (details.title < CLOUD_UPLOAD_TITLE_ACCEPTABLE_SCORE) {
    reasons.push(`title ${details.title.toFixed(3)} < ${CLOUD_UPLOAD_TITLE_ACCEPTABLE_SCORE}`);
  }
  if (details.artist < CLOUD_UPLOAD_ARTIST_ACCEPTABLE_SCORE) {
    reasons.push(`artist ${details.artist.toFixed(3)} < ${CLOUD_UPLOAD_ARTIST_ACCEPTABLE_SCORE}`);
  }
  if (details.titleExtraRatio > MATCH_TITLE_EXTRA_RATIO_LIMIT) {
    reasons.push(
      `titleExtraRatio ${details.titleExtraRatio.toFixed(3)} > ${MATCH_TITLE_EXTRA_RATIO_LIMIT}`,
    );
  }
  return reasons.join(', ') || `score ${match.score.toFixed(3)} < ${MATCH_HIGH_CONFIDENCE_SCORE}`;
};

const MATCH_THINK_BASE_MS = 250;
const MATCH_THINK_JITTER_MS = 250;

/** 搜索匹配请求间隔（毫秒），导入歌单、云盘上传等场景复用 */
export const matchThinkDelay = (): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, MATCH_THINK_BASE_MS + Math.random() * MATCH_THINK_JITTER_MS),
  );
