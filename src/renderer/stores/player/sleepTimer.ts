import type { SleepTimerAction } from '../../../shared/sleep-timer';

export const createSleepTimerState = () => ({
  action: 'pause' as SleepTimerAction,
  executing: false,
  error: '',
  deadline: null as number | null,
  durationMinutes: 30,
  finishTrack: false,
  waitingTrackId: null as string | null,
  remainingSeconds: 0,
});

type SleepTimerState = ReturnType<typeof createSleepTimerState>;
type PlaybackContext = { trackId: string | null; playing: boolean };

// Use a wall-clock deadline so minimization and system sleep do not extend the timer.
export const createSleepTimer = (
  state: SleepTimerState,
  getPlayback: () => PlaybackContext,
  onComplete: (action: SleepTimerAction) => void,
  now: () => number = Date.now,
) => {
  const cancel = () => {
    state.deadline = null;
    state.waitingTrackId = null;
    state.remainingSeconds = 0;
  };
  const complete = () => {
    cancel();
    onComplete(state.action);
    return true;
  };
  const start = (minutes: number, action: SleepTimerAction = state.action) => {
    if (!['pause', 'quit', 'shutdown'].includes(action) || state.executing) return false;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return false;
    state.action = action;
    state.error = '';
    state.durationMinutes = minutes;
    state.waitingTrackId = null;
    state.remainingSeconds = minutes * 60;
    state.deadline = now() + minutes * 60_000;
    return true;
  };
  const setAction = (action: SleepTimerAction) => {
    if (!['pause', 'quit', 'shutdown'].includes(action) || state.executing) return false;
    state.action = action;
    return true;
  };
  const tick = () => {
    if (state.deadline === null) return false;
    state.remainingSeconds = Math.max(0, Math.ceil((state.deadline - now()) / 1000));
    if (now() < state.deadline) return false;
    const playback = getPlayback();
    if (!state.finishTrack || !playback.playing || !playback.trackId) return complete();
    if (state.waitingTrackId && state.waitingTrackId !== playback.trackId) return complete();
    state.waitingTrackId = playback.trackId;
    return false;
  };
  const trackEnded = () => {
    if (state.deadline === null || now() < state.deadline) return false;
    return complete();
  };
  return { start, cancel, tick, trackEnded, setAction };
};
