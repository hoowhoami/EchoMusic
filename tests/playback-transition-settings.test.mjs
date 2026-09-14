import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as decisions from '../src/shared/playback-queue-decision.ts';
import * as execution from '../src/shared/playback-queue-execution.ts';
import * as transitions from '../src/shared/track-transition.ts';
import * as stateMachine from '../src/renderer/stores/player/stateMachine.ts';

const code = transformSync(
  readFileSync(new URL('../src/renderer/stores/player/playback.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const noop = () => {};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup({ prepare, begin, seek, timers = { setTimeout, clearTimeout } } = {}) {
  const calls = {
    prepared: [],
    cancelled: [],
    cleared: 0,
    adopted: [],
    notices: [],
    warnings: [],
    seeks: [],
    adoptedLoudness: [],
    appliedLoudness: [],
  };
  const songs = ['a', 'b', 'c'].map((id) => ({ id, duration: 100 }));
  const queue = { id: 'queue:test', songs, playbackRevision: 0, queuedNextTrackIds: [] };
  const state = {
    currentTrackId: 'a',
    currentSourceQueueId: queue.id,
    currentPlaylist: songs,
    currentTrackSnapshot: songs[0],
    currentTime: 80,
    duration: 100,
    playbackRate: 1,
    playMode: 'list',
    playbackRequestSeq: 1,
    audioEffect: 'none',
    currentAudioQualityOverride: null,
    sleepTimer: { deadline: null },
    playbackIntent: { seq: 1, phase: 'ready', shouldPlay: true },
    enginePlayback: { status: 'playing' },
    autoNextTimer: null,
  };
  const settings = {
    effectiveTrackTransitionMode: 'fade',
    fadeCrossSecs: 3,
    defaultAudioQuality: 'flac',
    compatibilityMode: false,
    playbackStallTimeout: 0,
  };
  let requestId = 0;
  const engine = {
    duration: 100,
    seek: (time) => {
      calls.seeks.push(time);
      return seek ? seek(time) : Promise.resolve();
    },
    beginNextSourcePreparation: () => (begin ? begin(++requestId) : Promise.resolve(++requestId)),
    prepareNextSource: (source, id) => {
      calls.prepared.push({ source, id, mode: settings.effectiveTrackTransitionMode });
      return prepare ? prepare(id) : Promise.resolve(100 + id);
    },
    clearPreparedNextSource: () => {
      calls.cleared++;
    },
    cancelNextSourcePreparation: (id) => calls.cancelled.push(id),
    adoptPreparedSource: (source) => calls.adopted.push(source),
    applyTrackLoudness: (value) => calls.appliedLoudness.push(value),
    adoptPreparedTrackLoudness: (value) => calls.adoptedLoudness.push(value),
    setLoopFile: noop,
    updateMediaPlaybackState: noop,
  };
  const playlist = {
    activeQueue: queue,
    playbackQueues: [queue],
    syncQueuedNextTrackIds: noop,
    consumeQueuedNextTrackIds: noop,
    updateQueueCurrentTrack: noop,
  };
  const module = { exports: {} };
  const dependencies = {
    '@/utils/logger': { info: noop, warn: (...args) => calls.warnings.push(args) },
    '../../../shared/playback-queue-decision': decisions,
    '../../../shared/playback-queue-execution': execution,
    '../../../shared/track-transition': transitions,
    '@/utils/song': { isPlayableSong: () => true },
    '@/utils/player': {},
    '../playlist': { PERSONAL_FM_QUEUE_ID: 'fm' },
    '../playlist/helpers': {
      toRawSong: (song) => ({ ...song }),
      toRawSongList: (list) => [...list],
    },
    '../historyStore': { useHistoryStore: () => ({ recordPlay: noop }) },
    '../toast': { useToastStore: () => ({ show: (text) => calls.notices.push(text) }) },
    './utils': { buildMediaMeta: () => null, buildMediaState: () => ({}) },
    './queueAdvancePolicy': {
      canPrepareGaplessForQueue: (_id, suppressed) => !suppressed,
      getQueueAdvanceAuthority: () => 'local',
    },
    './stateMachine': stateMachine,
  };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    timers,
  );
  const manager = module.exports.createPlaybackManager(
    state,
    engine,
    playlist,
    settings,
    { clear: noop, fetchLyrics: noop },
    {
      resolveAudioUrl: async (song) => ({ url: `https://audio.test/${song.id}.flac` }),
      fetchClimaxMarks: noop,
    },
    { resetHistoryUploadState: noop },
    noop,
    noop,
  );
  const changeSettings = () => {
    settings.effectiveTrackTransitionMode = 'gapless';
    manager.invalidateGaplessForSettings();
  };
  return { manager, state, settings, queue, calls, changeSettings };
}

function manualTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++nextId;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of pending) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.fn();
        }
      }
    },
  };
}

test('next-track preloading yields to a quality switch and resumes after it finishes', async () => {
  const { state, manager, calls } = setup();
  state.audioSourceRefreshRequestSeq = state.playbackRequestSeq;
  await manager.prepareGaplessNext();
  assert.equal(calls.prepared.length, 0);
  state.audioSourceRefreshRequestSeq = null;
  await manager.prepareGaplessNext();
  await flush();
  assert.equal(calls.prepared.length, 1);
});

