import { testLyricFilter } from '@/stores/lyric';

export type LyricFilterConfig = {
  enabled: boolean;
  pattern: string;
};

export type FilterableLyricLine = {
  text: string;
};

export type FilteredLyricEntry<T extends FilterableLyricLine> = {
  line: T;
  index: number;
  filtered: boolean;
};

export const isLyricLineFiltered = (
  line: FilterableLyricLine | null | undefined,
  config: LyricFilterConfig,
) => testLyricFilter(line?.text ?? '', config.enabled, config.pattern);

export const resolveVisibleLyricIndex = <T extends FilterableLyricLine>(
  lines: T[],
  index: number,
  config: LyricFilterConfig,
) => {
  if (index < 0) return index;
  if (!isLyricLineFiltered(lines[index], config)) return index;

  for (let i = index - 1; i >= 0; i--) {
    if (!isLyricLineFiltered(lines[i], config)) return i;
  }

  return -1;
};

export const findNextVisibleLyricIndex = <T extends FilterableLyricLine>(
  lines: T[],
  index: number,
  config: LyricFilterConfig,
) => {
  for (let i = Math.max(0, index + 1); i < lines.length; i++) {
    if (!isLyricLineFiltered(lines[i], config)) return i;
  }

  return -1;
};

export const buildFilteredLyricEntries = <T extends FilterableLyricLine>(
  lines: T[],
  config: LyricFilterConfig,
): FilteredLyricEntry<T>[] =>
  lines.map((line, index) => ({
    line,
    index,
    filtered: isLyricLineFiltered(line, config),
  }));
