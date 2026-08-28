export type PlayMode = 'sequential' | 'list' | 'random' | 'single';

export type PlaybackProgressBusyReason = 'seek' | 'buffering' | null;

/** User volume percentage. 100 is the source level; values above 100 are not used by the UI. */
export const DEFAULT_PLAYER_VOLUME = 50;

export type PlaybackClockReason =
  | 'tick'
  | 'seek'
  | 'load'
  | 'play'
  | 'pause'
  | 'gapless'
  | 'recover';

export interface PlaybackClockSnapshot {
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  isPlaying: boolean;
  generation: number;
  seekTimestamp?: number;
  sampledAt?: number;
  reason?: PlaybackClockReason;
}

export interface PlaybackClockSource {
  trackId?: string | number | null;
  currentTime?: number | null;
  duration?: number | null;
  playbackRate?: number | null;
  isPlaying?: boolean | null;
  seekTimestamp?: number | null;
  updatedAt?: number | null;
  reason?: PlaybackClockReason;
}

const MAX_PLAYBACK_CLOCK_PROJECTION_MS = 1000;
const DEFAULT_PLAYBACK_REGRESSION_TOLERANCE_MS = 1200;
const DEFAULT_PLAYBACK_SAMPLE_GRACE_MS = 500;
const DEFAULT_PLAYBACK_BRIDGE_TIMEOUT_MS = 5000;
const DEFAULT_PLAYBACK_BRIDGE_RENDERER_SAMPLE_GRACE_MS = 500;

const finiteNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const normalizePlaybackRate = (value: unknown) => {
  const rate = finiteNumber(value, 1);
  return rate > 0 ? rate : 1;
};

export const buildPlaybackClockSnapshot = (source: PlaybackClockSource): PlaybackClockSnapshot => {
  const seekTimestamp = finiteNumber(source.seekTimestamp, 0);
  const sampledAt = finiteNumber(source.updatedAt, 0);
  const generation = seekTimestamp || 0;
  const playbackRate = normalizePlaybackRate(source.playbackRate);
  const isPlaying = Boolean(source.isPlaying);
  const rawPositionMs = Math.max(0, Math.round(finiteNumber(source.currentTime, 0) * 1000));
  const projectedMs =
    isPlaying && sampledAt > 0
      ? Math.round(
          clamp(Date.now() - sampledAt, 0, MAX_PLAYBACK_CLOCK_PROJECTION_MS) * playbackRate,
        )
      : 0;

  return {
    trackId:
      source.trackId !== undefined && source.trackId !== null ? String(source.trackId) : null,
    positionMs: rawPositionMs + projectedMs,
    durationMs: Math.max(0, Math.round(finiteNumber(source.duration, 0) * 1000)),
    playbackRate,
    isPlaying,
    generation,
    ...(seekTimestamp > 0 ? { seekTimestamp } : {}),
    ...(sampledAt > 0 ? { sampledAt } : {}),
    ...(source.reason ? { reason: source.reason } : {}),
  };
};

export interface PlaybackSnapshotLike {
  trackId?: string | null;
  trackSeq?: number | null;
  currentTime?: number | null;
  duration?: number | null;
  isPlaying?: boolean | null;
  playbackRate?: number | null;
  updatedAt?: number | null;
  seekTimestamp?: number | null;
  clock?: PlaybackClockSnapshot;
}

export interface PlaybackSnapshotPatch {
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  playbackRate?: number;
  seekTimestamp?: number;
  reason?: PlaybackClockReason;
  trackSeq?: number;
}

export interface PlaybackBridgeState {
  trackSeq: number | null;
  awaitingRenderer: boolean;
  transitionAt: number;
}

export const createPlaybackBridgeState = (): PlaybackBridgeState => ({
  trackSeq: null,
  awaitingRenderer: false,
  transitionAt: 0,
});

