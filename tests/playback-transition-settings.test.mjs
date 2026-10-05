import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { reactive, watch } from 'vue';
import { constants, createFmStore, queuePolicy } from './helpers/personal-fm.mjs';
import * as decisions from '../src/shared/playbackQueueDecision.ts';
import * as execution from '../src/shared/playbackQueueExecution.ts';
import * as transitions from '../src/shared/trackTransition.ts';
import * as stateMachine from '../src/renderer/stores/player/stateMachine.ts';

const code = transformSync(
  readFileSync(new URL('../src/renderer/stores/player/playback.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const audioCode = transformSync(
  readFileSync(new URL('../src/renderer/stores/player/audio.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const noop = () => {};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function naturalEndHandler(e) {
  const source = readFileSync(new URL('../src/renderer/stores/player.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    let handlingPlaybackEnd = false;');
  const end = source.indexOf('    const registerSettingWatchers =', start);
  const handlerCode = transformSync(source.slice(start, end), { loader: 'ts' }).code;
  return new Function(
    'state',
    'settingStore',
    'playbackManager',
    'playlistStore',
    'resolvePlaybackSourceQueueId',
    'PERSONAL_FM_QUEUE_ID',
    'DISCOVER_QUEUE_ID',
    'setPlaybackIntentPlayback',
    'setEnginePlaybackStatus',
    `${handlerCode}; return handlePlaybackEnded;`,
  )(
    e.state,
    e.settings,
    e.manager,
    e.playlist,
    decisions.resolvePlaybackSourceQueueId,
    constants.PERSONAL_FM_QUEUE_ID,
    constants.DISCOVER_QUEUE_ID,
    stateMachine.setPlaybackIntentPlayback,
    stateMachine.setEnginePlaybackStatus,
  );
}

function setup({
  prepare,
  begin,
  seek,
  load,
  resolve,
  fm = false,
  discover = false,
  replenish,
  fetch,
  playable = () => true,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const calls = {
    prepared: [],
    commits: [],
    cancelled: [],
    cleared: 0,
    adopted: [],
    notices: [],
    warnings: [],
    seeks: [],
    adoptedLoudness: [],
    appliedLoudness: [],
    loads: [],
    history: [],
    loops: [],
    resets: 0,
  };
  const songs = ['a', 'b', 'c'].map((id) => ({ id, hash: id, duration: 100 }));
  const queue = reactive({
    id: fm ? constants.PERSONAL_FM_QUEUE_ID : discover ? constants.DISCOVER_QUEUE_ID : 'queue:test',
    songs: fm ? songs.slice(0, 1) : songs,
    playbackRevision: 0,
    queuedNextTrackIds: [],
    meta: {},
  });
  const state = reactive({
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
    nativeTrackSeq: 1,
    autoNextAttempts: 0,
    shuffleHistory: [],
    shufflePlayed: new Set(),
    seekTimestamp: 0,
  });
  const settings = {
    effectiveTrackTransitionMode: 'fade',
    fadeCrossSecs: 3,
    defaultAudioQuality: 'flac',
    compatibilityMode: false,
    playbackStallTimeout: 0,
    syncPreventSleep: noop,
  };
  let requestId = 0;
  const engine = {
    duration: 100,
    beginSourceChange: noop,
    reset: () => calls.resets++,
    setPlaybackRate: noop,
    setVolume: noop,
    setSource: async (source) => {
      calls.loads.push(source);
      if (load) await load(source);
      stateMachine.bindNativeTrackLoad(state, 200 + calls.loads.length);
    },
    reloadSource: (source) => engine.setSource(source),
    play: async () => {},
    pause: async () => {},
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
    commitPreparedNextSource: async (duration) => {
      calls.commits.push(duration);
      manager.activateGaplessPreparedTransition(100 + requestId);
      return true;
    },
    adoptPreparedSource: (source) => calls.adopted.push(source),
    applyTrackLoudness: (value) => calls.appliedLoudness.push(value),
    adoptPreparedTrackLoudness: (value) => calls.adoptedLoudness.push(value),
    setLoopFile: (loop) => calls.loops.push(loop),
    updateMediaPlaybackState: noop,
  };
  const fmStore = fm ? createFmStore({ queue, buffer: songs.slice(1), fetch, timers }) : null;
  const playlist = fmStore?.store ?? {
    activeQueue: queue,
    playbackQueues: [queue],
    syncQueuedNextTrackIds: noop,
    consumeQueuedNextTrackIds: noop,
    consumeQueuedNextTrackId: noop,
    updateQueueCurrentTrack: noop,
    getQueueById: (id) => (id === queue.id ? queue : null),
    replenishDiscoverQueue: async () => (replenish ? replenish(queue) : 0),
  };
  const module = { exports: {} };
  const dependencies = {
    '@/utils/logger': {
      info: noop,
      warn: (...args) => calls.warnings.push(args),
      error: (...args) => calls.warnings.push(args),
    },
    '../../../shared/playbackQueueDecision': decisions,
    '../../../shared/playbackQueueExecution': execution,
    '../../../shared/trackTransition': transitions,
    '@/utils/song': { isPlayableSong: playable },
    '@/utils/player': { normalizePlayerErrorPayload: (error) => error },
    '../playlist': constants,
    '../playlist/helpers': {
      toRawSong: (song) => ({ ...song }),
      toRawSongList: (list) => [...list],
    },
    '../historyStore': {
      useHistoryStore: () => ({ recordPlay: (song) => calls.history.push(song.id) }),
    },
    '../toast': {
      useToastStore: () => ({
        show: (text) => calls.notices.push(text),
        info: (text) => calls.notices.push(text),
      }),
    },
    './utils': {
      buildMediaMeta: () => null,
      buildMediaState: () => ({}),
      buildStoppedPlaybackState: () => ({}),
      findTrackById: (id, list) => list.find((song) => String(song.id) === String(id)),
    },
    './queueAdvancePolicy': queuePolicy,
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
      resolveAudioUrl: resolve ?? (async (song) => ({ url: `https://audio.test/${song.id}.flac` })),
      fetchClimaxMarks: noop,
    },
    { resetHistoryUploadState: noop },
    noop,
    noop,
  );
  const audioModule = { exports: {} };
  new Function('require', 'module', 'exports', audioCode)(
    (name) =>
      name === '../../../shared/playback' ? { DEFAULT_PLAYER_VOLUME: 75 } : dependencies[name],
    audioModule,
    audioModule.exports,
  );
  const audioManager = audioModule.exports.createAudioManager(state, engine, noop, settings);
  const changeSettings = () => {
    settings.effectiveTrackTransitionMode = 'gapless';
    manager.invalidateGaplessForSettings();
  };
  return {
    manager,
    audioManager,
    state,
    settings,
    queue,
    calls,
    changeSettings,
    playlist,
    engine,
    fmStore,
  };
}

test('single repeat applies every transition mode to the same track across consecutive rounds', async () => {
  for (const mode of ['gapless', 'fade', 'automix-basic', 'automix-pro']) {
    const e = setup();
    e.state.playMode = 'single';
    e.settings.effectiveTrackTransitionMode = mode;
    const unwatch = watch(
      () => e.manager.getGaplessInvalidationKey(),
      () => e.manager.clearGaplessPreparedSource(),
      { flush: 'sync' },
    );
    for (let round = 1; round <= 3; round++) {
      e.state.currentTime = 80;
      await e.manager.prepareGaplessNext();
      await flush();
      assert.equal(e.calls.prepared.length, round, mode);
      assert.equal(e.calls.prepared.at(-1).source.url, 'https://audio.test/a.flac', mode);
      assert.equal(e.calls.prepared.at(-1).mode, mode);
      const position = mode.startsWith('automix') ? 2.5 : 0;
      assert.equal(
        e.manager.activateGaplessPreparedTransition(100 + round, position, {
          mode,
          overlapSecs: mode === 'gapless' ? 0 : 3,
        }),
        true,
      );
      assert.equal(e.state.currentTrackId, 'a');
      assert.equal(e.state.currentTime, position);
      assert.equal(e.state.nativeTrackSeq, 100 + round);
      assert.equal(e.manager.activateGaplessPreparedTransition(100 + round), true);
      assert.equal(e.calls.history.length, round);
    }
    assert.equal(e.calls.loads.length, 0);
    assert.deepEqual(e.calls.loops, [false, false, false]);
    unwatch();
  }
});

test('random playback prepares a stable next song without consuming the shuffle queue', async () => {
  for (const mode of ['gapless', 'fade', 'automix-basic', 'automix-pro']) {
    const e = setup();
    e.state.playMode = 'random';
    e.settings.effectiveTrackTransitionMode = mode;
    await e.manager.prepareGaplessNext();
    await flush();
    const targetId = e.calls.prepared[0]?.source.url.split('/').at(-1).split('.')[0];
    const targetIndex = ['a', 'b', 'c'].indexOf(targetId);
    const originalQueue = [...(e.state.shuffleQueue ?? [])];
    await e.manager.prepareGaplessNext();
    await flush();
    assert.equal(e.calls.prepared.length, 1, mode);
    assert.notEqual(targetId, 'a', mode);
    assert.deepEqual([...e.state.shuffleQueue], originalQueue, mode);
    assert.deepEqual([...e.state.shufflePlayed], [0], mode);
    assert.deepEqual([...e.state.shuffleHistory], [], mode);
    assert.equal(e.manager.activateGaplessPreparedTransition(101), true, mode);
    assert.equal(e.state.currentTrackId, targetId, mode);
    assert.deepEqual([...e.state.shuffleQueue], originalQueue.slice(1), mode);
    assert.deepEqual([...e.state.shufflePlayed], [0, targetIndex], mode);
    assert.deepEqual([...e.state.shuffleHistory], ['a'], mode);
    assert.equal(e.calls.loads.length, 0, mode);
    assert.equal(e.manager.activateGaplessPreparedTransition(101), true, mode);
    assert.deepEqual([...e.state.shuffleHistory], ['a'], mode);
  }
});

test('single natural EOF repeats through the common prepared commit path', async () => {
  const e = setup();
  e.state.playMode = 'single';
  await e.manager.prepareGaplessNext();
  await flush();
  await naturalEndHandler(e)();
  assert.equal(e.state.currentTrackId, 'a');
  assert.deepEqual(e.calls.commits, [15]);
  assert.equal(e.calls.loads.length, 0);
  assert.deepEqual(e.calls.history, ['a']);
});

test('switching playback mode keeps native auto-loop disabled and prepares the new target', async () => {
  const e = setup();
  const unwatch = watch(
    () => e.manager.getGaplessInvalidationKey(),
    () => e.manager.clearGaplessPreparedSource(),
    { flush: 'sync' },
  );
  for (const mode of ['single', 'list', 'single', 'sequential']) {
    e.audioManager.setPlayMode(mode);
    assert.equal(e.calls.loops.at(-1), false);
    await e.manager.prepareGaplessNext();
    await flush();
    assert.equal(
      e.calls.prepared.at(-1).source.url,
      `https://audio.test/${mode === 'single' ? 'a' : 'b'}.flac`,
    );
  }
  e.audioManager.setPlayMode('random');
  assert.equal(e.calls.loops.at(-1), false);
  await e.manager.prepareGaplessNext();
  await flush();
  assert.match(e.calls.prepared.at(-1).source.url, /\/(b|c)\.flac$/);
  unwatch();
});

test('single none and failed preparation both repeat A through ordinary playback', async () => {
  for (const mode of ['none', 'fade']) {
    const e = setup({ prepare: () => Promise.reject(new Error('decode failed')) });
    e.state.playMode = 'single';
    e.settings.effectiveTrackTransitionMode = mode;
    await e.manager.prepareGaplessNext();
    await flush();
    await naturalEndHandler(e)();
    assert.equal(e.state.currentTrackId, 'a', mode);
    assert.equal(e.calls.loads[0].url, 'https://audio.test/a.flac', mode);
    assert.equal(e.calls.loads.length, 1, mode);
    assert.deepEqual(e.calls.commits, []);
    assert.deepEqual(e.calls.loops, [false]);
  }
});

test('single manual next advances and consumes queued-next instead of adopting its repeat', async () => {
  for (const queued of [false, true]) {
    const e = setup();
    e.state.playMode = 'single';
    e.queue.queuedNextTrackIds = queued ? ['c'] : [];
    await e.manager.prepareGaplessNext();
    await flush();
    assert.equal(e.calls.prepared[0].source.url, 'https://audio.test/a.flac');
    assert.deepEqual([...e.queue.queuedNextTrackIds], queued ? ['c'] : []);
    await e.manager.next();
    assert.equal(e.state.currentTrackId, queued ? 'c' : 'b');
    assert.deepEqual(e.calls.commits, []);
    assert.deepEqual(e.calls.loops, [false]);
  }
});

test('single repeat preserves the current quality and source selection', async () => {
  const e = setup();
  e.state.playMode = 'single';
  e.state.currentAudioQualityOverride = '320';
  e.state.currentCatalogSourceOverrideTrackId = 'a';
  e.state.currentCloudSourceOverrideTrackId = 'a';
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentAudioQualityOverride, '320');
  assert.equal(e.state.currentCatalogSourceOverrideTrackId, 'a');
  assert.equal(e.state.currentCloudSourceOverrideTrackId, 'a');
});

test('single retained preparation cannot adopt a boundary from an earlier native occurrence', async () => {
  const e = setup();
  e.state.playMode = 'single';
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  e.state.nativeTrackSeq = 77;
  e.state.awaitingTrackLoad = true;
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.nativeTrackSeq, 77);
  assert.deepEqual(e.calls.adopted, []);
});

test('single settings-only invalidation accepts a running repeat under its original mode', async () => {
  const e = setup();
  e.state.playMode = 'single';
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  assert.equal(
    e.manager.activateGaplessPreparedTransition(101, 1.5, { mode: 'fade', overlapSecs: 3 }),
    true,
  );
  assert.equal(e.state.currentTrackId, 'a');
  assert.equal(e.state.currentTime, 1.5);
  assert.deepEqual(e.calls.loads, []);
  assert.deepEqual(e.calls.history, ['a']);
});

test('random EOF commits the exact prepared source and records history once', async () => {
  const e = setup();
  e.state.playMode = 'random';
  const unwatch = watch(
    () => e.manager.getGaplessInvalidationKey(),
    () => e.manager.clearGaplessPreparedSource(),
    { flush: 'sync' },
  );
  await e.manager.prepareGaplessNext();
  await flush();
  const targetIndex = e.state.shuffleQueue[0];
  await e.manager.next({ gaplessTransition: true });
  assert.equal(e.state.currentTrackId, ['a', 'b', 'c'][targetIndex]);
  assert.deepEqual(e.calls.commits, [15]);
  assert.equal(e.calls.loads.length, 0);
  assert.deepEqual([...e.state.shuffleHistory], ['a']);
  await e.manager.prev();
  await flush();
  assert.equal(e.state.currentTrackId, 'a');
  assert.deepEqual([...e.state.shuffleHistory], []);
  unwatch();
});

test('random failed preparation loads the same candidate using its resolved URL', async () => {
  let resolutions = 0;
  const e = setup({
    prepare: () => Promise.reject(new Error('decode failed')),
    resolve: async (song) => {
      resolutions++;
      return { url: `https://audio.test/${song.id}.flac` };
    },
  });
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const targetIndex = e.state.shuffleQueue[0];
  await e.manager.next({ gaplessTransition: true });
  assert.equal(e.state.currentTrackId, ['a', 'b', 'c'][targetIndex]);
  assert.equal(resolutions, 1);
  assert.equal(e.calls.loads.length, 1);
  assert.deepEqual(e.calls.commits, []);
  assert.deepEqual([...e.state.shuffleHistory], ['a']);
  assert.equal(e.state.shuffleQueue.length, 1);
});

test('random manual skips advance each click without waiting for native preparation', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const firstId = ['a', 'b', 'c'][e.state.shuffleQueue[0]];
  const secondId = ['a', 'b', 'c'][e.state.shuffleQueue[1]];
  const first = e.manager.next();
  assert.equal(e.state.currentTrackId, firstId);
  const second = e.manager.next();
  assert.equal(e.state.currentTrackId, secondId);
  await Promise.all([first, second]);
  assert.deepEqual(e.calls.commits, []);
  assert.deepEqual([...e.state.shuffleHistory], ['a', firstId]);
  assert.equal(e.state.shuffleQueue.length, 0);
});

test('random queued-next wins during preparation and does not consume another random candidate', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const originalQueue = [...e.state.shuffleQueue];
  const queuedId = ['a', 'b', 'c'][originalQueue[1]];
  e.queue.queuedNextTrackIds = [queuedId];
  e.queue.playbackRevision++;
  e.playlist.consumeQueuedNextTrackIds = (ids) => {
    e.queue.queuedNextTrackIds = e.queue.queuedNextTrackIds.filter((id) => !ids.includes(id));
  };
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared.at(-1).source.url, `https://audio.test/${queuedId}.flac`);
  assert.deepEqual([...e.state.shuffleQueue], originalQueue);
  assert.deepEqual([...e.queue.queuedNextTrackIds], [queuedId]);
  assert.equal(e.manager.activateGaplessPreparedTransition(102), true);
  assert.equal(e.state.currentTrackId, queuedId);
  assert.deepEqual([...e.queue.queuedNextTrackIds], []);
  e.state.currentTime = 80;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(
    e.calls.prepared.at(-1).source.url,
    `https://audio.test/${['a', 'b', 'c'][originalQueue[0]]}.flac`,
  );
  assert.equal(e.manager.activateGaplessPreparedTransition(103), true);
  assert.deepEqual([...e.state.shuffleHistory], ['a', queuedId]);
});

