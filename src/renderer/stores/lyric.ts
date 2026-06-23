import { defineStore } from 'pinia';
import { getLyric, searchLyric } from '@/api/music';
import logger from '@/utils/logger';
import { DEFAULT_ACCENT, getNormalizedAccent } from '@/utils/color';
import type { Song } from '@/models/song';
import { resolvePluginLyric } from '@/plugins/lyrics';
import { useThemeStore } from './theme';

export interface LyricCharacter {
  text: string;
  startTime: number;
  endTime: number;
  highlighted: boolean;
}

export interface LyricLine {
  time: number;
  text: string;
  translated?: string;
  romanized?: string;
  characters: LyricCharacter[];
  // 音译逐字字符（与主歌词 characters 一一映射时间）
  romanizedCharacters?: LyricCharacter[];
  // 翻译逐字字符（按字符比例均分时间）
  translatedCharacters?: LyricCharacter[];
}

export type LyricsMode = 'none' | 'translation' | 'romanization' | 'both';

export type LyricSearchCandidate = {
  id?: string | number;
  accesskey?: string;
  download_id?: string | number;
  krctype?: number;
  content_format?: number;
  contenttype?: number;
  score?: number;
  duration?: number;
  product_from?: string;
  singer?: string;
  song?: string;
  language?: string;
  nickname?: string;
  adjust?: number;
  hitlayer?: number;
  hitcasemask?: number;
  can_score?: boolean;
};

export type ManualLyricSelection = Pick<
  LyricSearchCandidate,
  | 'id'
  | 'accesskey'
  | 'download_id'
  | 'product_from'
  | 'krctype'
  | 'content_format'
  | 'contenttype'
  | 'score'
  | 'duration'
  | 'singer'
  | 'song'
  | 'language'
  | 'nickname'
  | 'adjust'
>;

export type ParsedLyricPreview = {
  lines: LyricLine[];
  rawLyric: string;
  hasTranslation: boolean;
  hasRomanization: boolean;
  tips: string;
};

type CandidateLyricDetail = {
  detail: LyricDetailResponse;
  parsed: ParsedLyricPreview;
};

type CachedLyricResult = {
  detail: LyricDetailResponse;
  currentCandidateKey: string;
};

type LyricSearchResponse = {
  candidates?: LyricSearchCandidate[];
  info?: LyricSearchCandidate[];
};

type LyricSearchEnvelope = LyricSearchResponse & {
  data?: LyricSearchResponse;
};

type LyricDetailResponse = {
  decodeContent?: string;
  lyric?: string;
};

type LyricDetailEnvelope = LyricDetailResponse & {
  data?: LyricDetailResponse;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// const parsePreference = (value: unknown): Exclude<LyricsMode, 'none'> => {
//   if (value === 'romanization') return 'romanization';
//   if (value === 'both') return 'both';
//   return 'translation';
// };

const normalizeDetailPayload = (payload: unknown): LyricDetailResponse | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as LyricDetailEnvelope;
  const nested = record.data && typeof record.data === 'object' ? record.data : null;
  const decodeContent =
    typeof (nested?.decodeContent ?? record.decodeContent) === 'string'
      ? String(nested?.decodeContent ?? record.decodeContent)
      : '';
  const lyric =
    typeof (nested?.lyric ?? record.lyric) === 'string'
      ? String(nested?.lyric ?? record.lyric)
      : '';
  if (!decodeContent && !lyric) return null;
  return { decodeContent, lyric };
};

const normalizeSearchPayload = (payload: unknown): LyricSearchResponse | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as LyricSearchEnvelope;
  const nested = record.data && typeof record.data === 'object' ? record.data : null;
  const candidates: LyricSearchCandidate[] = Array.isArray(nested?.candidates ?? record.candidates)
    ? ((nested?.candidates ?? record.candidates ?? []) as LyricSearchCandidate[])
    : [];
  const info: LyricSearchCandidate[] = Array.isArray(nested?.info ?? record.info)
    ? ((nested?.info ?? record.info ?? []) as LyricSearchCandidate[])
    : [];
  if (candidates.length === 0 && info.length === 0) return null;
  return { candidates, info };
};

export const getLyricCandidateKey = (candidate: Pick<LyricSearchCandidate, 'id' | 'accesskey'>) =>
  `${String(candidate.id ?? '')}:${String(candidate.accesskey ?? '')}`;

const isUsableCandidate = (candidate: LyricSearchCandidate | null | undefined) =>
  Boolean(candidate?.id && candidate.accesskey);

