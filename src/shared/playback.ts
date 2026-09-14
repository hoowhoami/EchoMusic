export type PlayMode = 'sequential' | 'list' | 'random' | 'single';

export type PlaybackProgressBusyReason = 'seek' | 'buffering' | null;

/** User volume percentage. 100 is the source level; values above 100 are not used by the UI. */
export const DEFAULT_PLAYER_VOLUME = 50;
export const MIN_PLAYER_VOLUME = 0;
export const MAX_PLAYER_VOLUME = 100;

/** Normalize a user-facing volume value to the shared 0–100 percentage scale. */
export const normalizePlayerVolume = (value: number) =>
  Math.min(MAX_PLAYER_VOLUME, Math.max(MIN_PLAYER_VOLUME, Number.isFinite(value) ? value : 0));

const SEEK_TARGET_MATCH_TOLERANCE_SECS = 0.75;

/** Whether a native position belongs to the latest optimistic seek intent. */
export const matchesPendingSeekTarget = (
  pendingTarget: number | null | undefined,
  nativePosition: number | null | undefined,
) => {
  if (pendingTarget === null || pendingTarget === undefined) return true;
  const target = Number(pendingTarget);
  const position = Number(nativePosition);
  return (
    Number.isFinite(target) &&
    Number.isFinite(position) &&
    Math.abs(position - target) <= SEEK_TARGET_MATCH_TOLERANCE_SECS
  );
};

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
  trackSeq?: number;
  /** Engine position at sampledAt; never pre-projected by the sender. */
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  isPlaying: boolean;
  /** Playback intent can remain playing while seeking or buffering. */
  isAdvancing?: boolean;
  generation: number;
  seekTimestamp?: number;
  sampledAt?: number;
  reason?: PlaybackClockReason;
}

export interface PlaybackClockSource {
  trackId?: string | number | null;
  trackSeq?: number | null;
  currentTime?: number | null;
  duration?: number | null;
  playbackRate?: number | null;
  isPlaying?: boolean | null;
  isAdvancing?: boolean;
  seekTimestamp?: number | null;
  updatedAt?: number | null;
  reason?: PlaybackClockReason;
}

const DEFAULT_PLAYBACK_BRIDGE_TIMEOUT_MS = 5000;
const DEFAULT_PLAYBACK_BRIDGE_RENDERER_SAMPLE_GRACE_MS = 500;

const finiteNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

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

  return {
    trackId:
      source.trackId !== undefined && source.trackId !== null ? String(source.trackId) : null,
    ...(source.trackSeq ? { trackSeq: source.trackSeq } : {}),
    positionMs: rawPositionMs,
    durationMs: Math.max(0, Math.round(finiteNumber(source.duration, 0) * 1000)),
    playbackRate,
    isPlaying,
    isAdvancing: isPlaying && (source.isAdvancing ?? true),
    generation,
    ...(seekTimestamp > 0 ? { seekTimestamp } : {}),
    ...(sampledAt > 0 ? { sampledAt } : {}),
    ...(source.reason ? { reason: source.reason } : {}),
  };
};

/** One source clock per player, shared by every lyric consumer and IPC publisher. */
export const createPlaybackClock = () => {
  let previous: PlaybackClockSnapshot | undefined;
  let previousSourceSample = 0;
  return (source: PlaybackClockSource): PlaybackClockSnapshot => {
    const clock = buildPlaybackClockSnapshot(source);
    const sourceSample = clock.sampledAt ?? 0;
    // A resume/rate/buffering change starts a new interpolation segment. Do not
    // charge time spent paused to the next segment, or refresh it on a duration edit.
    const transportChanged =
      previous &&
      (previous.trackId !== clock.trackId ||
        previous.trackSeq !== clock.trackSeq ||
        previous.generation !== clock.generation ||
        previous.isPlaying !== clock.isPlaying ||
        previous.isAdvancing !== clock.isAdvancing ||
        previous.playbackRate !== clock.playbackRate);
    if (transportChanged && sourceSample === previousSourceSample) {
      clock.sampledAt = Date.now();
    } else if (
      previous &&
      sourceSample === previousSourceSample &&
      clock.positionMs === previous.positionMs
    ) {
      clock.sampledAt = previous.sampledAt;
    }
    previousSourceSample = sourceSample;
    previous = clock;
    return clock;
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
  isAdvancing?: boolean;
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

  const nextSeekTimestamp = finiteNumber(next.seekTimestamp || next.clock?.seekTimestamp, 0);
  const currentSeekTimestamp = finiteNumber(
    current.seekTimestamp || current.clock?.seekTimestamp,
    0,
  );
  if (nextSeekTimestamp !== currentSeekTimestamp) return nextSeekTimestamp > currentSeekTimestamp;

  const nextUpdatedAt = readPlaybackSnapshotUpdatedAt(next);
  const currentUpdatedAt = readPlaybackSnapshotUpdatedAt(current);
  // Old samples can jump forward after a backward seek or restore an obsolete
  // play/pause state. Position direction is not a valid ordering criterion.
  return !(nextUpdatedAt > 0 && currentUpdatedAt > 0 && nextUpdatedAt < currentUpdatedAt);
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
  const transportChanged =
    (patch.isPlaying !== undefined && patch.isPlaying !== current.isPlaying) ||
    (patch.isAdvancing !== undefined && patch.isAdvancing !== current.clock?.isAdvancing) ||
    (patch.playbackRate !== undefined && patch.playbackRate !== current.playbackRate);
  const updatedAt =
    patch.currentTime !== undefined || transportChanged
      ? Date.now()
      : readPlaybackSnapshotUpdatedAt(current);
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
      trackSeq,
      currentTime,
      duration,
      isPlaying,
      isAdvancing:
        patch.isAdvancing ??
        (typeof patch.isPlaying === 'boolean'
          ? isPlaying
          : patch.currentTime !== undefined
            ? isPlaying
            : current.clock?.isAdvancing),
      playbackRate,
      updatedAt,
      seekTimestamp,
      reason: patch.reason,
    }),
  };
};
