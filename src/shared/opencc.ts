export type OpenccProfile = 's2t' | 't2s' | 's2tw' | 's2hk';

export type LyricTextConversionMode =
  'none' | 'simplified' | 'traditional' | 'traditional-tw' | 'traditional-hk';

export const LYRIC_TEXT_CONVERSION_MODES: readonly LyricTextConversionMode[] = [
  'none',
  'simplified',
  'traditional',
  'traditional-tw',
  'traditional-hk',
];

const MODE_TO_PROFILE: Record<Exclude<LyricTextConversionMode, 'none'>, OpenccProfile> = {
  simplified: 't2s',
  traditional: 's2t',
  'traditional-tw': 's2tw',
  'traditional-hk': 's2hk',
};

export const normalizeLyricTextConversionMode = (value: unknown): LyricTextConversionMode => {
  return typeof value === 'string' &&
    LYRIC_TEXT_CONVERSION_MODES.includes(value as LyricTextConversionMode)
    ? (value as LyricTextConversionMode)
    : 'none';
};

export const resolveOpenccProfile = (mode: LyricTextConversionMode): OpenccProfile | null => {
  if (mode === 'none') return null;
  return MODE_TO_PROFILE[mode];
};

export const isOpenccProfile = (value: unknown): value is OpenccProfile =>
  value === 's2t' || value === 't2s' || value === 's2tw' || value === 's2hk';
