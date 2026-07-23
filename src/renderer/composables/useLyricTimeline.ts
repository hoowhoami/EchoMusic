import type { LyricLinePayload } from '../../shared/lyrics';
import type { PlaybackClockSnapshot } from '../../shared/playback';

export interface LyricTimelinePlayback {
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  playbackRate?: number;
  updatedAt?: number;
  seekTimestamp?: number;
  clock?: PlaybackClockSnapshot;
}

export interface LyricTimelineOptions {
  clockSyncToleranceMs?: number;
  recentSeekWindowMs?: number;
  playbackStaleThresholdMs?: number;
  backwardResyncThresholdMs?: number;
  snapshotDelayCompensationMs?: number;
  backwardDriftCorrectionRatio?: number;
}

const DEFAULT_CLOCK_SYNC_TOLERANCE_MS = 300;
const DEFAULT_RECENT_SEEK_WINDOW_MS = 800;
const DEFAULT_PLAYBACK_STALE_THRESHOLD_MS = 1800;
const DEFAULT_BACKWARD_RESYNC_THRESHOLD_MS = 1500;
const DEFAULT_SNAPSHOT_DELAY_COMPENSATION_MS = 1000;
const DEFAULT_BACKWARD_DRIFT_CORRECTION_RATIO = 0.35;

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

// Engine time remains the source of truth. This helper only interpolates between fresh
// engine samples so lyric animation can stay smooth without drifting through stalls.
export function createLyricTimeline(options: LyricTimelineOptions = {}) {
  const clockSyncToleranceMs = options.clockSyncToleranceMs ?? DEFAULT_CLOCK_SYNC_TOLERANCE_MS;
  const recentSeekWindowMs = options.recentSeekWindowMs ?? DEFAULT_RECENT_SEEK_WINDOW_MS;
  const playbackStaleThresholdMs =
    options.playbackStaleThresholdMs ?? DEFAULT_PLAYBACK_STALE_THRESHOLD_MS;
  const backwardResyncThresholdMs =
    options.backwardResyncThresholdMs ?? DEFAULT_BACKWARD_RESYNC_THRESHOLD_MS;
  const snapshotDelayCompensationMs =
    options.snapshotDelayCompensationMs ?? DEFAULT_SNAPSHOT_DELAY_COMPENSATION_MS;
  const backwardDriftCorrectionRatio = clamp(
    options.backwardDriftCorrectionRatio ?? DEFAULT_BACKWARD_DRIFT_CORRECTION_RATIO,
    0,
    1,
  );

  let baseMs = 0;
  let anchorTick = performance.now();
  let lastPlaybackUpdateTick = 0;
  let lastObservedSampleKey = '';

  const getRate = (playback: LyricTimelinePlayback | null | undefined) => {
    const rate = Number(playback?.clock?.playbackRate ?? playback?.playbackRate ?? 1);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  };

  const readPlaybackSample = (playback: LyricTimelinePlayback | null | undefined) => {
    if (!playback) return { ms: 0, freshWallSample: false };
    const clock = playback.clock;
    if (clock) {
      return {
        ms: Math.max(0, Math.round(Number(clock.positionMs) || 0)),
        freshWallSample: true,
      };
    }

    const rawMs = Math.max(0, Math.round(Number(playback.currentTime || 0) * 1000));
    const updatedAt = Number(playback.updatedAt || 0);
    if (!playback.isPlaying || !updatedAt) return { ms: rawMs, freshWallSample: false };

    const wallDelay = Date.now() - updatedAt;
    if (wallDelay <= 0 || wallDelay > snapshotDelayCompensationMs) {
      return { ms: rawMs, freshWallSample: false };
    }
    return {
      ms: rawMs + Math.round(wallDelay * getRate(playback)),
      freshWallSample: true,
    };
  };

  const sync = (playback: LyricTimelinePlayback | null | undefined, force = false) => {
    const now = performance.now();
    const sample = readPlaybackSample(playback);
    const nextBaseMs = sample.ms;
    const sampleIsPlaying = playback?.clock?.isPlaying ?? playback?.isPlaying ?? false;
    const sampleKey = [
      playback?.clock?.trackId ?? '',
      Number(playback?.clock?.positionMs ?? 0),
      Number(playback?.clock?.durationMs ?? 0),
      Number(playback?.clock?.generation ?? 0),
      Number(playback?.currentTime ?? 0),
      Number(playback?.updatedAt ?? 0),
      sampleIsPlaying ? 1 : 0,
      getRate(playback),
      Number(playback?.clock?.seekTimestamp ?? playback?.seekTimestamp ?? 0),
    ].join('|');
    const hasFreshEngineSample = force || sampleKey !== lastObservedSampleKey;
    if (hasFreshEngineSample) {
      lastPlaybackUpdateTick = now;
      lastObservedSampleKey = sampleKey;
    } else {
      return;
    }

    if (sampleIsPlaying && !force) {
      const predictedMs = baseMs + (now - anchorTick) * getRate(playback);
      const driftMs = nextBaseMs - predictedMs;
      const seekTimestamp = Number(playback?.clock?.seekTimestamp ?? playback?.seekTimestamp ?? 0);
      const recentSeek = seekTimestamp > 0 && Date.now() - seekTimestamp < recentSeekWindowMs;

      if (!recentSeek) {
        if (Math.abs(driftMs) < clockSyncToleranceMs) return;
        if (driftMs < 0 && -driftMs < backwardResyncThresholdMs) {
          if (sample.freshWallSample && backwardDriftCorrectionRatio > 0) {
            baseMs = Math.max(0, predictedMs + driftMs * backwardDriftCorrectionRatio);
            anchorTick = now;
          }
          return;
        }
      }
    }

    baseMs = nextBaseMs;
    anchorTick = now;
  };

  const getPlaybackMs = (playback: LyricTimelinePlayback | null | undefined) => {
    if (!playback) return 0;
    const now = performance.now();
    const fresh = now - lastPlaybackUpdateTick <= playbackStaleThresholdMs;
    const isPlaying = playback.clock?.isPlaying ?? playback.isPlaying;
    const value = isPlaying && fresh ? baseMs + (now - anchorTick) * getRate(playback) : baseMs;
    const durationMs = playback.clock
      ? Math.max(0, Number(playback.clock.durationMs || 0))
      : Math.max(0, Number(playback.duration || 0) * 1000);
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
  };
}