test('random settings invalidation retains the candidate without consuming the cycle', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const originalQueue = [...e.state.shuffleQueue];
  e.changeSettings();
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared[0].source.url, e.calls.prepared[1].source.url);
  assert.deepEqual([...e.state.shuffleQueue], originalQueue);
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.deepEqual([...e.state.shuffleQueue], originalQueue.slice(1));
  assert.deepEqual([...e.state.shuffleHistory], ['a']);
});

test('random preparation after direct selection skips the song already selected', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const originalQueue = [...e.state.shuffleQueue];
  const selectedId = ['a', 'b', 'c'][originalQueue[0]];
  await e.manager.playTrack(selectedId, e.queue.songs, { sourceQueueId: e.queue.id });
  e.state.duration = 100;
  e.state.currentTime = 80;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(
    e.calls.prepared.at(-1).source.url,
    `https://audio.test/${['a', 'b', 'c'][originalQueue[1]]}.flac`,
  );
  assert.deepEqual([...e.state.shuffleQueue], originalQueue.slice(1));
});

test('random queue append preserves pending candidates and adds new tracks', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  const originalQueue = [...e.state.shuffleQueue];
  e.queue.songs = [...e.queue.songs, { id: 'd', hash: 'd', duration: 100 }];
  e.queue.playbackRevision++;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.deepEqual([...e.state.shuffleQueue], [...originalQueue, 3]);
  assert.equal(e.calls.prepared[0].source.url, e.calls.prepared[1].source.url);
});

