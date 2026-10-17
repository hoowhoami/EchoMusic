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
  /**
   * characters 是否为估算而来（源歌词没有逐字时间戳）。所有歌词表面据此放弃
   * 逐字着色，直接整行显示。
   */
  charactersEstimated?: boolean;
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
  charactersEstimated?: unknown;
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
    ...(line?.charactersEstimated ? { charactersEstimated: true } : {}),
    ...(translatedCharacters?.length ? { translatedCharacters } : {}),
    ...(romanizedCharacters?.length ? { romanizedCharacters } : {}),
    ...(rubyUnits?.length ? { rubyUnits } : {}),
  };
};

/**
 * 该行是否带有真实的逐字时间戳。
 *
 * 源歌词只有行级时间戳时，解析层会按行时长均分（或整行套固定时长）凑出 characters。
 * 那些时间轴是猜的：着色进度与真实演唱毫无关系，逐字高亮反而在误导。对这类行应当
 * 整行直显，而不是拿估算值做卡拉OK 效果。
 *
 * 任务栏歌词、mini 歌词、主歌词页、桌面歌词共用此判定，避免各处各写一套而逐渐跑偏。
 */
export const hasWordByWordTiming = (
  line: Pick<LyricLinePayload, 'characters' | 'charactersEstimated'> | null | undefined,
): boolean => {
  if (!line || line.charactersEstimated) return false;
  // 清洗层在缺 characters 时会补一个 endTime 为 0 的占位字符，不能当作逐字数据。
  return (line.characters ?? []).some((char) => char.endTime > char.startTime);
};
