import {
  PLAYER_SESSION_KEYS,
  matchesPlayerSession,
  type PlayerRuntimeSession,
  type PlayerSessionRestore,
} from '../../../shared/playerSession';
import type { PlayerState } from './state';
import { setEnginePlaybackStatus, setPlaybackIntentPlayback } from './stateMachine';

export const capturePlayerSession = (
  state: PlayerState,
  queue: PlayerRuntimeSession['queue'],
): PlayerRuntimeSession => ({
  player: Object.fromEntries(
    PLAYER_SESSION_KEYS.map((key) => [key, state[key]]),
  ) as PlayerRuntimeSession['player'],
  queue,
});

export const restorePlayerSession = (
  state: PlayerState,
  restore: PlayerSessionRestore,
): boolean => {
  if (!matchesPlayerSession(restore.session, restore.transport)) return false;
  Object.assign(state, restore.session.player);
  state.currentTime = Math.max(0, restore.transport.timePos);
  state.currentTimeUpdatedAt = Date.now();
  state.duration = restore.transport.duration;
  if (restore.transport.speed && restore.transport.speed > 0)
    state.playbackRate = restore.transport.speed;
  state.awaitingTrackLoad = false;
  state.supersededNativeTrackSeq = null;
  setPlaybackIntentPlayback(state, restore.transport.playing);
  setEnginePlaybackStatus(state, restore.transport.playing ? 'playing' : 'paused');
  return true;
};