export const readPlaybackSnapshotPositionMs = (
  playback: PlaybackSnapshotLike | null | undefined,
) => {
  const clockPosition = finiteNumber(playback?.clock?.positionMs, Number.NaN);
  if (Number.isFinite(clockPosition) && clockPosition >= 0) return clockPosition;
  return Math.max(0, Math.round(finiteNumber(playback?.currentTime, 0) * 1000));
};

export const readPlaybackSnapshotUpdatedAt = (
  playback: PlaybackSnapshotLike | null | undefined,
) => {
  const sampledAt = finiteNumber(playback?.clock?.sampledAt, 0);
  if (sampledAt > 0) return sampledAt;
  const updatedAt = finiteNumber(playback?.updatedAt, 0);
  return updatedAt > 0 ? updatedAt : 0;
};

export const shouldAcceptPlaybackSnapshot = <T extends PlaybackSnapshotLike>(
  next: T | null,
  current: T | null,
  options: {
    isSamePlayback?: (next: T, current: T) => boolean;
    regressionToleranceMs?: number;
    sampleGraceMs?: number;
  } = {},
) => {
  if (!next || !current) return true;
  const nextTrackSeq = finiteNumber(next.trackSeq, 0);
  const currentTrackSeq = finiteNumber(current.trackSeq, 0);
  const isSamePlayback =
    options.isSamePlayback?.(next, current) ??
    (nextTrackSeq > 0 && currentTrackSeq > 0
      ? nextTrackSeq === currentTrackSeq
      : next.trackId === current.trackId);
  if (!isSamePlayback) return true;
  if (Boolean(next.isPlaying) !== Boolean(current.isPlaying)) return true;

  const nextSeekTimestamp = finiteNumber(next.seekTimestamp || next.clock?.seekTimestamp, 0);
  const currentSeekTimestamp = finiteNumber(
    current.seekTimestamp || current.clock?.seekTimestamp,
    0,
  );
  if (nextSeekTimestamp !== currentSeekTimestamp) return true;

  const nextUpdatedAt = readPlaybackSnapshotUpdatedAt(next);
  const currentUpdatedAt = readPlaybackSnapshotUpdatedAt(current);
  const nextPositionMs = readPlaybackSnapshotPositionMs(next);
  const currentPositionMs = readPlaybackSnapshotPositionMs(current);
  const regressionToleranceMs =
    options.regressionToleranceMs ?? DEFAULT_PLAYBACK_REGRESSION_TOLERANCE_MS;
  const sampleGraceMs = options.sampleGraceMs ?? DEFAULT_PLAYBACK_SAMPLE_GRACE_MS;
  const isRegression = nextPositionMs + regressionToleranceMs < currentPositionMs;
  const isOlderSample =
    nextUpdatedAt > 0 && currentUpdatedAt > 0 && nextUpdatedAt + sampleGraceMs < currentUpdatedAt;

  return !(Boolean(next.isPlaying) && Boolean(current.isPlaying) && isRegression && isOlderSample);
};

export const isSamePlaybackSnapshot = <T extends PlaybackSnapshotLike>(
  next: T | null | undefined,
  current: T | null | undefined,
  fallback?: (next: T, current: T) => boolean,
) => {
  if (!next || !current) return false;
  const nextTrackSeq = finiteNumber(next.trackSeq, 0);
  const currentTrackSeq = finiteNumber(current.trackSeq, 0);
  if (nextTrackSeq > 0 && currentTrackSeq > 0) return nextTrackSeq === currentTrackSeq;
  return fallback ? fallback(next, current) : next.trackId === current.trackId;
};

export const beginPlaybackBridgeTransition = (state: PlaybackBridgeState, trackSeq?: number) => {
  const seq = finiteNumber(trackSeq, 0);
  if (seq > 0 && state.awaitingRenderer && state.trackSeq === seq) return;
  if (seq > 0) state.trackSeq = seq;
  state.awaitingRenderer = true;
  state.transitionAt = Date.now();
};

