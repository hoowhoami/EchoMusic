import logger from '@/utils/logger';
import { toRaw } from 'vue';
import {
  applyLyricTextConversion,
  buildLyricTextConversionRequest,
} from '../../shared/lyricTextConversion';
import type { LyricLinePayload } from '../../shared/lyrics';
import {
  normalizeLyricTextConversionMode,
  resolveOpenccProfile,
  type LyricTextConversionMode,
  type OpenccProfile,
} from '../../shared/opencc';

const CACHE_MAX_ENTRIES = 4096;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const conversionCache = new Map<string, string>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<string>>();
// At most four profiles per source; old lyric arrays and their results can be collected.
const displayCache = new WeakMap<
  readonly LyricLinePayload[],
  Map<OpenccProfile, Promise<LyricLinePayload[]>>
>();
let warnedUnavailable = false;

const getCacheKey = (profile: OpenccProfile, text: string) => `${profile}\u001f${text}`;
const entryBytes = (key: string, value: string) => (key.length + value.length) * 2;

const readCached = (key: string): string | undefined => {
  const value = conversionCache.get(key);
  if (value !== undefined) {
    conversionCache.delete(key);
    conversionCache.set(key, value);
  }
  return value;
};

const rememberConverted = (key: string, value: string) => {
  const bytes = entryBytes(key, value);
  if (bytes > CACHE_MAX_BYTES) return;
  const previous = conversionCache.get(key);
  if (previous !== undefined) {
    cacheBytes -= entryBytes(key, previous);
    conversionCache.delete(key);
  }
  conversionCache.set(key, value);
  cacheBytes += bytes;
  while (conversionCache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = conversionCache.entries().next().value;
    if (!oldest) break;
    cacheBytes -= entryBytes(oldest[0], oldest[1]);
    conversionCache.delete(oldest[0]);
  }
};

const convertBatch = async (texts: string[], profile: OpenccProfile): Promise<string[]> => {
  const api = window.electron?.opencc;
  if (!api) throw new Error('OpenCC native bridge is unavailable');
  const output = await api.convertBatch(texts, profile);
  // Supported profiles preserve scalar count, keeping timed segment boundaries intact.
  if (
    !Array.isArray(output) ||
    output.length !== texts.length ||
    output.some(
      (text, index) =>
        typeof text !== 'string' || Array.from(text).length !== Array.from(texts[index]).length,
    )
  )
    throw new Error('OpenCC returned an invalid conversion batch');
  return output;
};

const convertSource = async <T extends LyricLinePayload>(
  source: readonly T[],
  mode: LyricTextConversionMode,
  profile: OpenccProfile,
): Promise<T[]> => {
  const request = buildLyricTextConversionRequest(source, mode);
  if (request.texts.length === 0) return source as T[];
  const pending = new Map<string, string | Promise<string>>();
  const missing: string[] = [];
  for (const text of request.texts) {
    const key = getCacheKey(profile, text);
    const existing = readCached(key) ?? inFlight.get(key);
    if (existing !== undefined) pending.set(text, existing);
    else missing.push(text);
  }
  if (missing.length > 0) {
    const batch = convertBatch(missing, profile);
    missing.forEach((text, index) => {
      const key = getCacheKey(profile, text);
      const task = batch
        .then((output) => {
          rememberConverted(key, output[index]);
          return output[index];
        })
        .finally(() => {
          if (inFlight.get(key) === task) inFlight.delete(key);
        });
      inFlight.set(key, task);
      pending.set(text, task);
    });
  }
  const results = await Promise.all(request.texts.map((text) => pending.get(text)!));
  const converted = new Map(request.texts.map((text, index) => [text, results[index]]));
  const output = applyLyricTextConversion(source, converted);
  return output.every((line, index) => line === source[index]) ? (source as T[]) : output;
};

export const convertLyricLinesForDisplay = async <T extends LyricLinePayload>(
  lines: readonly T[],
  mode: LyricTextConversionMode,
): Promise<T[]> => {
  // Conversion reads a plain source snapshot, without tracking nested timing properties.
  const source = toRaw(lines);
  const normalizedMode = normalizeLyricTextConversionMode(mode);
  const profile = resolveOpenccProfile(normalizedMode);
  if (!profile) return source as T[];

  let profiles = displayCache.get(source);
  const cached = profiles?.get(profile);
  if (cached) return cached as Promise<T[]>;
  if (!profiles) {
    profiles = new Map();
    displayCache.set(source, profiles);
  }
  const result = convertSource(source, normalizedMode, profile).catch((error) => {
    // Failure must be retryable, rather than retained as a successful original-text result.
    profiles.delete(profile);
    if (window.electron?.opencc || !warnedUnavailable) {
      warnedUnavailable = !window.electron?.opencc;
      logger.warn('OpenCC', 'OpenCC conversion failed; lyric text stays unchanged', error);
    }
    return source as T[];
  });
  profiles.set(profile, result);
  return result;
};
