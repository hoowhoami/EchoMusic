export type PlayMode = 'sequential' | 'list' | 'random' | 'single';

export const DEFAULT_PLAYER_VOLUME = 0.5;

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
