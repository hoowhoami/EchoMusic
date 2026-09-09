import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSleepTimer,
  createSleepTimerState,
} from '../src/renderer/stores/player/sleepTimer.ts';

const setup = () => {
  let now = 1000;
  let completions = 0;
  const state = createSleepTimerState();
  const playback = { trackId: 'song-a' as string | null, playing: true };
  const timer = createSleepTimer(
    state,
    () => playback,
    () => completions++,
    () => now,
  );
  return {
    state,
    playback,
    timer,
    advance: (ms: number) => {
      now += ms;
    },
    completions: () => completions,
  };
};

test('deadline stops playback exactly once even after background suspension', () => {
  const t = setup();
  t.timer.start(10);
  t.advance(599_001);
  assert.equal(t.timer.tick(), false);
  assert.equal(t.state.remainingSeconds, 1);
  t.advance(60_000);
  assert.equal(t.timer.tick(), true);
  assert.equal(t.state.deadline, null);
  t.timer.tick();
  t.timer.trackEnded();
  assert.equal(t.completions(), 1);
});

test('finishing the current song waits for EOF and consumes it before auto-next or repeat', () => {
  const t = setup();
  t.state.finishTrack = true;
  t.timer.start(1);
  t.advance(60_000);
  assert.equal(t.timer.tick(), false);
  assert.equal(t.state.waitingTrackId, 'song-a');
  assert.equal(t.completions(), 0);
  assert.equal(t.timer.trackEnded(), true);
  assert.equal(t.state.waitingTrackId, null);
  assert.equal(t.completions(), 1);
});

test('EOF at the deadline is consumed even before the next timer tick', () => {
  const t = setup();
  t.state.finishTrack = true;
  t.timer.start(1);
  t.advance(59_999);
  assert.equal(t.timer.trackEnded(), false);
  t.advance(1);
  assert.equal(t.timer.trackEnded(), true);
});

test('paused or missing playback completes instead of waiting indefinitely', () => {
  for (const playback of [
    { trackId: 'song-a', playing: false },
    { trackId: null, playing: true },
  ]) {
    const t = setup();
    Object.assign(t.playback, playback);
    t.state.finishTrack = true;
    t.timer.start(1);
    t.advance(60_000);
    assert.equal(t.timer.tick(), true);
  }
});

test('pausing or skipping while waiting completes the timer', () => {
  for (const change of [{ playing: false }, { trackId: 'song-b' }]) {
    const t = setup();
    t.state.finishTrack = true;
    t.timer.start(1);
    t.advance(60_000);
    t.timer.tick();
    Object.assign(t.playback, change);
    assert.equal(t.timer.tick(), true);
  }
});

test('cancel and restart clear the pending end-of-song stop', () => {
  const t = setup();
  t.state.finishTrack = true;
  t.timer.start(1);
  t.advance(60_000);
  t.timer.tick();
  t.timer.start(20);
  assert.equal(t.state.waitingTrackId, null);
  assert.equal(t.state.remainingSeconds, 1200);
  assert.equal(t.timer.trackEnded(), false);
  t.timer.cancel();
  t.advance(2_000_000);
  assert.equal(t.timer.tick(), false);
  assert.equal(t.completions(), 0);
});

test('disabling finish-track while waiting stops immediately on reevaluation', () => {
  const t = setup();
  t.state.finishTrack = true;
  t.timer.start(1);
  t.advance(60_000);
  t.timer.tick();
  t.state.finishTrack = false;
  assert.equal(t.timer.tick(), true);
});

test('invalid input cannot replace an active timer', () => {
  const t = setup();
  t.timer.start(30);
  const deadline = t.state.deadline;
  for (const minutes of [0, -1, 181, 1.5, NaN, Infinity]) {
    assert.equal(t.timer.start(minutes), false);
    assert.equal(t.state.deadline, deadline);
  }
  assert.equal(t.timer.start(180), true);
});

test('changing an active action preserves the deadline and executes the latest choice', () => {
  let now = 0;
  const state = createSleepTimerState();
  const actions: string[] = [];
  const timer = createSleepTimer(
    state,
    () => ({ trackId: 'a', playing: true }),
    (action) => {
      actions.push(action);
    },
    () => now,
  );
  timer.start(10, 'shutdown');
  now = 120_000;
  timer.tick();
  const deadline = state.deadline;
  assert.equal(timer.setAction('pause'), true);
  assert.equal(state.deadline, deadline);
  assert.equal(state.remainingSeconds, 480);
  now = 600_000;
  timer.tick();
  assert.deepEqual(actions, ['pause']);
});

test('changing the action while finishing a song preserves the waiting track', () => {
  let now = 0;
  const state = createSleepTimerState();
  state.finishTrack = true;
  const actions: string[] = [];
  const timer = createSleepTimer(
    state,
    () => ({ trackId: 'a', playing: true }),
    (action) => {
      actions.push(action);
    },
    () => now,
  );
  timer.start(1, 'pause');
  now = 60_000;
  timer.tick();
  timer.setAction('quit');
  assert.equal(state.waitingTrackId, 'a');
  assert.deepEqual(actions, []);
  timer.trackEnded();
  assert.deepEqual(actions, ['quit']);
  state.executing = true;
  assert.equal(timer.setAction('shutdown'), false);
});

test('each selected action executes once, only when the deadline is reached', () => {
  for (const action of ['pause', 'quit', 'shutdown'] as const) {
    let now = 0;
    const actions: string[] = [];
    const state = createSleepTimerState();
    const timer = createSleepTimer(
      state,
      () => ({ trackId: 'a', playing: true }),
      (value) => {
        actions.push(value);
      },
      () => now,
    );
    assert.equal(timer.start(1, action), true);
    assert.deepEqual(actions, []);
    now = 60_000;
    timer.tick();
    timer.tick();
    timer.trackEnded();
    assert.deepEqual(actions, [action]);
  }
});

test('cancelled shutdown never dispatches, and restarting can replace it with pause', () => {
  let now = 0;
  const actions: string[] = [];
  const state = createSleepTimerState();
  const timer = createSleepTimer(
    state,
    () => ({ trackId: null, playing: false }),
    (value) => {
      actions.push(value);
    },
    () => now,
  );
  timer.start(1, 'shutdown');
  timer.cancel();
  now = 60_000;
  timer.tick();
  assert.deepEqual(actions, []);
  timer.start(1, 'pause');
  now += 60_000;
  timer.tick();
  assert.deepEqual(actions, ['pause']);
});

test('quit waits for the current song and invalid actions cannot arm a timer', () => {
  let now = 0;
  const actions: string[] = [];
  const state = createSleepTimerState();
  state.finishTrack = true;
  const timer = createSleepTimer(
    state,
    () => ({ trackId: 'a', playing: true }),
    (value) => {
      actions.push(value);
    },
    () => now,
  );
  timer.start(1, 'quit');
  now = 60_000;
  timer.tick();
  assert.deepEqual(actions, []);
  timer.trackEnded();
  assert.deepEqual(actions, ['quit']);
  assert.equal(timer.start(1, 'reboot' as never), false);
  state.executing = true;
  assert.equal(timer.start(1, 'shutdown'), false);
});
