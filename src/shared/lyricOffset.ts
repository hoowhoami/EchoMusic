/** Offsets advance lyric time when positive; each scope is limited to ±10 seconds. */
export function normalizeLyricOffsetMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.max(-10000, Math.min(10000, value)));
}
