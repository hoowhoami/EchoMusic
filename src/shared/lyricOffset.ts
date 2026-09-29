const TRACK_LYRIC_OFFSET_LIMIT_MS = 20_000;
const GLOBAL_LYRIC_OFFSET_LIMIT_MS = 20_000;

const normalizeOffsetMs = (value: unknown, limitMs: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.max(-limitMs, Math.min(limitMs, value)));
};

/** Per-track offsets advance lyric time when positive and are limited to ±20 seconds. */
export function normalizeLyricOffsetMs(value: unknown): number {
  return normalizeOffsetMs(value, TRACK_LYRIC_OFFSET_LIMIT_MS);
}

/** Global calibration advances lyric time when positive and is limited to ±20 seconds. */
export function normalizeGlobalLyricOffsetMs(value: unknown): number {
  return normalizeOffsetMs(value, GLOBAL_LYRIC_OFFSET_LIMIT_MS);
}