test('random queue replacement discards stale index mappings before preparing', async () => {
  const e = setup();
  e.state.playMode = 'random';
  await e.manager.prepareGaplessNext();
  await flush();
  e.queue.songs = ['a', 'd', 'e'].map((id) => ({ id, hash: id, duration: 100 }));
  e.queue.playbackRevision++;
  await e.manager.prepareGaplessNext();
  await flush();
  assert.match(e.calls.prepared.at(-1).source.url, /\/(d|e)\.flac$/);
  assert.equal(e.manager.activateGaplessPreparedTransition(102), true);
  assert.ok(['d', 'e'].includes(e.state.currentTrackId));
});

test('random preparation skips unplayable songs even when the current song is absent', async () => {
  const e = setup({ playable: (song) => !!song && song.id !== 'b' });
  e.state.playMode = 'random';
  e.state.currentTrackId = 'removed';
  e.queue.songs = e.queue.songs.slice(1);
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared[0].source.url, 'https://audio.test/c.flac');
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'c');
});

test('random none uses ordinary playback and does not repeat within a shuffle cycle', async () => {
  const e = setup();
  e.state.playMode = 'random';
  e.settings.effectiveTrackTransitionMode = 'none';
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 0);
  await e.manager.next();
  const firstId = e.state.currentTrackId;
  await e.manager.next();
  assert.notEqual(e.state.currentTrackId, firstId);
  assert.notEqual(e.state.currentTrackId, 'a');
  await e.manager.next();
  assert.equal(e.state.shuffleQueue.length, 1, 'starts a new cycle excluding its current track');
});

