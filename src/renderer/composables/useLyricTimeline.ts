import type { LyricLinePayload } from '../../shared/lyrics';
import type { PlaybackClockSnapshot } from '../../shared/playback';

export interface LyricTimelinePlayback {
  trackId?: string | null;
  trackSeq?: number;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  playbackRate?: number;
  updatedAt?: number;
  seekTimestamp?: number;
  clock?: PlaybackClockSnapshot;
}

export interface LyricTimelineOptions {
  playbackStaleThresholdMs?: number;
}

const DEFAULT_PLAYBACK_STALE_THRESHOLD_MS = 1800;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readLineStartMs = (line: Pick<LyricLinePayload, 'time' | 'characters'>) =>
  line.characters?.[0]?.startTime ?? Math.round((Number(line.time) || 0) * 1000);

export const findLyricIndexAtTimeMs = (
  lines: Array<Pick<LyricLinePayload, 'time' | 'characters'>>,
  currentTimeMs: number,
): number => {
  if (lines.length === 0) return -1;

  let nextIndex = -1;
  let low = 0;
  let high = lines.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = readLineStartMs(lines[mid]);
    if (currentTimeMs >= start) {
      nextIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return nextIndex;
};

export const computeLyricCharProgress = (
  charStartMs: number,
  charEndMs: number,
  timelineMs: number,
) => {
  if (timelineMs >= charEndMs) return 1;
  if (timelineMs <= charStartMs) return 0;
  const duration = charEndMs - charStartMs;
  if (duration <= 0) return 1;
  return clamp((timelineMs - charStartMs) / duration, 0, 1);
};

export const computeLyricCharBackgroundPosition = (
  charStartMs: number,
  charEndMs: number,
  timelineMs: number,
) => `${100 - computeLyricCharProgress(charStartMs, charEndMs, timelineMs) * 100}%`;

// Synchronize on immutable source samples, then interpolate only until their freshness
// deadline. Animation frames and re-sent IPC snapshots are not new engine samples.
export function createLyricTimeline(options: LyricTimelineOptions = {}) {
  const staleMs = options.playbackStaleThresholdMs ?? DEFAULT_PLAYBACK_STALE_THRESHOLD_MS;
  let sampleKey = '';
  let transportKey = '';
  let positionMs = 0;
  let anchorTick = 0;
  let deadlineTick = 0;
  let rate = 1;
  let advancing = false;
  let revision = 0;

  const project = (now: number) =>
    positionMs + (advancing ? Math.max(0, Math.min(now, deadlineTick) - anchorTick) * rate : 0);

  const sync = (playback: LyricTimelinePlayback | null | undefined, force = false) => {
    const clock = playback?.clock;
    const nextPosition = Math.max(
      0,
      Number(clock?.positionMs ?? (playback?.currentTime ?? 0) * 1000) || 0,
    );
    const nextRate = Number(clock?.playbackRate ?? playback?.playbackRate ?? 1);
    const nextPlaying = Boolean(clock?.isPlaying ?? playback?.isPlaying);
    const nextAdvancing = nextPlaying && (clock?.isAdvancing ?? true);
    const sampledAt = Number(clock?.sampledAt ?? playback?.updatedAt ?? 0);
    const nextTransportKey = [
      clock?.trackId ?? playback?.trackId ?? '',
      clock?.trackSeq ?? playback?.trackSeq ?? 0,
      clock?.generation ?? playback?.seekTimestamp ?? 0,
      clock?.seekTimestamp ?? playback?.seekTimestamp ?? 0,
      nextPlaying,
      nextAdvancing,
      nextRate,
    ].join('|');
    const nextSampleKey = [nextTransportKey, nextPosition, sampledAt].join('|');
    if (!force && nextSampleKey === sampleKey) return;

    const now = performance.now();
    const transportChanged = nextTransportKey !== transportKey;
    const age = sampledAt > 0 ? Math.max(0, Date.now() - sampledAt) : 0;
    const nextAge = Math.min(age, staleMs);
    const safeRate = Number.isFinite(nextRate) && nextRate > 0 ? nextRate : 1;
    const projectedPosition = nextPosition + (nextAdvancing ? nextAge * safeRate : 0);
    if (force || transportChanged || Math.abs(projectedPosition - project(now)) > 750) {
      revision += 1;
    }
    sampleKey = nextSampleKey;
    transportKey = nextTransportKey;
    positionMs = projectedPosition;
    anchorTick = now;
    deadlineTick = now + Math.max(0, staleMs - age);
    rate = safeRate;
    advancing = nextAdvancing;
  };

  const getPlaybackMs = (playback: LyricTimelinePlayback | null | undefined) => {
    sync(playback);
    if (!playback) return 0;
    const value = project(performance.now());
    const durationMs = playback.clock?.durationMs ?? (playback.duration ?? 0) * 1000;
    return durationMs > 0 ? clamp(value, 0, durationMs) : Math.max(0, value);
  };

  const getTimelineMs = (
    playback: LyricTimelinePlayback | null | undefined,
    lyricOffsetMs = 0,
    lookaheadMs = 0,
  ) => Math.round(getPlaybackMs(playback) + lyricOffsetMs + lookaheadMs);

  const findIndex = (
    lines: Array<Pick<LyricLinePayload, 'time' | 'characters'>>,
    playback: LyricTimelinePlayback | null | undefined,
    lyricOffsetMs = 0,
    lookaheadMs = 0,
  ) => findLyricIndexAtTimeMs(lines, getTimelineMs(playback, lyricOffsetMs, lookaheadMs));

  return {
    sync,
    getPlaybackMs,
    getTimelineMs,
    findIndex,
    get revision() {
      return revision;
    },
  };
}
