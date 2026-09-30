import logger from '@/utils/logger';
import {
  applyLyricTextConversion,
  buildLyricTextConversionRequest,
} from '../../shared/lyricTextConversion';
import type { LyricLinePayload } from '../../shared/lyrics';
import type { LyricTextConversionMode, OpenccProfile } from '../../shared/opencc';

const conversionCache = new Map<string, string>();
let warnedUnavailable = false;

const getCacheKey = (profile: OpenccProfile, text: string) => `${profile}\u001f${text}`;

const convertBatch = async (texts: string[], profile: OpenccProfile): Promise<string[]> => {
  if (texts.length === 0) return [];
  const api = window.electron?.opencc;
  if (!api) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      logger.warn('OpenCC', 'OpenCC native bridge is unavailable; lyric text stays unchanged');
    }
    return texts;
  }
  try {
    return await api.convertBatch(texts, profile);
  } catch (error) {
    logger.warn('OpenCC', 'OpenCC conversion failed; lyric text stays unchanged', error);
    return texts;
  }
};

export const convertLyricLinesForDisplay = async <T extends LyricLinePayload>(
  lines: readonly T[],
  mode: LyricTextConversionMode,
): Promise<T[]> => {
  const request = buildLyricTextConversionRequest(lines, mode);
  if (!request.profile) return lines.map((line) => ({ ...line })) as T[];

  const missing = request.texts.filter(
    (text) => !conversionCache.has(getCacheKey(request.profile!, text)),
  );
  const convertedMissing = await convertBatch(missing, request.profile);
  missing.forEach((text, index) => {
    conversionCache.set(getCacheKey(request.profile!, text), convertedMissing[index] ?? text);
  });

  const converted = new Map<string, string>();
  request.texts.forEach((text) => {
    converted.set(text, conversionCache.get(getCacheKey(request.profile!, text)) ?? text);
  });
  return applyLyricTextConversion(lines, converted);
};
