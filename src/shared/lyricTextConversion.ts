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
  if (typeof value !== 'string' || !/\p{Script=Han}/u.test(value)) return;
  texts.add(value);
};

const characterText = (chars: readonly LyricCharacterPayload[]) =>
  chars.map((char) => char.text).join('');

const rubyMatchesCharacters = (
  unit: LyricRubyUnitPayload,
  characters: readonly LyricCharacterPayload[],
) =>
  Number.isInteger(unit.charStart) &&
  unit.charStart >= 0 &&
  unit.chars.length > 0 &&
  unit.charStart + unit.chars.length <= characters.length &&
  unit.chars.every((char, index) => char.text === characters[unit.charStart + index].text);

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
      addText(texts, characterText(line.characters ?? []));
      addText(texts, characterText(line.translatedCharacters ?? []));
      for (const unit of line.rubyUnits ?? []) {
        const sourceText = characterText(unit.chars ?? []);
        if (!rubyMatchesCharacters(unit, line.characters ?? [])) addText(texts, sourceText);
        if (unit.text !== sourceText) addText(texts, unit.text);
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

const convertCharacters = <T extends LyricCharacterPayload>(
  chars: T[],
  converted: ReadonlyMap<string, string>,
): T[] => {
  const source = characterText(chars);
  const target = convertText(source, converted) ?? '';
  if (source === target) return chars;

  // Supported profiles preserve Unicode scalar count. Slice the contextual result
  // at the original segment boundaries, including multi-character/astral segments.
  const output = Array.from(target);
  if (Array.from(source).length !== output.length) {
    throw new Error('OpenCC conversion changed the lyric character count');
  }
  let offset = 0;
  return chars.map((char) => {
    const length = Array.from(char.text).length;
    const text = output.slice(offset, offset + length).join('');
    offset += length;
    return text === char.text ? char : { ...char, text };
  });
};

const convertRubyUnit = <T extends LyricRubyUnitPayload>(
  unit: T,
  sourceCharacters: LyricCharacterPayload[],
  characters: LyricCharacterPayload[],
  converted: ReadonlyMap<string, string>,
): T => {
  const chars = rubyMatchesCharacters(unit, sourceCharacters)
    ? characters.slice(unit.charStart, unit.charStart + unit.chars.length)
    : convertCharacters(unit.chars ?? [], converted);
  const text =
    unit.text === characterText(unit.chars ?? [])
      ? characterText(chars)
      : (convertText(unit.text, converted) ?? '');
  if (text === unit.text && chars.every((char, index) => char === unit.chars[index])) return unit;
  // ruby annotations and all timing fields stay attached to their source segments.
  return { ...unit, text, chars };
};

export const applyLyricTextConversion = <T extends LyricLinePayload>(
  lines: readonly T[],
  converted: ReadonlyMap<string, string>,
): T[] =>
  lines.map((line) => {
    const characters = convertCharacters(line.characters ?? [], converted);
    const text = convertText(line.text, converted) ?? '';
    const translated = convertText(line.translated, converted);
    const translatedCharacters = line.translatedCharacters
      ? convertCharacters(line.translatedCharacters, converted)
      : undefined;
    let rubyUnits = line.rubyUnits?.map((unit) =>
      convertRubyUnit(unit, line.characters ?? [], characters, converted),
    );
    if (rubyUnits?.every((unit, index) => unit === line.rubyUnits?.[index])) {
      rubyUnits = line.rubyUnits;
    }
    if (
      text === line.text &&
      translated === line.translated &&
      characters === line.characters &&
      translatedCharacters === line.translatedCharacters &&
      rubyUnits === line.rubyUnits
    )
      return line;
    return {
      ...line,
      text,
      translated,
      characters,
      translatedCharacters,
      rubyUnits,
    };
  }) as T[];
