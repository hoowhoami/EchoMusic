import type { PlayerState } from './state';
import type { EnginePlaybackStatus, PlaybackDisplayState, PlaybackIntentPhase } from './types';

export const beginPlaybackIntent = (
  state: PlayerState,
  payload: {
    seq: number;
    trackId: string | null;
    sourceQueueId: string | null;
    shouldPlay: boolean;
  },
) => {
  state.playbackIntent.seq = payload.seq;
  state.playbackIntent.trackId = payload.trackId;
  state.playbackIntent.sourceQueueId = payload.sourceQueueId;
  state.playbackIntent.shouldPlay = payload.shouldPlay;
  state.playbackIntent.phase = 'loading';
  state.playbackIntent.startedAt = Date.now();
  state.enginePlayback.status = 'loading';
  state.enginePlayback.trackId = payload.trackId;
  state.enginePlayback.updatedAt = Date.now();
};

export const completePlaybackIntent = (
  state: PlayerState,
  seq: number,
  payload: { isPlaying: boolean },
): boolean => {
  if (state.playbackIntent.seq !== seq) return false;
  state.playbackIntent.phase = 'ready';
  state.playbackIntent.shouldPlay = payload.isPlaying;
  return true;
};

export const failPlaybackIntent = (state: PlayerState, seq?: number) => {
  if (seq !== undefined && state.playbackIntent.seq !== seq) return;
  state.playbackIntent.trackId = state.currentTrackId;
  state.playbackIntent.sourceQueueId = state.currentSourceQueueId;
  state.playbackIntent.phase = 'failed';
  state.playbackIntent.shouldPlay = false;
};

export const clearPlaybackIntent = (state: PlayerState) => {
  state.playbackIntent.seq = state.playbackRequestSeq;
  state.playbackIntent.trackId = null;
  state.playbackIntent.sourceQueueId = null;
  state.playbackIntent.shouldPlay = false;
  state.playbackIntent.phase = 'idle';
  state.playbackIntent.startedAt = 0;
};

export const setPlaybackIntentPlayback = (state: PlayerState, shouldPlay: boolean) => {
  state.playbackIntent.trackId = state.currentTrackId;
  state.playbackIntent.sourceQueueId = state.currentSourceQueueId;
  state.playbackIntent.shouldPlay = shouldPlay;
  state.playbackIntent.phase = 'ready';
};

export const setEnginePlaybackStatus = (
  state: PlayerState,
  status: EnginePlaybackStatus,
  trackId = state.currentTrackId,
) => {
  state.enginePlayback.status = status;
  state.enginePlayback.trackId = trackId;
  state.enginePlayback.updatedAt = Date.now();
};

export const isPlaybackIntentPhase = (state: PlayerState, phase: PlaybackIntentPhase): boolean =>
  state.playbackIntent.phase === phase;

export const shouldIgnoreEnginePause = (state: PlayerState): boolean =>
  state.awaitingTrackLoad ||
  (state.playbackIntent.phase === 'loading' && state.playbackIntent.shouldPlay);

export const getPlaybackTargetTrackId = (state: PlayerState): string | null =>
  state.playbackIntent.trackId ?? state.currentTrackId;

export const getPlaybackIsLoading = (state: PlayerState): boolean =>
  state.playbackIntent.phase === 'loading';

export const getPlaybackIsPlaying = (state: PlayerState): boolean =>
  state.playbackIntent.shouldPlay || state.enginePlayback.status === 'playing';

export const getPlaybackDisplayState = (state: PlayerState): PlaybackDisplayState => {
  if (getPlaybackIsLoading(state)) return 'loading';
  if (state.playbackIntent.phase === 'failed' || state.enginePlayback.status === 'error') {
    return 'error';
  }
  if (getPlaybackIsPlaying(state)) return 'playing';
  return 'paused';
};