export const acceptPlaybackBridgeRendererPayload = <T extends PlaybackSnapshotLike>(
  state: PlaybackBridgeState,
  playback: T | null,
  options: {
    now?: number;
    timeoutMs?: number;
    sampleGraceMs?: number;
  } = {},
) => {
  if (!state.awaitingRenderer || !playback) return true;
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLAYBACK_BRIDGE_TIMEOUT_MS;
  if (state.transitionAt > 0 && now - state.transitionAt >= timeoutMs) {
    state.awaitingRenderer = false;
    return true;
  }

  const trackSeq = finiteNumber(playback.trackSeq, 0);
  if (state.trackSeq !== null && trackSeq > 0 && trackSeq === state.trackSeq) return true;

  const sampleGraceMs = options.sampleGraceMs ?? DEFAULT_PLAYBACK_BRIDGE_RENDERER_SAMPLE_GRACE_MS;
  const updatedAt = readPlaybackSnapshotUpdatedAt(playback);
  return updatedAt === 0 || updatedAt + sampleGraceMs >= state.transitionAt;
};

export const shouldApplyPlaybackBridgePatch = <T extends PlaybackSnapshotLike>(
  state: PlaybackBridgeState,
  current: T,
  patch: PlaybackSnapshotPatch,
  options: {
    now?: number;
    timeoutMs?: number;
  } = {},
) => {
  const seq = finiteNumber(patch.trackSeq, 0);
  const currentSeq = finiteNumber(current.trackSeq, 0);
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLAYBACK_BRIDGE_TIMEOUT_MS;
  const isExpired = state.transitionAt > 0 && now - state.transitionAt >= timeoutMs;

  if (seq > 0 && currentSeq > 0 && seq !== currentSeq) {
    if (state.trackSeq === seq && isExpired) {
      // Stop waiting for a renderer confirmation, but never apply a cross-track patch.
      state.awaitingRenderer = false;
      return false;
    }
    beginPlaybackBridgeTransition(state, seq);
    return false;
  }
  if (!state.awaitingRenderer) return true;
  if (isExpired) {
    state.awaitingRenderer = false;
    return true;
  }

  if (seq > 0 && currentSeq > 0 && seq === currentSeq) {
    state.awaitingRenderer = false;
    state.trackSeq = seq;
    return true;
  }
  return false;
};

export const patchPlaybackSnapshot = <T extends PlaybackSnapshotLike & { trackId: string }>(
  current: T,
  patch: PlaybackSnapshotPatch,
): T => {
  const currentTime = Number.isFinite(Number(patch.currentTime))
    ? Math.max(0, Number(patch.currentTime))
    : finiteNumber(current.currentTime, 0);
  const duration =
    Number.isFinite(Number(patch.duration)) && Number(patch.duration) > 0
      ? Number(patch.duration)
      : finiteNumber(current.duration, 0);
  const playbackRate = normalizePlaybackRate(patch.playbackRate ?? current.playbackRate ?? 1);
  const isPlaying =
    typeof patch.isPlaying === 'boolean' ? patch.isPlaying : Boolean(current.isPlaying);
  const updatedAt = Date.now();
  const seekTimestamp =
    Number.isFinite(Number(patch.seekTimestamp)) && Number(patch.seekTimestamp) > 0
      ? Number(patch.seekTimestamp)
      : finiteNumber(current.seekTimestamp || current.clock?.seekTimestamp, 0);
  const trackSeq = finiteNumber(patch.trackSeq, finiteNumber(current.trackSeq, 0));

  return {
    ...current,
    ...(trackSeq > 0 ? { trackSeq } : {}),
    currentTime,
    duration,
    playbackRate,
    isPlaying,
    updatedAt,
    ...(seekTimestamp > 0 ? { seekTimestamp } : {}),
    clock: buildPlaybackClockSnapshot({
      trackId: current.trackId,
      currentTime,
      duration,
      isPlaying,
      playbackRate,
      updatedAt,
      seekTimestamp,
      reason: patch.reason,
    }),
  };
};
