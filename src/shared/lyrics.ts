export type LyricCharacterPayload = {
  text: string;
  startTime: number;
  endTime: number;
};

/**
 * 注音配对单元：主歌词片段 + 标注在其上方的音译读音。
 * 用于「音译逐字标注在每个字上方」的渲染模式。
 */
export type LyricRubyUnitPayload = {
  text: string;
  ruby: string;
  startTime: number;
  endTime: number;
  /** 该单元对应主歌词 characters 中的起始下标（含） */
  charStart: number;
  /** 该单元覆盖的主歌词字符 */
  chars: LyricCharacterPayload[];
};

export type LyricLinePayload = {
  time: number;
  text: string;
  translated?: string;
  romanized?: string;
  characters: LyricCharacterPayload[];
  translatedCharacters?: LyricCharacterPayload[];
  /** 音译逐字（独立副行模式下的音译逐字卡拉OK 数据） */
  romanizedCharacters?: LyricCharacterPayload[];
  rubyUnits?: LyricRubyUnitPayload[];
};

type RawChar = { text?: unknown; startTime?: unknown; endTime?: unknown };
type RawRubyUnit = {
  text?: unknown;
  ruby?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  charStart?: unknown;
  chars?: readonly RawChar[];
};
type RawLine = {
  time?: unknown;
  text?: unknown;
  translated?: unknown;
  romanized?: unknown;
  characters?: readonly RawChar[];
  translatedCharacters?: readonly RawChar[];
  romanizedCharacters?: readonly RawChar[];
  rubyUnits?: readonly RawRubyUnit[];
};

const normalizeChar = (char: RawChar): LyricCharacterPayload => ({
  text: String(char?.text ?? ''),
  startTime: Number(char?.startTime) || 0,
  endTime: Number(char?.endTime) || Number(char?.startTime) || 0,
});

/**
 * 把渲染进程的歌词行转换为可跨窗口传输的精简结构。
 * 三个子窗口（桌面歌词 / 迷你播放器 / 系统播放中心）共用，避免字段遗漏导致的行为不一致。
 */
export const normalizeLyricLinePayload = (line: RawLine): LyricLinePayload => {
  const rubyUnits = Array.isArray(line?.rubyUnits)
    ? line.rubyUnits.map((unit) => ({
        text: String(unit?.text ?? ''),
        ruby: String(unit?.ruby ?? ''),
        startTime: Number(unit?.startTime) || 0,
        endTime: Number(unit?.endTime) || Number(unit?.startTime) || 0,
        charStart: Number(unit?.charStart) || 0,
        chars: (unit?.chars ?? []).map(normalizeChar),
      }))
    : undefined;
  const translatedCharacters = Array.isArray(line?.translatedCharacters)
    ? line.translatedCharacters.map(normalizeChar)
    : undefined;
  const romanizedCharacters = Array.isArray(line?.romanizedCharacters)
    ? line.romanizedCharacters.map(normalizeChar)
    : undefined;

  return {
    time: Number(line?.time) || 0,
    text: String(line?.text ?? ''),
    translated: line?.translated ? String(line.translated) : undefined,
    romanized: line?.romanized ? String(line.romanized) : undefined,
    characters: (line?.characters ?? []).map(normalizeChar),
    ...(translatedCharacters?.length ? { translatedCharacters } : {}),
    ...(romanizedCharacters?.length ? { romanizedCharacters } : {}),
    ...(rubyUnits?.length ? { rubyUnits } : {}),
  };
};
