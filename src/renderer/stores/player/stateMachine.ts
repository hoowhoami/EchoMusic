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

export const beginNativeTrackLoad = (state: PlayerState) => {
  // 换源会取代当前 seek；后续加载状态由 awaitingTrackLoad 单独驱动。
  state.seekTargetTime = null;
  // Nested source attempts belong to one transition. Keep the sequence captured by
  // the first begin so abort can restore the track that was active before it started.
  if (!state.awaitingTrackLoad) {
    state.supersededNativeTrackSeq = state.nativeTrackSeq;
  }
  state.nativeTrackSeq = null;
  state.awaitingTrackLoad = true;
};

export const bindNativeTrackLoad = (state: PlayerState, trackSeq?: number): boolean => {
  if (!state.awaitingTrackLoad || !Number.isFinite(trackSeq) || Number(trackSeq) <= 0) {
    return false;
  }
  state.nativeTrackSeq = Number(trackSeq);
  state.supersededNativeTrackSeq = null;
  state.awaitingTrackLoad = false;
  return true;
};

export const abortNativeTrackLoad = (state: PlayerState) => {
  if (!state.awaitingTrackLoad) return;
  state.nativeTrackSeq = state.supersededNativeTrackSeq;
  state.supersededNativeTrackSeq = null;
  state.awaitingTrackLoad = false;
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

export const getPlaybackHasFailed = (state: PlayerState): boolean =>
  state.playbackIntent.phase === 'failed' || state.enginePlayback.status === 'error';

export const getPlaybackIsPlaying = (state: PlayerState): boolean =>
  !getPlaybackHasFailed(state) &&
  (state.playbackIntent.shouldPlay || state.enginePlayback.status === 'playing');

export const getPlaybackDisplayState = (state: PlayerState): PlaybackDisplayState => {
  if (getPlaybackIsLoading(state)) return 'loading';
  if (getPlaybackHasFailed(state)) return 'error';
  if (getPlaybackIsPlaying(state)) return 'playing';
  return 'paused';
};