test('preloading also yields while a newer quality preference is waiting to refresh', async () => {
  const e = setup();
  e.state.pendingSettingRefresh = true;
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 0);
  e.state.pendingSettingRefresh = false;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared.length, 1);
});

test('persistent quality changes invalidate next-track preparation even under a per-track override', async () => {
  const e = setup();
  e.state.currentAudioQualityOverride = '320';
  const before = e.manager.getGaplessInvalidationKey();
  await e.manager.prepareGaplessNext();
  await flush();
  e.settings.defaultAudioQuality = 'high';
  assert.notEqual(e.manager.getGaplessInvalidationKey(), before);
  e.manager.clearGaplessPreparedSource();
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared.length, 2);
  assert.equal(e.manager.activateGaplessPreparedTransition(102, 0), true);
  assert.equal(e.state.currentAudioQualityOverride, null);
  assert.equal(e.settings.defaultAudioQuality, 'high');
});

test('user seek reaches native without waiting for a stuck transition registration', async () => {
  let register;
  const e = setup({
    timers: manualTimers(),
    begin: () =>
      new Promise((resolve) => {
        register = resolve;
      }),
  });
  const registration = e.manager.prepareGaplessNext();
  await e.manager.seek(100);
  assert.deepEqual(e.calls.seeks, [100]);
  assert.equal(e.state.seekTargetTime, null);
  assert.equal(e.state.recentSeekIgnoreEnd, false);
  register(1);
  await registration;
  await flush();
  assert.equal(e.calls.prepared.length, 0);
});

test('only the latest completed seek may reprepare a transition and clear seeking state', async () => {
  const pending = new Map();
  const e = setup({
    timers: manualTimers(),
    seek: (time) => new Promise((resolve) => pending.set(time, resolve)),
  });
  const first = e.manager.seek(75);
  const second = e.manager.seek(80);
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 0);
  pending.get(75)();
  await first;
  assert.equal(e.state.seekTargetTime, 80);
  assert.equal(e.calls.prepared.length, 0);
  pending.get(80)();
  await second;
  await flush();
  assert.equal(e.state.seekTargetTime, null);
  assert.equal(e.calls.prepared.length, 1);
});

test('a rapid seek to EOF does not inherit the previous seek end-suppression flag', async () => {
  const e = setup({ timers: manualTimers() });
  await e.manager.seek(50);
  assert.equal(e.state.recentSeekIgnoreEnd, true);
  await e.manager.seek(100);
  assert.equal(e.state.recentSeekIgnoreEnd, false);
});

test('seek rejection ends the UI lifecycle without launching background preparation', async () => {
  const e = setup({ timers: manualTimers(), seek: () => Promise.reject(new Error('seek failed')) });
  await assert.rejects(e.manager.seek(80), /seek failed/);
  assert.equal(e.state.seekTargetTime, null);
  assert.equal(e.state.nativeSeekActive, false);
  assert.equal(e.calls.prepared.length, 0);
});