test('random single-song queues can prepare and adopt the same song', async () => {
  const e = setup();
  e.state.playMode = 'random';
  e.queue.songs = e.queue.songs.slice(0, 1);
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.calls.prepared[0].source.url, 'https://audio.test/a.flac');
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'a');
});

test('discover always advances forward under list, single and random playback modes', async () => {
  for (const mode of ['list', 'single', 'random']) {
    const e = setup({ discover: true });
    e.state.playMode = mode;
    await e.manager.next();
    assert.equal(e.state.currentTrackId, 'b', mode);
    assert.equal(e.calls.loops.at(-1), false, mode);
  }
});

test('discover waits for a fresh batch at the tail, and never preloads the first song again', async () => {
  let complete;
  let requests = 0;
  const e = setup({
    discover: true,
    replenish: (queue) => {
      requests++;
      return new Promise((resolve) => {
        complete = () => {
          queue.songs = [...queue.songs, { id: 'd', hash: 'd', duration: 100 }];
          queue.playbackRevision++;
          resolve(1);
        };
      });
    },
  });
  e.state.currentTrackId = 'c';
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 0);
  const pending = e.manager.next({ gaplessTransition: true });
  assert.equal(requests, 1);
  assert.equal(e.state.currentTrackId, 'c');
  complete();
  await pending;
  assert.equal(e.state.currentTrackId, 'd');
});

