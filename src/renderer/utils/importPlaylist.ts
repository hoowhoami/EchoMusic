import { search } from '@/api/search';
import { addPlaylistTrack } from '@/api/playlist';
import { mapSearchSong } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { ExternalTrack } from '../../shared/external';
import logger from '@/utils/logger';

export type ImportItemStatus =
  | 'pending'
  | 'matching'
  | 'adding'
  | 'success'
  | 'low'
  | 'skipped'
  | 'failed';

export interface ImportItemResult {
  external: ExternalTrack;
  status: ImportItemStatus;
  matched?: Song;
  score?: number;
  error?: string;
}

export interface ImportSummary {
  total: number;
  success: number;
  low: number;
  skipped: number;
  failed: number;
}

export interface ImportCallbacks {
  onProgress?: (done: number, total: number, item: ImportItemResult) => void;
  shouldAbort?: () => boolean;
  /** 并发匹配的工人数，默认 2 */
  matchConcurrency?: number;
  /** 每批提交到歌单的曲目数，默认 50 */
  addBatchSize?: number;
}

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

const HIGH_CONFIDENCE = 0.72;
const ACCEPTABLE = 0.4;

/** 匹配可采用的分数阈值（云盘上传等场景复用） */
export const MATCH_ACCEPTABLE_SCORE = ACCEPTABLE;

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
      logger.warn('ImportPlaylist', `search failed: ${keyword}`, e);
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
        if (score >= HIGH_CONFIDENCE) return best;
      }
    }
  }
  return best;
};

