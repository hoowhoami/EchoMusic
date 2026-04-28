import { defineStore } from 'pinia';
import { getLyric, searchLyric } from '@/api/music';
import logger from '@/utils/logger';

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
}

export type LyricsMode = 'none' | 'translation' | 'romanization' | 'both';

type LyricSearchCandidate = {
  id?: string | number;
  accesskey?: string;
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

  return safeText.split('').map((char, index, arr) => ({
    text: char,
    startTime: startTime + Math.floor((index * total) / arr.length),
    endTime: startTime + Math.floor(((index + 1) * total) / arr.length),
    highlighted: false,
  }));
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
  }),
  getters: {
    // 有效歌词颜色（用户自定义 > 默认值）
    effectivePlayedColor: (state) => state.playedColor || DEFAULT_LYRIC_PLAYED_COLOR,
    effectiveUnplayedColor: (state) => state.unplayedColor || DEFAULT_LYRIC_UNPLAYED_COLOR,
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
    setLyric(content: string, hash = '') {
      this.parseLyricContent({ decodeContent: content }, hash, { detailResolved: false });
    },
    parseLyricContent(
      payload: LyricDetailResponse,
      hash = '',
      options?: { detailResolved?: boolean },
    ) {
      this.resetLyricsState({ hash, tips: '暂无歌词' });
      const content = String(payload.decodeContent ?? payload.lyric ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim();
      this.rawLyric = content;
      this.loadedHash = hash;
      this.detailResolved = Boolean(options?.detailResolved);
      this.isLoading = false;

      if (!content) {
        this.tips = '暂无歌词';
        return;
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
              characters.push({
                text,
                startTime,
                endTime: startTime + duration,
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

      this.lines = parsedLines.map((line, index) => {
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

        if (translated) this.hasTranslation = true;
        if (romanized) this.hasRomanization = true;

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

        stripText(translated);
        stripText(romanized);

        if (line.characters.length > 0) {
          line.text = line.characters
            .map((c) => c.text)
            .join('')
            .trim();
        }

        return {
          time: line.time,
          text: line.text,
          characters: line.characters,
          translated: translated || undefined,
          romanized: romanized || undefined,
        };
      });

      this.tips = this.lines.length > 0 ? '歌词已加载' : '暂无歌词';
    },
    updateCurrentIndex(currentTime: number, isLyricViewOpen = false) {
      if (this.lines.length === 0) {
        this.currentIndex = -1;
        return;
      }

      const currentTimeMs = Math.round(currentTime * 1000);
      let nextIndex = -1;
      const startSearchIndex =
        this.currentIndex >= 0 && currentTime >= this.lines[this.currentIndex].time
          ? this.currentIndex
          : 0;

      for (let index = startSearchIndex; index < this.lines.length; index += 1) {
        const currentLine = this.lines[index];
        const nextLine = this.lines[index + 1];
        const start = currentLine.characters[0]?.startTime ?? Math.round(currentLine.time * 1000);
        const nextStart = nextLine?.characters[0]?.startTime ?? Number.POSITIVE_INFINITY;

        if (currentTimeMs >= start && currentTimeMs < nextStart) {
          nextIndex = index;
          break;
        }
      }

      if (nextIndex === -1 && currentTimeMs >= (this.lines[0]?.characters[0]?.startTime ?? 0)) {
        nextIndex = this.lines.length - 1;
      }

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
    async fetchLyrics(hash: string, options?: { preserveCurrent?: boolean }) {
      const normalizedHash = String(hash ?? '').trim();
      if (!normalizedHash) {
        this.clear('', '暂无歌词');
        return;
      }

      if (
        this.loadedHash === normalizedHash &&
        this.lines.length > 0 &&
        (!options?.preserveCurrent || this.detailResolved)
      ) {
        return;
      }

      const requestSerial = this.requestSerial + 1;
      this.requestSerial = requestSerial;

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
        const searchResult = normalizeSearchPayload(await searchLyric(normalizedHash));
        if (requestSerial !== this.requestSerial) return;

        const target =
          (Array.isArray(searchResult?.candidates) && searchResult.candidates.length > 0
            ? searchResult.candidates[0]
            : Array.isArray(searchResult?.info) && searchResult.info.length > 0
              ? searchResult.info[0]
              : null) ?? null;

        if (!target?.id || !target.accesskey) {
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

        const lyricData = normalizeDetailPayload(
          await getLyric(String(target.id), String(target.accesskey)),
        );
        if (requestSerial !== this.requestSerial) return;

        if (!lyricData) {
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

        this.parseLyricContent(lyricData, normalizedHash, { detailResolved: true });
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
    ],
  },
});
