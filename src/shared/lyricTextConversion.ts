import type { LyricCharacterPayload, LyricLinePayload, LyricRubyUnitPayload } from './lyrics';
import {
  normalizeLyricTextConversionMode,
  resolveOpenccProfile,
  type LyricTextConversionMode,
  type OpenccProfile,
} from './opencc';

export type LyricTextConversionRequest = {
  mode: LyricTextConversionMode;
  profile: OpenccProfile | null;
  texts: string[];
};

const addText = (texts: Set<string>, value: unknown) => {
  if (typeof value !== 'string' || !value) return;
  texts.add(value);
};

export const buildLyricTextConversionRequest = (
  lines: readonly LyricLinePayload[],
  mode: unknown,
): LyricTextConversionRequest => {
  const normalizedMode = normalizeLyricTextConversionMode(mode);
  const profile = resolveOpenccProfile(normalizedMode);
  const texts = new Set<string>();

  if (profile) {
    for (const line of lines) {
      addText(texts, line.text);
      addText(texts, line.translated);
      for (const char of line.characters ?? []) addText(texts, char.text);
      for (const char of line.translatedCharacters ?? []) addText(texts, char.text);
      for (const unit of line.rubyUnits ?? []) {
        addText(texts, unit.text);
        for (const char of unit.chars ?? []) addText(texts, char.text);
      }
    }
  }

  return {
    mode: normalizedMode,
    profile,
    texts: [...texts],
  };
};

const convertText = (value: string | undefined, converted: ReadonlyMap<string, string>) =>
  value ? (converted.get(value) ?? value) : value;

const convertChar = <T extends LyricCharacterPayload>(
  char: T,
  converted: ReadonlyMap<string, string>,
): T => ({
  ...char,
  text: convertText(char.text, converted) ?? '',
});

const convertRubyUnit = <T extends LyricRubyUnitPayload>(
  unit: T,
  converted: ReadonlyMap<string, string>,
): T => ({
  ...unit,
  text: convertText(unit.text, converted) ?? '',
  // ruby 是音译/注音读音，不参与简繁转换。
  ruby: unit.ruby,
  chars: (unit.chars ?? []).map((char) => convertChar(char, converted)),
});

export const applyLyricTextConversion = <T extends LyricLinePayload>(
  lines: readonly T[],
  converted: ReadonlyMap<string, string>,
): T[] =>
  lines.map((line) => ({
    ...line,
    text: convertText(line.text, converted) ?? '',
    translated: convertText(line.translated, converted),
    // romanized 是拉丁音译，不参与简繁转换。
    romanized: line.romanized,
    characters: (line.characters ?? []).map((char) => convertChar(char, converted)),
    translatedCharacters: line.translatedCharacters?.map((char) => convertChar(char, converted)),
    romanizedCharacters: line.romanizedCharacters
      ? line.romanizedCharacters.map((char) => ({ ...char }))
      : undefined,
    rubyUnits: line.rubyUnits?.map((unit) => convertRubyUnit(unit, converted)),
  })) as T[];