const buildSongPayload = (song: Song): string => {
  return `${song.name}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
};

const DEFAULT_ADD_BATCH_SIZE = 50;
const ADD_BATCH_DELAY_MS = 400;
/** 单批 payload (data 参数) encode 后的字节上限，留出 URL 安全余量 */
const ADD_BATCH_MAX_PARAM_LEN = 4000;
// 每次 search 后 worker 的思考时间（含随机抖动），降低稳定 QPS 触发风控
const MATCH_THINK_BASE_MS = 250;
const MATCH_THINK_JITTER_MS = 250;

/** 搜索匹配请求间隔（毫秒），云盘上传等场景复用 */
export const matchThinkDelay = (): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, MATCH_THINK_BASE_MS + Math.random() * MATCH_THINK_JITTER_MS),
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type MatchResult = { song: Song; score: number } | null;

export const runImport = async (
  tracks: ExternalTrack[],
  targetListId: string | number,
  callbacks: ImportCallbacks = {},
): Promise<ImportSummary> => {
  const total = tracks.length;
  const summary: ImportSummary = { total, success: 0, low: 0, skipped: 0, failed: 0 };
  if (total === 0) return summary;

  const matchConcurrency = 1;
  const addBatchSize = Math.max(1, Math.min(callbacks.addBatchSize ?? DEFAULT_ADD_BATCH_SIZE, 50));

  const items: ImportItemResult[] = tracks.map((t) => ({ external: t, status: 'pending' }));
  const matched: MatchResult[] = new Array(total).fill(null);

  // 进度按权重分摊：匹配阶段占 50%，添加阶段占 50%，避免开头长时间停在 0%
  let matchProgress = 0;
  let addProgress = 0;
  let inMatchPhase = true;
  const computeDone = (): number => {
    const raw = inMatchPhase
      ? matchProgress * 0.5
      : total * 0.5 + (summary.skipped + addProgress) * 0.5;
    return Math.min(total, Math.round(raw));
  };
  const emit = (i: number) => callbacks.onProgress?.(computeDone(), total, { ...items[i] });

  // Phase 1: 并发匹配，结果按下标写入 matched[]，保证顺序
  let nextMatchIdx = 0;
  const matchWorker = async () => {
    while (true) {
      if (callbacks.shouldAbort?.()) return;
      const i = nextMatchIdx++;
      if (i >= total) return;
      items[i].status = 'matching';
      emit(i);
      try {
        matched[i] = await findBestMatch(tracks[i]);
      } catch (e) {
        logger.warn('ImportPlaylist', 'match worker error', e);
        matched[i] = null;
      }
      matchProgress++;
      emit(i);
      // 每次请求后 worker 暂停一段抖动时间，避免稳定 QPS 触发风控
      if (nextMatchIdx < total && !callbacks.shouldAbort?.()) {
        await sleep(MATCH_THINK_BASE_MS + Math.random() * MATCH_THINK_JITTER_MS);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(matchConcurrency, total) }, () => matchWorker()));

  if (callbacks.shouldAbort?.()) return summary;

  // Phase 2: 处理跳过项 + 收集待添加列表（按下标顺序）
  inMatchPhase = false;
  const pendingAdd: { index: number; song: Song; score: number }[] = [];
  for (let i = 0; i < total; i++) {
    const m = matched[i];
    if (!m || m.score < ACCEPTABLE) {
      items[i].status = 'skipped';
      items[i].error = m ? `相似度过低 (${m.score.toFixed(2)})` : '未找到候选';
      summary.skipped++;
      emit(i);
    } else {
      items[i].matched = m.song;
      items[i].score = m.score;
      items[i].status = 'adding';
      emit(i);
      pendingAdd.push({ index: i, song: m.song, score: m.score });
    }
  }

  // 酷狗云歌单接口将每个新增项置顶，整批顺序传入会被颠倒。
  // 反向喂入：用户选择的最后一首先发，最终在列表底部；第一首最后发，最终在顶部。
  pendingAdd.reverse();

  // 预先按"条数上限 + URL 参数字节上限"双重阈值切批，避免歌名过长时单批 URL 超长
  type AddChunk = { index: number; song: Song; score: number; payload: string }[];
  const addChunks: AddChunk[] = [];
  {
    let current: AddChunk = [];
    let currentLen = 0;
    for (const entry of pendingAdd) {
      const payload = buildSongPayload(entry.song);
      const payloadLen = encodeURIComponent(payload).length;
      const extra = current.length > 0 ? 1 + payloadLen : payloadLen; // 含分隔逗号
      const overSize = current.length > 0 && currentLen + extra > ADD_BATCH_MAX_PARAM_LEN;
      const overCount = current.length >= addBatchSize;
      if (overSize || overCount) {
        addChunks.push(current);
        current = [];
        currentLen = 0;
      }
      current.push({ ...entry, payload });
      currentLen += current.length === 1 ? payloadLen : extra;
    }
    if (current.length > 0) addChunks.push(current);
  }

  // Phase 3: 顺序按批次提交，一批一次 HTTP，组件内部按 payload 顺序追加
  for (let bi = 0; bi < addChunks.length; bi++) {
    if (callbacks.shouldAbort?.()) break;
    const chunk = addChunks[bi];
    const payload = chunk.map((c) => c.payload).join(',');
    let ok = false;
    let errMsg = '';
    try {
      const res = await addPlaylistTrack(targetListId, payload);
      ok =
        !!res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1;
      if (!ok) errMsg = '添加失败';
    } catch (e: unknown) {
      ok = false;
      errMsg = e instanceof Error && e.message ? e.message : '请求异常';
    }
    for (const c of chunk) {
      const item = items[c.index];
      if (!ok) {
        item.status = 'failed';
        item.error = errMsg;
        summary.failed++;
      } else if (c.score < HIGH_CONFIDENCE) {
        item.status = 'low';
        summary.low++;
        summary.success++;
      } else {
        item.status = 'success';
        summary.success++;
      }
      addProgress++;
      emit(c.index);
    }
    if (bi + 1 < addChunks.length) {
      await new Promise((resolve) => setTimeout(resolve, ADD_BATCH_DELAY_MS));
    }
  }
  // 哨兵：未中止时确保最终 done === total（防止浮点累计在末位差 1）
  if (!callbacks.shouldAbort?.() && total > 0) {
    callbacks.onProgress?.(total, total, { ...items[items.length - 1] });
  }
  return summary;
};
