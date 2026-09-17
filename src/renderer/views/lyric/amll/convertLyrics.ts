import type { LyricLine as AmllLyricLine, LyricWord } from '@applemusic-like-lyrics/core';
import type { LyricLine, LyricsMode } from '@/stores/lyric';

/**
 * 将 EchoMusic 歌词行转换为 AMLL 的数据模型。
 * AMLL 要求传入数组内部信息不得被修改，因此每次构建都会生成全新数组。
 *
 * 时间轴均为毫秒；主歌词逐字时间来自 characters。
 *
 * 音译遵循全局「注音」偏好（showRomanizationAsRuby）：
 * - 注音模式（asRuby）：以逐字 / 逐注音单元生成 romanWord，渲染在原词上方，
 *   相当于振假名 / 拼音标注；
 * - 副行模式：注入行级 romanLyric，渲染在主歌词下方。
 * 两种模式互斥，避免同一音译重复显示。
 */

const shouldShowTranslation = (mode: LyricsMode) => mode === 'translation' || mode === 'both';
const shouldShowRomanization = (mode: LyricsMode) => mode === 'romanization' || mode === 'both';

const safeEnd = (startTime: number, endTime: number) => Math.max(endTime, startTime + 1);

/** 以注音单元生成逐词（每个主歌词片段一个词，romanWord 标注在词上方）。 */
const buildRubyWords = (line: LyricLine): LyricWord[] => {
  const units = line.rubyUnits;
  if (!units || units.length === 0) return [];
  const words: LyricWord[] = [];
  for (const unit of units) {
    const unitChars = unit.chars ?? [];
    if (unitChars.length === 0 && !unit.text) continue;
    const first = unitChars[0];
    const last = unitChars[unitChars.length - 1];
    const startTime = first?.startTime ?? unit.startTime;
    const endTime = last?.endTime ?? unit.endTime;
    words.push({
      startTime,
      endTime: safeEnd(startTime, endTime),
      word: unit.text,
      romanWord: unit.ruby || undefined,
    });
  }
  return words;
};

const buildWords = (
  line: LyricLine,
  lineStart: number,
  lineEnd: number,
  withRomanization: boolean,
  asRuby: boolean,
): LyricWord[] => {
  const chars = line.characters ?? [];
  const words: LyricWord[] = [];

  if (withRomanization && asRuby) {
    const rubyWords = buildRubyWords(line);
    if (rubyWords.length > 0) return rubyWords;

    const romans = line.romanizedCharacters;
    if (romans && romans.length === chars.length) {
      for (let index = 0; index < chars.length; index++) {
        const char = chars[index];
        if (!char?.text) continue;
        words.push({
          startTime: char.startTime,
          endTime: safeEnd(char.startTime, char.endTime),
          word: char.text,
          romanWord: romans[index]?.text || undefined,
        });
      }
      if (words.length > 0) return words;
    }
  }

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (!char?.text) continue;
    const startTime = char.startTime;
    words.push({
      startTime,
      endTime: safeEnd(startTime, char.endTime),
      word: char.text,
    });
  }

  if (words.length > 0) return words;

  // 无逐字数据时的兜底：整行作为一个单词。
  return [{ startTime: lineStart, endTime: safeEnd(lineStart, lineEnd), word: line.text || '' }];
};

/** 副行音译文本：优先行级字符串，缺失时由逐字音译拼出。 */
const lineRomanizedText = (line: LyricLine) => {
  const romanized = line.romanized?.trim();
  if (romanized) return romanized;
  return (line.romanizedCharacters ?? [])
    .map((char) => char.text)
    .join('')
    .trim();
};

export function buildAmllLyricLines(
  lines: LyricLine[],
  mode: LyricsMode,
  romanizationAsRuby: boolean,
): AmllLyricLine[] {
  const withTranslation = shouldShowTranslation(mode);
  const withRomanization = shouldShowRomanization(mode);

  return lines.map((line) => {
    const chars = line.characters ?? [];
    const lineStart = (chars[0]?.startTime ?? Math.round(line.time * 1000)) || 0;
    const lineEnd = Math.max(chars[chars.length - 1]?.endTime ?? lineStart + 1000, lineStart + 1);

    return {
      words: buildWords(line, lineStart, lineEnd, withRomanization, romanizationAsRuby),
      translatedLyric: withTranslation ? (line.translated ?? '') : '',
      romanLyric: withRomanization && !romanizationAsRuby ? lineRomanizedText(line) : '',
      startTime: lineStart,
      endTime: lineEnd,
      isBG: false,
      isDuet: false,
    };
  });
}