test('discover ends without wrapping when no new recommendations are available', async () => {
  const e = setup({ discover: true });
  e.state.currentTrackId = 'c';
  await e.manager.next();
  assert.equal(e.state.currentTrackId, 'c');
  assert.equal(e.state.enginePlayback.status, 'paused');
  assert.equal(e.calls.loads.length, 0);
  assert.equal(e.calls.notices.length, 1);
});

test('discover waiting for a tail batch yields to pause, seek and sleep', async () => {
  for (const interrupt of [
    (state) => {
      state.playbackIntent.shouldPlay = false;
    },
    (state) => {
      state.seekTimestamp++;
    },
    (state) => {
      state.autoNextSuppressed = true;
    },
  ]) {
    let complete;
    const e = setup({
      discover: true,
      replenish: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    e.state.currentTrackId = 'c';
    const pending = e.manager.next({ gaplessTransition: true });
    interrupt(e.state);
    complete(0);
    await pending;
    assert.equal(e.calls.loads.length, 0);
    assert.equal(e.calls.notices.length, 0);
  }
});

test('discover ignores a late tail response after switching playback source', async () => {
  let complete;
  const e = setup({
    discover: true,
    replenish: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  e.state.currentTrackId = 'c';
  const pending = e.manager.next();
  e.state.currentSourceQueueId = 'queue:other';
  e.state.playbackRequestSeq++;
  complete(0);
  await pending;
  assert.equal(e.calls.loads.length, 0);
  assert.equal(e.calls.notices.length, 0);
});

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
    true,
    'duplicate boundary is handled without falling through to ordinary file-loaded',
  );
  assert.equal(e.calls.adopted.length, 1, 'boundary is committed once');
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

for (const mode of ['automix-pro', 'automix-basic', 'fade', 'gapless']) {
  test(`FM ${mode} adopts B exactly once with native position and loudness`, async () => {
    const e = setup({ fm: true });
    e.settings.effectiveTrackTransitionMode = mode;
    const unwatch = watch(
      () => e.manager.getGaplessInvalidationKey(),
      () => e.manager.clearGaplessPreparedSource(),
      { flush: 'sync' },
    );
    await e.manager.prepareGaplessNext();
    await flush();
    assert.deepEqual(
      e.queue.songs.map((s) => s.id),
      ['a'],
    );
    assert.deepEqual(
      e.playlist.personalFmBuffer.map((s) => s.id),
      ['b', 'c'],
    );
    assert.deepEqual(e.calls.history, []);
    assert.equal(
      e.manager.activateGaplessPreparedTransition(101, 1.3, { mode, overlapSecs: 3 }),
      true,
    );
    assert.equal(
      e.manager.activateGaplessPreparedTransition(101, 1.3, { mode, overlapSecs: 3 }),
      true,
    );
    assert.equal(e.state.currentTrackId, 'b');
    assert.equal(e.state.currentTime, 1.3);
    assert.deepEqual(
      e.queue.songs.map((s) => s.id),
      ['a', 'b'],
    );
    assert.deepEqual(
      e.playlist.personalFmBuffer.map((s) => s.id),
      ['c'],
    );
    assert.deepEqual(e.calls.history, ['b']);
    assert.equal(e.calls.loads.length, 0);
    assert.equal(e.calls.adopted.length, 1);
    assert.equal(e.calls.adoptedLoudness.length, 1);
    assert.equal(e.calls.notices.length, 1);
    const feedback = e.fmStore.requests.filter((params) => params.action);
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].playtime, 80, 'smart hand-off reports actual listening position');
    assert.equal(feedback[0].is_overplay, 0);
    unwatch();
  });
}

for (const playMode of ['single', 'random']) {
  test(`FM ignores saved ${playMode} for next selection and native looping`, async () => {
    const e = setup({ fm: true });
    e.state.playMode = playMode;
    await e.manager.prepareGaplessNext();
    await flush();
    assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
    assert.equal(e.state.currentTrackId, 'b');
    assert.deepEqual(e.calls.loops, [false]);
    assert.equal(e.state.playMode, playMode);
  });
}

test('FM none uses ordinary advance and commits B only after load acceptance', async () => {
  let finish;
  const e = setup({
    fm: true,
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  e.settings.effectiveTrackTransitionMode = 'none';
  await e.manager.prepareGaplessNext();
  assert.equal(e.calls.prepared.length, 0);
  const playback = e.manager.advancePersonalFm(true);
  await flush();
  assert.equal(e.calls.loads.length, 1);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['b', 'c'],
  );
  assert.deepEqual(e.calls.history, []);
  finish();
  await playback;
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(e.calls.history, ['b']);
  assert.deepEqual(
    e.queue.songs.map((s) => s.id),
    ['a', 'b'],
  );
});

test('FM failed preparation falls back to the same B without consuming C', async () => {
  const e = setup({ fm: true, prepare: () => Promise.reject(new Error('decode failed')) });
  await e.manager.prepareGaplessNext();
  await flush();
  await e.manager.advancePersonalFm(true);
  assert.equal(e.state.currentTrackId, 'b');
  assert.deepEqual(e.calls.history, ['b']);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['c'],
  );
  assert.equal(e.calls.loads.length, 1);
});

test('FM prepared URL is reused for immediate manual next, without another analysis', async () => {
  let resolutions = 0;
  const e = setup({
    fm: true,
    resolve: async (song) => {
      resolutions++;
      return { url: `https://audio.test/${song.id}.flac` };
    },
  });
  await e.manager.prepareGaplessNext();
  await flush();
  await e.manager.next();
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(resolutions, 1);
  assert.equal(e.calls.loads.length, 1);
  assert.equal(e.calls.adopted.length, 0);
});

test('FM dislike does not await feedback or mix the disliked track', async () => {
  const callbacks = [];
  const e = setup({ fm: true, fetch: () => new Promise((resolve) => callbacks.push(resolve)) });
  assert.equal(await e.manager.dislikePersonalFm(), true);
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(e.calls.prepared.length, 0);
  assert.deepEqual(
    e.queue.songs.map((s) => s.id),
    ['b'],
  );
  assert.equal(e.fmStore.requests.filter((params) => params.action === 'garbage').length, 1);
  assert.equal(e.fmStore.requests.filter((params) => params.action === 'play').length, 0);
  for (const finish of callbacks) finish([]);
  await flush();
});

test('FM session replacement discards an in-flight ordinary load without consuming its candidate', async () => {
  let finish;
  const e = setup({
    fm: true,
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const playback = e.manager.next();
  await flush();
  e.playlist.personalFmSessionEpoch++;
  e.playlist.personalFmBuffer = [{ id: 'new' }];
  finish();
  await playback;
  assert.deepEqual(e.calls.history, []);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['new'],
  );
  assert.equal(e.state.awaitingTrackLoad, false);
  assert.equal(e.state.enginePlayback.status, 'stopped');
});

test('late FM boundary cannot replace a newer direct selection', async () => {
  const e = setup({ fm: true });
  await e.manager.prepareGaplessNext();
  await flush();
  await e.manager.playPersonalFmTrack({ id: 'c', hash: 'c', duration: 100 });
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'c');
  assert.deepEqual(e.calls.history, ['c']);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['b'],
  );
});

