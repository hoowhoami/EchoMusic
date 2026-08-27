export interface TrackLoudness {
  /** Integrated track loudness in LUFS. */
  lufs: number;
  /** Upstream metadata retained for diagnostics; it is not added to the LUFS target delta. */
  gain: number;
  /** Sample/true peak in dBFS/dBTP. Null when the source does not provide it. */
  peak: number | null;
}

export const DEFAULT_REFERENCE_LUFS = -14;
export const NORMALIZATION_PEAK_CEILING_DB = -0.5;

const MIN_TRACK_LUFS = -70;
const MAX_TRACK_LUFS = 0;
const MIN_TRACK_GAIN_DB = -24;
const MAX_TRACK_GAIN_DB = 24;
const MIN_TRACK_PEAK_DB = -120;
const MAX_TRACK_PEAK_DB = 24;
const MIN_NORMALIZATION_GAIN_DB = -40;
const MAX_NORMALIZATION_GAIN_DB = 20 * Math.log10(3);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Extract Kugou-compatible loudness metadata without assuming a linear peak value. */
export const resolveTrackLoudness = (payload: unknown): TrackLoudness | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const source = isFiniteNumber(record.volume)
    ? record
    : typeof record.data === 'object' && record.data !== null
      ? (record.data as Record<string, unknown>)
      : null;
  if (!source || !isFiniteNumber(source.volume)) return null;

  const lufs = source.volume;
  const gain = isFiniteNumber(source.volume_gain)
    ? source.volume_gain
    : isFiniteNumber(source.volumeGain)
      ? source.volumeGain
      : 0;
  const rawPeak = isFiniteNumber(source.volume_peak)
    ? source.volume_peak
    : isFiniteNumber(source.volumePeak)
      ? source.volumePeak
      : null;

  if (lufs <= MIN_TRACK_LUFS || lufs >= MAX_TRACK_LUFS) return null;
  if (gain < MIN_TRACK_GAIN_DB || gain > MAX_TRACK_GAIN_DB) return null;
  if (rawPeak !== null && (rawPeak < MIN_TRACK_PEAK_DB || rawPeak > MAX_TRACK_PEAK_DB)) return null;
  return { lufs, gain, peak: rawPeak };
};

/** Calculate the gain needed to reach the target while keeping the reported peak below ceiling. */
export const calculateNormalizationGainDb = (
  loudness: TrackLoudness,
  referenceLufs = DEFAULT_REFERENCE_LUFS,
): number => {
  const normalizedReference = clamp(referenceLufs, -20, -8);
  let gainDb = normalizedReference - loudness.lufs;
  if (loudness.peak !== null && Number.isFinite(loudness.peak)) {
    gainDb = Math.min(gainDb, NORMALIZATION_PEAK_CEILING_DB - loudness.peak);
  }
  return clamp(gainDb, MIN_NORMALIZATION_GAIN_DB, MAX_NORMALIZATION_GAIN_DB);
};