const compactCandidate = (candidate: LyricSearchCandidate): ManualLyricSelection => ({
  id: candidate.id,
  accesskey: candidate.accesskey,
  download_id: candidate.download_id,
  product_from: candidate.product_from,
  krctype: candidate.krctype,
  content_format: candidate.content_format,
  contenttype: candidate.contenttype,
  score: candidate.score,
  duration: candidate.duration,
  singer: candidate.singer,
  song: candidate.song,
  language: candidate.language,
  nickname: candidate.nickname,
  adjust: candidate.adjust,
});

// 保持接口返回的原始顺序
const sortCandidates = (candidates: LyricSearchCandidate[]): LyricSearchCandidate[] => candidates;

// 排序后取第一条作为默认歌词
const pickDefaultCandidate = (candidates: LyricSearchCandidate[]): LyricSearchCandidate | null =>
  candidates[0] ?? null;

const decodeLanguageLine = (
  line: string,
): { translationLyrics?: unknown[]; romanizationLyrics?: unknown[] } => {
  try {
    const code = line.slice(10, -1);
    if (!code) return {};

    const cleanedCode = code.replace(/[^A-Za-z0-9+/=]/g, '');
    const paddingLength = (4 - (cleanedCode.length % 4)) % 4;
    const paddedCode = `${cleanedCode}${'='.repeat(paddingLength)}`;
    const decoded = window.atob(paddedCode);
    const utf8 = decodeURIComponent(
      Array.from(decoded)
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const languageData = JSON.parse(utf8) as {
      content?: Array<{ type?: number; lyricContent?: unknown[] }>;
    };

    let translationLyrics: unknown[] | undefined;
    let romanizationLyrics: unknown[] | undefined;

    for (const section of languageData.content ?? []) {
      if (section.type === 1) translationLyrics = section.lyricContent;
      if (section.type === 0) romanizationLyrics = section.lyricContent;
    }

    return { translationLyrics, romanizationLyrics };
  } catch (error) {
    logger.warn('LyricStore', 'Decode lyric language line failed', error);
    return {};
  }
};

const buildFallbackCharacters = (
  text: string,
  startTime: number,
  duration: number,
): LyricCharacter[] => {
  const safeText = text.trim();
  if (!safeText) return [];
  const total = Math.max(duration, safeText.length * 120);

  return safeText.split('').map((char, index, arr) => {
    const charStart = startTime + Math.floor((index * total) / arr.length);
    const charEnd = startTime + Math.floor(((index + 1) * total) / arr.length);
    // 确保每个字符至少有 1ms 的持续时间，防止逐字显示失效
    return {
      text: char,
      startTime: charStart,
      endTime: Math.max(charEnd, charStart + 1),
      highlighted: false,
    };
  });
};

const getSecondaryText = (line: LyricLine, mode: LyricsMode): string => {
  const romanized = line.romanized?.trim() ?? '';
  const translated = line.translated?.trim() ?? '';
  if (mode === 'both') {
    const parts = [translated, romanized].filter(Boolean);
    return parts.join(' / ');
  }
  if (mode === 'romanization') return romanized || translated;
  if (mode === 'translation') return translated || romanized;
  return '';
};

// const getPreferredSecondaryMode = (
//   hasRomanization: boolean,
//   hasTranslation: boolean,
// ): LyricsMode => {
//   if (hasRomanization) return 'romanization';
//   if (hasTranslation) return 'translation';
//   return 'none';
// };

// 页面歌词默认颜色
export const DEFAULT_LYRIC_PLAYED_COLOR = '#31cfa1';
export const DEFAULT_LYRIC_UNPLAYED_COLOR = '#ffffff';
export const LYRIC_COVER_COLOR_VALUE = '__cover__';

const isDarkMode = (): boolean => document.documentElement.classList.contains('dark');

const resolveLyricColor = (value: string, fallback: string): string => {
  if (value === LYRIC_COVER_COLOR_VALUE) {
    const themeStore = useThemeStore();
    return getNormalizedAccent(themeStore.coverColor || DEFAULT_ACCENT, isDarkMode());
  }
  return value || fallback;
};

const parseLyricDetailPayload = (payload: LyricDetailResponse): ParsedLyricPreview => {
  const content = String(payload.decodeContent ?? payload.lyric ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();

  if (!content) {
    return {
      lines: [],
      rawLyric: '',
      hasTranslation: false,
      hasRomanization: false,
      tips: '暂无歌词',
    };
  }

  const sourceLines = content.split(/\r?\n/);
  const languageLine = sourceLines.find((line) => line.startsWith('[language:')) ?? '';
  const { translationLyrics, romanizationLyrics } = languageLine
    ? decodeLanguageLine(languageLine)
    : {};
  const charRegex = /<(\d+),(\d+),\d+>([^<]+)/g;
  const parsedLines: LyricLine[] = [];

  for (const sourceLine of sourceLines) {
    const krcMatch = sourceLine.match(/^\[(\d+),(\d+)\](.*)$/);

    if (krcMatch) {
      const lineStart = Number.parseInt(krcMatch[1], 10);
      const lineDuration = Number.parseInt(krcMatch[2], 10);
      const lineContent = krcMatch[3] ?? '';
      const characters: LyricCharacter[] = [];
      const matches = Array.from(lineContent.matchAll(charRegex));

      if (matches.length > 0) {
        for (const match of matches) {
          const text = match[3] ?? '';
          const duration = Number.parseInt(match[2] ?? '0', 10);
          const startTime = lineStart + Number.parseInt(match[1] ?? '0', 10);
          // 确保 duration 至少为 1ms，防止 endTime === startTime 导致逐字显示失效
          const safeDuration = Math.max(duration, 1);
          characters.push({
            text,
            startTime,
            endTime: startTime + safeDuration,
            highlighted: false,
          });
        }
      } else {
        const text = lineContent.replace(/<.*?>/g, '').trim();
        if (text) {
          characters.push(...buildFallbackCharacters(text, lineStart, lineDuration));
        }
      }

      if (characters.length > 0) {
        parsedLines.push({
          time: characters[0].startTime / 1000,
          text: characters.map((c) => c.text).join(''),
          characters,
        });
      }
      continue;
    }

    const lrcMatch = sourceLine.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (lrcMatch) {
      const minutes = Number.parseInt(lrcMatch[1], 10);
      const seconds = Number.parseFloat(lrcMatch[2]);
      const text = (lrcMatch[3] ?? '').trim();
      const startTime = Math.round((minutes * 60 + seconds) * 1000);

      if (text) {
        parsedLines.push({
          time: startTime / 1000,
          text,
          characters: [
            {
              text,
              startTime,
              endTime: startTime + 3000,
              highlighted: false,
            },
          ],
        });
      }
    }
  }

  let hasTranslation = false;
  let hasRomanization = false;
  const lines = parsedLines.map((line, index) => {
    let translated = '';
    let romanized = '';

    const translationLine = translationLyrics?.[index];
    if (Array.isArray(translationLine) && translationLine.length > 0) {
      translated = String(translationLine[0] ?? '').trim();
    }

    const romanizationLine = romanizationLyrics?.[index];
    if (Array.isArray(romanizationLine) && romanizationLine.length > 0) {
      romanized = romanizationLine.join('').trim();
    }

    if (translated) hasTranslation = true;
    if (romanized) hasRomanization = true;

    const stripText = (textToStrip: string) => {
      if (!textToStrip) return;
      let remaining = textToStrip.replace(/\s+/g, '');
      const characters = line.characters;
      while (remaining.length > 0 && characters.length > 0) {
        const lastChar = characters[characters.length - 1];
        if (!lastChar) break;
        const charTextNoSpace = lastChar.text.replace(/\s+/g, '');

        if (charTextNoSpace === '') {
          characters.pop();
          continue;
        }

        if (remaining.endsWith(charTextNoSpace)) {
          remaining = remaining.slice(0, -charTextNoSpace.length);
          characters.pop();
        } else if (charTextNoSpace.endsWith(remaining)) {
          let charsDeleted = 0;
          let i = lastChar.text.length - 1;
          while (i >= 0 && charsDeleted < remaining.length) {
            if (!/\s/.test(lastChar.text[i] ?? '')) {
              charsDeleted++;
            }
            i--;
          }
          lastChar.text = lastChar.text.slice(0, i + 1);
          remaining = '';
          break;
        } else {
          break;
        }
      }
    };

    const origLineStart = line.characters[0]?.startTime ?? 0;
    const origLineEnd = line.characters[line.characters.length - 1]?.endTime ?? origLineStart;

    stripText(translated);
    stripText(romanized);

    if (line.characters.length > 0) {
      line.text = line.characters
        .map((c) => c.text)
        .join('')
        .trim();
    }

    let romanizedCharacters: LyricCharacter[] | undefined;
    if (romanized && Array.isArray(romanizationLine) && romanizationLine.length > 0) {
      const chars = line.characters;
      if (romanizationLine.length === chars.length) {
        romanizedCharacters = romanizationLine.map((text: unknown, i: number) => ({
          text: String(text ?? ''),
          startTime: chars[i]?.startTime ?? 0,
          endTime: chars[i]?.endTime ?? 0,
          highlighted: false,
        }));
      } else {
        const lineStart = chars[0]?.startTime ?? 0;
        const lineEnd = chars[chars.length - 1]?.endTime ?? lineStart;
        const totalDuration = lineEnd - lineStart;
        const totalLen = romanizationLine.reduce(
          (sum: number, t: unknown) => sum + String(t ?? '').length,
          0,
        );
        let offset = 0;
        romanizedCharacters = romanizationLine.map((text: unknown) => {
          const t = String(text ?? '');
          const ratio = totalLen > 0 ? t.length / totalLen : 0;
          const start = lineStart + Math.round(offset * totalDuration);
          offset += ratio;
          const end = lineStart + Math.round(offset * totalDuration);
          // 确保每个字符至少有 1ms 的持续时间，防止逐字显示失效
          return {
            text: t,
            startTime: start,
            endTime: Math.max(end, start + 1),
            highlighted: false,
          };
        });
      }
    }

    let translatedCharacters: LyricCharacter[] | undefined;
    if (translated) {
      const totalDuration = Math.max(origLineEnd - origLineStart, translated.length * 120);
      const chars = translated.split('');
      const totalLen = chars.length;
      translatedCharacters = chars.map((char, i) => {
        const charStart = origLineStart + Math.round((i / totalLen) * totalDuration);
        const charEnd = origLineStart + Math.round(((i + 1) / totalLen) * totalDuration);
        // 确保每个字符至少有 1ms 的持续时间，防止逐字显示失效
        return {
          text: char,
          startTime: charStart,
          endTime: Math.max(charEnd, charStart + 1),
          highlighted: false,
        };
      });
    }

    return {
      time: line.time,
      text: line.text,
      characters: line.characters,
      translated: translated || undefined,
      romanized: romanized || undefined,
      romanizedCharacters,
      translatedCharacters,
    };
  });

  return {
    lines,
    rawLyric: content,
    hasTranslation,
    hasRomanization,
    tips: lines.length > 0 ? '歌词已加载' : '暂无歌词',
  };
};

// 歌词过滤默认正则表达式
export const DEFAULT_LYRIC_FILTER_PATTERN =
  '^(作词|作曲|编曲|制作人|录音|混音|母带|出品|发行|企划|监制|和声|吉他|贝斯|鼓|键盘|弦乐|词|曲|编|唱片|OP|SP|原唱|翻唱|许可|音乐人|纯音乐|宣推|协作推广|策划|统筹|营销|推广|制作|配唱|和音|弦乐编写|人声录音|人声编辑)[：:]|^(Lyrics|Composed|Produced|Written|Arranged|Mixed|Mastered|Recorded|Performed) by[：:]|^[『「【].*[』」】]$|未经著作权人许可|不得翻唱|翻录或使用|听歌就在';

/**
 * 测试歌词行是否应被过滤
 * @param text 歌词文本
 * @param enabled 是否启用过滤
 * @param pattern 用户自定义正则表达式（为空时使用默认）
 */
export function testLyricFilter(text: string, enabled: boolean, pattern: string): boolean {
  if (!enabled || !text) return false;
  const effectivePattern = pattern.trim() || DEFAULT_LYRIC_FILTER_PATTERN;
  try {
    return new RegExp(effectivePattern).test(text);
  } catch {
    return false;
  }
}

// 同一 hash 的在途歌词请求去重：避免切歌瞬间 playTrack 与歌词页 watch 各自触发，
// 导致对同一首歌并发多次 searchLyric/getLyric，挤占本地服务器、拖慢音频首包。
let inflightLyricHash: string | null = null;
const inflightCandidateDetailMap = new Map<string, Promise<CandidateLyricDetail | null>>();
const lyricResultCache = new Map<string, CachedLyricResult>();
const LYRIC_RESULT_CACHE_LIMIT = 32;

const getLyricResultCacheKey = (hash: string, candidate?: LyricSearchCandidate | null) =>
  `${hash}:${candidate ? getLyricCandidateKey(candidate) : 'auto'}`;

const rememberLyricResult = (key: string, value: CachedLyricResult) => {
  if (!key) return;
  if (lyricResultCache.has(key)) lyricResultCache.delete(key);
  lyricResultCache.set(key, value);
  while (lyricResultCache.size > LYRIC_RESULT_CACHE_LIMIT) {
    const oldestKey = lyricResultCache.keys().next().value;
    if (!oldestKey) break;
    lyricResultCache.delete(oldestKey);
  }
};

const shouldPreferPluginLyric = (track?: Song): boolean => {
  const source = String(track?.source ?? '')
    .trim()
    .toLowerCase();
  return Boolean(source && source !== 'cloud');
};

export const useLyricStore = defineStore('lyric', {
  state: () => ({
    lines: [] as LyricLine[],
    currentIndex: -1,
    rawLyric: '',
    loadedHash: '',
    tips: '暂无歌词',
    isLoading: false,
    // 歌词同步警告（实际播放时长与歌词时长差异过大时显示）
    lyricSyncWarning: false,
    // 用户意图：是否想看翻译/音译（持久化，切歌不重置）
    wantTranslation: false,
    wantRomanization: false,
    // 当前歌曲数据可用性（每首歌重新检测）
    hasTranslation: false,
    hasRomanization: false,
    fontScale: 1,
    fontWeightIndex: 8,
    playedColor: '',
    unplayedColor: '',
    requestSerial: 0,
    detailResolved: false,
    sourceDialogOpen: false,
    candidateHash: '',
    candidates: [] as LyricSearchCandidate[],
    candidatePreviewMap: {} as Record<string, ParsedLyricPreview | null>,
    candidateDetailMap: {} as Record<string, LyricDetailResponse | null>,
    autoCandidateKey: '',
    currentCandidateKey: '',
    manualLyricMap: {} as Record<string, ManualLyricSelection>,
    // 每首歌的歌词时间偏移（毫秒），key 为歌曲 hash/id
    timeOffsetMap: {} as Record<string, number>,
  }),
  getters: {
    manualCandidateForCurrentHash: (state): ManualLyricSelection | null => {
      if (!state.loadedHash) return null;
      return state.manualLyricMap[state.loadedHash] ?? null;
    },
    // 当前歌曲的歌词时间偏移（毫秒）
    currentTimeOffset: (state): number => {
      if (!state.loadedHash) return 0;
      return state.timeOffsetMap[state.loadedHash] ?? 0;
    },
    effectivePlayedColor: (state) =>
      resolveLyricColor(state.playedColor, DEFAULT_LYRIC_PLAYED_COLOR),
    effectiveUnplayedColor: (state) =>
      resolveLyricColor(state.unplayedColor, DEFAULT_LYRIC_UNPLAYED_COLOR),
    // 兼容旧代码
    secondaryEnabled: (state) => state.wantTranslation || state.wantRomanization,
    canShowSecondary: (state) => state.hasTranslation || state.hasRomanization,
    // 实际显示模式：由用户意图 + 数据可用性自动推导
    lyricsMode: (state): LyricsMode => {
      const canTrans = state.wantTranslation && state.hasTranslation;
      const canRoman = state.wantRomanization && state.hasRomanization;
      if (canTrans && canRoman) return 'both';
      if (canTrans) return 'translation';
      if (canRoman) return 'romanization';
      return 'none';
    },
    currentDisplayLabel(): string {
      const mode = this.lyricsMode;
      if (mode === 'both') return '译+音';
      if (mode === 'translation') return '翻译';
      if (mode === 'romanization') return '音译';
      if (this.wantTranslation || this.wantRomanization) return '原词';
      return '原词';
    },
    showTranslation(): boolean {
      return this.lyricsMode === 'translation' || this.lyricsMode === 'both';
    },
    showRomanization(): boolean {
      return this.lyricsMode === 'romanization' || this.lyricsMode === 'both';
    },
    currentLine: (state) =>
      state.currentIndex >= 0 ? (state.lines[state.currentIndex] ?? null) : null,
    activeSecondaryText(): string {
      const line = this.currentIndex >= 0 ? (this.lines[this.currentIndex] ?? null) : null;
      if (!line || this.lyricsMode === 'none') return '';
      return getSecondaryText(line, this.lyricsMode);
    },
    lineSecondaryText() {
      return (line: LyricLine | null | undefined): string => {
        if (!line || this.lyricsMode === 'none') return '';
        return getSecondaryText(line, this.lyricsMode);
      };
    },
    fontWeightValue: (state) => {
      const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
      return weights[clamp(state.fontWeightIndex, 0, 8)] ?? 900;
    },
    copyableText(): string {
      const mode = this.lyricsMode;
      return this.lines
        .map((line: LyricLine) => {
          const primary = line.text.trim();
          if (mode === 'none') return primary;
          if (mode === 'both') {
            const translated = line.translated?.trim() ?? '';
            const romanized = line.romanized?.trim() ?? '';
            const parts = [primary, translated, romanized].filter(Boolean);
            return parts.join('\n');
          }
          const secondary = getSecondaryText(line, mode);
          return secondary ? `${primary}\n${secondary}` : primary;
        })
        .filter(Boolean)
        .join('\n');
    },
  },
  actions: {
    resetLyricsState(payload?: { hash?: string; tips?: string }) {
      this.lines = [];
      this.currentIndex = -1;
      this.rawLyric = '';
      this.loadedHash = payload?.hash ?? '';
      this.tips = payload?.tips ?? '暂无歌词';
      this.isLoading = false;
      this.lyricSyncWarning = false;
      // 不重置 lyricsMode 和 secondaryEnabled，保留用户的翻译偏好
      this.hasTranslation = false;
      this.hasRomanization = false;
      this.detailResolved = false;
      this.currentCandidateKey = '';
    },
    clear(hash = '', tips = '暂无歌词') {
      this.requestSerial += 1;
      this.resetLyricsState({ hash, tips });
    },
    beginLoading(hash = '') {
      this.resetLyricsState({ hash, tips: '歌词加载中...' });
      this.isLoading = true;
    },
    updateFontScale(scale: number) {
      this.fontScale = clamp(Number(scale) || 1, 0.7, 1.4);
    },
    updateFontWeight(index: number) {
      this.fontWeightIndex = clamp(Math.round(index), 0, 8);
    },
    // 调整当前歌曲的歌词时间偏移（毫秒）
    adjustTimeOffset(deltaMs: number): number {
      if (!this.loadedHash) return 0;
      const current = this.timeOffsetMap[this.loadedHash] ?? 0;
      const next = clamp(current + deltaMs, -10000, 10000);
      this.timeOffsetMap[this.loadedHash] = next;
      return next;
    },
    // 重置当前歌曲的歌词时间偏移
    resetTimeOffset() {
      if (!this.loadedHash) return;
      delete this.timeOffsetMap[this.loadedHash];
    },
    findIndexAtTimeMs(currentTimeMs: number): number {
      if (this.lines.length === 0) return -1;

      let nextIndex = -1;
      let low = 0;
      let high = this.lines.length - 1;

      // 找到最后一个 startTime <= currentTimeMs 的行。播放中这是高频路径，用二分避免逐帧线性扫描。
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const line = this.lines[mid];
        const start = line.characters[0]?.startTime ?? Math.round(line.time * 1000);
        if (currentTimeMs >= start) {
          nextIndex = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return nextIndex;
    },
    setLyric(content: string, hash = '') {
      this.parseLyricContent({ decodeContent: content }, hash, { detailResolved: false });
    },
    parseLyricContent(
      payload: LyricDetailResponse,
      hash = '',
      options?: { detailResolved?: boolean },
    ) {
      this.resetLyricsState({ hash, tips: '暂无歌词' });
      const parsed = parseLyricDetailPayload(payload);
      this.lines = parsed.lines;
      this.rawLyric = parsed.rawLyric;
      this.loadedHash = hash;
      this.detailResolved = Boolean(options?.detailResolved);
      this.isLoading = false;
      this.hasTranslation = parsed.hasTranslation;
      this.hasRomanization = parsed.hasRomanization;
      this.tips = parsed.tips;
    },
    async fetchLyricCandidates(
      hash: string,
      options?: {
        duration?: number;
        keywords?: string;
        force?: boolean;
        hydratePreviews?: boolean;
      },
    ) {
      const normalizedHash = String(hash ?? '').trim();
      if (!normalizedHash) return [] as LyricSearchCandidate[];
      if (!options?.force && this.candidateHash === normalizedHash && this.candidates.length > 0) {
        if (options?.hydratePreviews) await this.hydrateCandidatePreviews(this.candidates);
        return this.candidates;
      }

      const searchResult = normalizeSearchPayload(
        await searchLyric(normalizedHash, options?.duration, options?.keywords),
      );
      const candidates = sortCandidates(
        Array.isArray(searchResult?.candidates) && searchResult.candidates.length > 0
          ? searchResult.candidates
          : Array.isArray(searchResult?.info)
            ? searchResult.info
            : [],
      );
      const autoCandidate = pickDefaultCandidate(candidates);

      this.candidateHash = normalizedHash;
      this.candidates = candidates;
      this.candidatePreviewMap = {};
      this.candidateDetailMap = {};
      this.autoCandidateKey = autoCandidate ? getLyricCandidateKey(autoCandidate) : '';
      if (options?.hydratePreviews) await this.hydrateCandidatePreviews(candidates);
      return candidates;
    },
    async resolveCandidateDetail(
      candidate: LyricSearchCandidate,
    ): Promise<CandidateLyricDetail | null> {
      if (!isUsableCandidate(candidate)) return null;
      const key = getLyricCandidateKey(candidate);
      if (Object.prototype.hasOwnProperty.call(this.candidateDetailMap, key)) {
        const detail = this.candidateDetailMap[key];
        const parsed = this.candidatePreviewMap[key];
        return detail && parsed ? { detail, parsed } : null;
      }

      const pending = inflightCandidateDetailMap.get(key);
      if (pending) return pending;

      const request = (async () => {
        try {
          const lyricData = normalizeDetailPayload(
            await getLyric(String(candidate.id), String(candidate.accesskey)),
          );
          if (!lyricData) {
            this.candidateDetailMap[key] = null;
            this.candidatePreviewMap[key] = null;
            return null;
          }

          const parsed = parseLyricDetailPayload(lyricData);
          this.candidateDetailMap[key] = lyricData;
          this.candidatePreviewMap[key] = parsed;
          return { detail: lyricData, parsed };
        } finally {
          inflightCandidateDetailMap.delete(key);
        }
      })();

      inflightCandidateDetailMap.set(key, request);
      return request;
    },
    async hydrateCandidatePreviews(candidates: LyricSearchCandidate[]) {
      const usableCandidates = candidates.filter(isUsableCandidate);
      if (usableCandidates.length === 0) return;

      await Promise.all(
        usableCandidates.map((candidate) =>
          this.resolveCandidateDetail(candidate).catch((error) => {
            logger.warn('LyricStore', 'Resolve lyric candidate failed', error, {
              key: getLyricCandidateKey(candidate),
            });
            this.candidateDetailMap[getLyricCandidateKey(candidate)] = null;
            this.candidatePreviewMap[getLyricCandidateKey(candidate)] = null;
            return null;
          }),
        ),
      );
    },
    async previewCandidate(candidate: LyricSearchCandidate): Promise<ParsedLyricPreview | null> {
      const resolved = await this.resolveCandidateDetail(candidate);
      return resolved?.parsed ?? null;
    },
    async applyCandidate(
      hash: string,
      candidate: LyricSearchCandidate,
      options?: { remember?: boolean },
    ): Promise<boolean> {
      const normalizedHash = String(hash ?? '').trim();
      if (!normalizedHash || !isUsableCandidate(candidate)) return false;

      const resolved = await this.resolveCandidateDetail(candidate);
      if (!resolved) return false;

      this.parseLyricContent(resolved.detail, normalizedHash, { detailResolved: true });
      this.currentCandidateKey = getLyricCandidateKey(candidate);
      rememberLyricResult(getLyricResultCacheKey(normalizedHash, candidate), {
        detail: resolved.detail,
        currentCandidateKey: this.currentCandidateKey,
      });
      if (options?.remember) {
        this.manualLyricMap[normalizedHash] = compactCandidate(candidate);
      }
      return true;
    },
    async restoreAutoLyric(hash: string, options?: { duration?: number; keywords?: string }) {
      const normalizedHash = String(hash ?? '').trim();
      if (!normalizedHash) return;
      delete this.manualLyricMap[normalizedHash];
      this.currentCandidateKey = '';
      await this.fetchLyrics(normalizedHash, {
        duration: options?.duration,
        keywords: options?.keywords,
        force: true,
      });
    },
    updateCurrentIndex(currentTime: number, isLyricViewOpen = false) {
      if (this.lines.length === 0) {
        this.currentIndex = -1;
        return;
      }

      // 加上当前歌曲的时间偏移
      const offsetMs = this.timeOffsetMap[this.loadedHash] || 0;
      const currentTimeMs = Math.round(currentTime * 1000) + offsetMs;
      const nextIndex = this.findIndexAtTimeMs(currentTimeMs);

      if (this.currentIndex !== nextIndex) {
        // 逐字高亮状态只在歌词页打开时更新，避免无意义的响应式开销
        if (isLyricViewOpen) {
          const previousLine = this.currentIndex >= 0 ? this.lines[this.currentIndex] : null;
          previousLine?.characters.forEach((char) => {
            if (char.highlighted) char.highlighted = false;
          });
        }
        this.currentIndex = nextIndex;
      }

      if (this.currentIndex < 0) return;
      // 逐字高亮只在歌词页打开时更新
      if (!isLyricViewOpen) return;
      const currentLine = this.lines[this.currentIndex];
      currentLine.characters.forEach((char) => {
        const shouldHighlight = currentTimeMs >= char.startTime;
        if (char.highlighted !== shouldHighlight) {
          char.highlighted = shouldHighlight;
        }
      });
    },
    async fetchLyrics(
      hash: string,
      options?: {
        preserveCurrent?: boolean;
        duration?: number;
        keywords?: string;
        force?: boolean;
        track?: Song;
      },
    ) {
      const normalizedHash = String(hash ?? '').trim();
      if (!normalizedHash) {
        this.clear('', '暂无歌词');
        return;
      }

      if (
        this.loadedHash === normalizedHash &&
        (this.lines.length > 0 || Boolean(this.rawLyric)) &&
        !options?.force &&
        (!options?.preserveCurrent || this.detailResolved)
      ) {
        return;
      }

      // 同一 hash 已有在途请求时跳过，避免并发重复拉取
      if (inflightLyricHash === normalizedHash && !options?.force) {
        return;
      }

      const requestSerial = this.requestSerial + 1;
      this.requestSerial = requestSerial;
      inflightLyricHash = normalizedHash;

      const shouldPreserveCurrentLines =
        Boolean(options?.preserveCurrent) &&
        this.loadedHash === normalizedHash &&
        this.lines.length > 0;

      if (shouldPreserveCurrentLines) {
        this.isLoading = true;
        this.tips = '歌词加载中...';
      } else {
        this.beginLoading(normalizedHash);
      }

      try {
        const manualCandidate = this.manualLyricMap[normalizedHash];
        const cacheKey = getLyricResultCacheKey(
          normalizedHash,
          isUsableCandidate(manualCandidate) ? manualCandidate : null,
        );
        const cached = !options?.force ? lyricResultCache.get(cacheKey) : null;
        if (cached) {
          this.parseLyricContent(cached.detail, normalizedHash, { detailResolved: true });
          this.currentCandidateKey = cached.currentCandidateKey;
          return;
        }

        const canUsePluginLyric = !isUsableCandidate(manualCandidate);
        const preferPluginLyric =
          canUsePluginLyric && (Boolean(options?.force) || shouldPreferPluginLyric(options?.track));
        const tryResolvePluginLyric = async (): Promise<boolean> => {
          if (!canUsePluginLyric) return false;
          const pluginLyric = await resolvePluginLyric({
            hash: normalizedHash,
            track: options?.track,
            duration: Math.max(0, Number(options?.duration) || 0),
            force: Boolean(options?.force),
            preserveCurrent: Boolean(options?.preserveCurrent),
          });
          if (requestSerial !== this.requestSerial) return true;
          if (!pluginLyric) return false;

          const detail = { decodeContent: pluginLyric.decodeContent };
          const pluginCandidateKey = `plugin:${pluginLyric.pluginId}:${pluginLyric.resolverId}`;
          this.parseLyricContent(detail, normalizedHash, { detailResolved: true });
          this.currentCandidateKey = pluginCandidateKey;
          rememberLyricResult(cacheKey, {
            detail,
            currentCandidateKey: pluginCandidateKey,
          });
          return true;
        };

        if (preferPluginLyric && (await tryResolvePluginLyric())) {
          return;
        }

        const candidates = await this.fetchLyricCandidates(normalizedHash, {
          duration: options?.duration,
          keywords: options?.keywords ?? options?.track?.title ?? options?.track?.name ?? '',
          force: true,
        });
        if (requestSerial !== this.requestSerial) return;

        const target =
          (isUsableCandidate(manualCandidate)
            ? manualCandidate
            : pickDefaultCandidate(candidates)) ?? null;

        if (!target?.id || !target.accesskey) {
          if (!preferPluginLyric && (await tryResolvePluginLyric())) {
            return;
          }
          if (options?.preserveCurrent && this.lines.length > 0) {
            this.isLoading = false;
            this.loadedHash = normalizedHash;
            this.tips = '歌词已加载';
            this.detailResolved = false;
            return;
          }
          this.clear(normalizedHash, '暂无歌词');
          return;
        }

        const resolved = await this.resolveCandidateDetail(target);
        if (requestSerial !== this.requestSerial) return;

        if (!resolved) {
          if (!preferPluginLyric && (await tryResolvePluginLyric())) {
            return;
          }
          if (options?.preserveCurrent && this.lines.length > 0) {
            this.isLoading = false;
            this.loadedHash = normalizedHash;
            this.tips = '歌词已加载';
            this.detailResolved = false;
            return;
          }
          this.clear(normalizedHash, '暂无歌词');
          return;
        }

        const currentCandidateKey = getLyricCandidateKey(target);
        this.parseLyricContent(resolved.detail, normalizedHash, { detailResolved: true });
        this.currentCandidateKey = currentCandidateKey;
        rememberLyricResult(cacheKey, {
          detail: resolved.detail,
          currentCandidateKey,
        });
      } catch (error) {
        if (requestSerial !== this.requestSerial) return;
        logger.error('LyricStore', 'Fetch lyrics failed', error, { hash: normalizedHash });
        if (options?.preserveCurrent && this.lines.length > 0) {
          this.isLoading = false;
          this.loadedHash = normalizedHash;
          this.tips = '歌词已加载';
          this.detailResolved = false;
          return;
        }
        this.clear(normalizedHash, '歌词加载失败');
      } finally {
        // 仅当当前在途标记仍属于本次请求时才清除，避免误清后续请求
        if (inflightLyricHash === normalizedHash) inflightLyricHash = null;
      }
    },
  },
  persist: {
    pick: [
      'wantTranslation',
      'wantRomanization',
      'fontScale',
      'fontWeightIndex',
      'playedColor',
      'unplayedColor',
      'timeOffsetMap',
      'manualLyricMap',
    ],
  },
});