test('settings-only FM invalidation adopts an already-audible B without reloading', async () => {
  const e = setup({ fm: true });
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  assert.equal(e.manager.activateGaplessPreparedTransition(101, 3), true);
  assert.equal(e.state.currentTrackId, 'b');
  assert.equal(e.state.currentTime, 3);
  assert.equal(e.calls.loads.length, 0);
});

test('FM foreign queued-next takes priority over buffer and forward history', async () => {
  const e = setup({ fm: true });
  e.queue.songs.push({ id: 'history', hash: 'history', duration: 100 });
  e.playlist.playbackQueues.push({
    id: 'foreign',
    songs: [{ id: 'inserted', duration: 100 }],
    playbackRevision: 0,
    queuedNextTrackIds: ['inserted'],
  });
  await e.manager.prepareGaplessNext();
  await flush();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'inserted');
  assert.equal(e.state.currentSourceQueueId, 'foreign');
  assert.equal(e.playlist.activeQueueId, 'foreign');
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['b', 'c'],
  );
  assert.deepEqual(e.playlist.getQueueById('foreign').queuedNextTrackIds, []);
});

test('FM expired prepared URL can fully resolve again and still commit B once', async () => {
  let resolutions = 0;
  const e = setup({
    fm: true,
    resolve: async () => ({ url: ++resolutions === 1 ? 'expired' : 'fresh' }),
    load: async (source) => {
      if (source.url === 'expired') throw new Error('expired');
    },
  });
  await e.manager.prepareGaplessNext();
  await flush();
  await e.manager.next();
  assert.equal(resolutions, 2);
  assert.deepEqual(
    e.calls.loads.map((s) => s.url),
    ['expired', 'fresh'],
  );
  assert.equal(e.state.currentTrackId, 'b');
  assert.deepEqual(e.calls.history, ['b']);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['c'],
  );
  assert.equal(e.state.enginePlayback.status, 'playing');
});