test('a seek completing after a track change cannot clear the new track seek state', async () => {
  let finish;
  const e = setup({
    timers: manualTimers(),
    seek: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = e.manager.seek(80);
  e.state.currentTrackId = 'c';
  e.state.playbackRequestSeq++;
  e.state.seekTargetTime = 10;
  e.state.nativeSeekActive = true;
  finish();
  await pending;
  assert.equal(e.state.seekTargetTime, 10);
  assert.equal(e.state.nativeSeekActive, true);
  assert.equal(e.calls.prepared.length, 0);
});

test('smart preparation can take longer than the playback stall timeout', async () => {
  const timers = manualTimers();
  let finish;
  const e = setup({
    timers,
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  e.settings.effectiveTrackTransitionMode = 'automix-pro';
  e.settings.playbackStallTimeout = 8;
  e.state.currentTime = 25;
  await e.manager.prepareGaplessNext();
  await flush();
  timers.advance(20_000);
  assert.equal(e.calls.cleared, 0, 'a healthy analysis must not be cancelled at 8 seconds');
  finish(101);
  await flush();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.deepEqual(e.calls.warnings, []);
});

test('preparation timeout is bounded even when playback stall recovery is disabled', async () => {
  const timers = manualTimers();
  let finish;
  const e = setup({
    timers,
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  e.settings.effectiveTrackTransitionMode = 'automix-pro';
  e.state.currentTime = 25;
  await e.manager.prepareGaplessNext();
  await flush();
  timers.advance(60_000);
  assert.equal(e.calls.cleared, 1);
  assert.equal(e.calls.warnings.length, 1);
  for (let i = 0; i < 50; i++) await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 1, 'a timed-out pair must not enter a retry loop');
  finish(null);
  await flush();
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 1, 'late cleanup must not reset timeout suppression');
  e.changeSettings();
  e.state.currentTime = 80;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared.length, 2, 'a settings change allows a fresh attempt');
  finish(null);
  await flush();
});

test('late preparation releases the EOF wait before the song ends and does not restart there', async () => {
  const timers = manualTimers();
  let finish;
  const e = setup({
    timers,
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  e.state.currentTime = 95;
  await e.manager.prepareGaplessNext();
  await flush();
  timers.advance(3_000);
  assert.equal(e.calls.cleared, 1);
  e.state.currentTime = 100;
  await e.manager.prepareGaplessNext({ allowAtEnd: true });
  assert.equal(e.calls.prepared.length, 1);
  finish(null);
  await flush();
});

test('the preparation deadline also covers a stalled request registration', async () => {
  const timers = manualTimers();
  let register;
  const e = setup({
    timers,
    begin: () =>
      new Promise((resolve) => {
        register = resolve;
      }),
  });
  const registration = e.manager.prepareGaplessNext();
  timers.advance(18_000);
  assert.equal(e.calls.cleared, 1);
  register(1);
  await registration;
  await flush();
  assert.deepEqual(e.calls.cancelled, [1]);
  assert.equal(e.calls.prepared.length, 0);
});

test('seeking to EOF cancels an existing long preparation instead of waiting for its deadline', async () => {
  const timers = manualTimers();
  let finish;
  const e = setup({
    timers,
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  e.settings.effectiveTrackTransitionMode = 'automix-pro';
  e.state.currentTime = 25;
  await e.manager.prepareGaplessNext();
  await flush();
  await e.manager.prepareGaplessNext({ position: 100, allowAtEnd: true, requirePlaying: false });
  assert.equal(e.calls.cleared, 1);
  finish(null);
  await flush();
  assert.deepEqual(e.calls.cancelled, [1]);
});

test('a settings change accepts an already-started old transition without reloading', async () => {
  const e = setup();
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  assert.equal(e.state.currentTrackId, 'a');
  assert.equal(e.state.currentTime, 80);
  assert.equal(
    e.manager.activateGaplessPreparedTransition(101, 1.3, { mode: 'fade', overlapSecs: 3 }),
    true,
  );
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(e.state.currentTime, 1.3);
  assert.equal(e.calls.adopted.length, 1);
  assert.equal(e.calls.prepared.length, 1);
  assert.equal(e.calls.adoptedLoudness.length, 1);
  assert.deepEqual(e.calls.appliedLoudness, [], 'native retains ownership of overlap gain');
  assert.deepEqual(e.calls.warnings, []);
  assert.match(e.calls.notices[0], /淡入淡出/);
  assert.equal(
    e.manager.activateGaplessPreparedTransition(101),
    false,
    'boundary is accepted once',
  );
});

test('a pending transition is prepared again with the new settings', async () => {
  const e = setup();
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  await e.manager.prepareGaplessNext();
  await flush();
  assert.deepEqual(
    e.calls.prepared.map((call) => call.mode),
    ['fade', 'gapless'],
  );
  assert.equal(e.manager.activateGaplessPreparedTransition(102, 0), true);
  assert.equal(e.state.nativeTrackSeq, 102);
  assert.equal(e.calls.adopted.length, 1);
});

test('late preparation only cancels its own request and retains a started boundary', async () => {
  let finishOld;
  const e = setup({
    prepare: (id) =>
      id === 1
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(100 + id),
  });
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  await e.manager.prepareGaplessNext();
  await flush();
  const clears = e.calls.cleared;
  finishOld(101);
  await flush();
  assert.equal(e.calls.cleared, clears, 'old completion must not clear the newer preparation');
  assert.deepEqual(e.calls.cancelled, [1]);
  assert.equal(e.manager.activateGaplessPreparedTransition(101, 2), true);
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(e.state.currentTime, 2);
  assert.deepEqual(e.calls.warnings, []);
});

test('late registration cannot replace a newer preparation with the same decision key', async () => {
  let finishOld;
  const e = setup({
    begin: (id) =>
      id === 1
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(id),
  });
  const oldRegistration = e.manager.prepareGaplessNext();
  e.changeSettings();
  await e.manager.prepareGaplessNext();
  await flush();
  finishOld(1);
  await oldRegistration;
  await flush();
  assert.deepEqual(
    e.calls.prepared.map((call) => call.id),
    [2],
  );
  assert.equal(e.manager.activateGaplessPreparedTransition(102), true);
});

test('clearing a replacement preparation does not reject a running old transition', async () => {
  const e = setup();
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  await e.manager.prepareGaplessNext();
  await flush();
  e.manager.clearGaplessPreparedSource();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(e.calls.adopted.length, 1);
  assert.deepEqual(e.calls.warnings, []);
});

for (const invalidation of ['queue', 'request']) {
  test(`settings-retained transitions still respect ${invalidation} invalidation`, async () => {
    const e = setup();
    await e.manager.prepareGaplessNext();
    await flush();
    e.changeSettings();
    if (invalidation === 'queue') e.queue.playbackRevision++;
    if (invalidation === 'request') e.state.playbackRequestSeq++;
    e.state.awaitingTrackLoad = true;
    assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
    assert.equal(e.state.currentTrackId, 'a');
    assert.equal(e.calls.adopted.length, 0);
    assert.equal(e.calls.warnings.length, 1);
  });
}