for (const action of ['seek', 'stop', 'pause', 'quality', 'sleep']) {
  test(`FM waiting for recommendations yields to ${action}`, async () => {
    let finish;
    const e = setup({
      fm: true,
      timers: manualTimers(),
      fetch: (params) =>
        params.action
          ? Promise.resolve([])
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    e.playlist.personalFmBuffer = [];
    const advance = e.manager.advancePersonalFm(true);
    await flush();
    assert.equal(typeof finish, 'function');
    if (action === 'seek') await e.manager.seek(50);
    if (action === 'stop') e.manager.stop();
    if (action === 'pause') await e.manager.togglePlay();
    if (action === 'quality') e.state.playbackRequestSeq++;
    if (action === 'sleep') e.state.autoNextSuppressed = true;
    finish([{ id: 'new', hash: 'new', duration: 100 }]);
    await advance;
    assert.equal(e.calls.loads.length, 0);
    assert.deepEqual(e.calls.history, []);
  });
}

test('FM empty/offline recommendations finish in a stopped state', async () => {
  const e = setup({
    fm: true,
    fetch: async () => {
      throw new Error('offline');
    },
  });
  e.playlist.personalFmBuffer = [];
  await e.manager.advancePersonalFm(true);
  assert.equal(e.state.enginePlayback.status, 'stopped');
  assert.equal(e.state.awaitingTrackLoad, false);
  assert.equal(e.calls.loads.length, 0);
});

test('FM preparation completed after replaying A retains its original request identity', async () => {
  let finish;
  const e = setup({
    fm: true,
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await e.manager.prepareGaplessNext();
  await flush();
  e.changeSettings();
  await e.manager.playPersonalFmTrack(e.queue.songs[0]);
  finish(101);
  await flush();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.state.currentTrackId, 'a');
  assert.deepEqual(e.calls.history, ['a']);
  assert.equal(e.calls.loads.length, 1);
});

test('FM rejected old-session boundary falls back to a fresh candidate only once', async () => {
  const e = setup({ fm: true });
  await e.manager.prepareGaplessNext();
  await flush();
  e.playlist.personalFmSessionEpoch++;
  e.playlist.personalFmBuffer = [{ id: 'new', hash: 'new', duration: 100 }];
  e.manager.clearGaplessPreparedSource();
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  assert.equal(e.manager.activateGaplessPreparedTransition(101), true);
  await flush();
  assert.equal(e.state.currentTrackId, 'new');
  assert.deepEqual(e.calls.history, ['new']);
  assert.equal(e.calls.loads.length, 1);
});

test('a queued-next insertion arriving during FM refill still wins', async () => {
  let finish;
  const e = setup({
    fm: true,
    fetch: (params) =>
      params.action
        ? Promise.resolve([])
        : new Promise((resolve) => {
            finish = resolve;
          }),
  });
  e.playlist.personalFmBuffer = [];
  const advance = e.manager.advancePersonalFm(true);
  await flush();
  e.playlist.playbackQueues.push({
    id: 'foreign',
    songs: [{ id: 'inserted', hash: 'inserted', duration: 100 }],
    queuedNextTrackIds: ['inserted'],
  });
  finish([{ id: 'fm-new', hash: 'fm-new', duration: 100 }]);
  await advance;
  assert.equal(e.state.currentTrackId, 'inserted');
  assert.deepEqual(e.calls.history, ['inserted']);
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['fm-new'],
  );
});

test('FM preview selection creates a missing queue and commits only the selected song', async () => {
  const e = setup({ fm: true });
  e.playlist.playbackQueues = [];
  await e.manager.playPersonalFmTrack({ id: 'c', hash: 'c', duration: 100 });
  assert.equal(e.state.currentTrackId, 'c');
  assert.deepEqual(e.calls.history, ['c']);
  assert.deepEqual(
    e.playlist.activeQueue.songs.map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['b'],
  );
});

test('FM previous ignores shuffle history and never wraps past the first song', async () => {
  const e = setup({ fm: true });
  e.state.playMode = 'random';
  e.state.shuffleHistory = ['c'];
  await e.manager.playPersonalFmTrack({ id: 'b', hash: 'b', duration: 100 });
  await e.manager.prev();
  assert.equal(e.state.currentTrackId, 'a');
  await e.manager.prev();
  assert.equal(e.state.currentTrackId, 'a');
  assert.deepEqual(e.calls.history, ['b', 'a']);
});

test('FM exhausted failure retry budget leaves an error state rather than a busy loop', async () => {
  const timers = manualTimers();
  const e = setup({
    fm: true,
    timers,
    resolve: async () => {
      throw new Error('offline');
    },
  });
  e.settings.autoNext = true;
  e.settings.autoNextMaxAttempts = 1;
  await e.manager.next();
  assert.equal(e.state.currentTrackId, 'b');
  timers.advance(1);
  await flush();
  assert.equal(e.state.currentTrackId, 'c');
  assert.equal(e.state.autoNextAttempts, 1);
  assert.equal(e.state.enginePlayback.status, 'error');
  assert.equal(e.state.autoNextTimer, null);
  assert.deepEqual(e.calls.history, []);
  assert.deepEqual(
    e.queue.songs.map((s) => s.id),
    ['a'],
  );
  assert.deepEqual(
    e.playlist.personalFmBuffer.map((s) => s.id),
    ['c'],
  );
});

test('round14: pending FM queue creation receives playback ownership and cancels on stop', async () => {
  const e = setup({ fm: true });
  e.playlist.playbackQueues = [];
  e.playlist.personalFmBuffer = [];
  let finish, options;
  e.playlist.startPersonalFm = (value) => {
    options = value;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const operation = e.manager.playPersonalFmTrack();
  assert.equal(typeof options?.isCurrent, 'function');
  assert.equal(options.isCurrent(), true);
  e.manager.stop();
  assert.equal(options.isCurrent(), false);
  finish(true);
  await operation;
  assert.deepEqual(e.calls.history, []);
});
