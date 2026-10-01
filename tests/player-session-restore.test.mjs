import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { effectScope, nextTick, reactive } from 'vue';
import * as contract from '../src/shared/playerSession.ts';

const require = createRequire(import.meta.url);
function compile(file, mocks = {}, window) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('.')) throw new Error(`Unmocked dependency: ${name}`);
      return require(name);
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
}

const stateMachine = compile('../src/renderer/stores/player/stateMachine.ts');
const renderer = compile('../src/renderer/stores/player/session.ts', {
  '../../../shared/playerSession': contract,
  './stateMachine': stateMachine,
});
const host = compile('../src/main/player/session.ts', {
  '../../shared/playerSession': contract,
});
const defaults = compile('../src/renderer/stores/player/state.ts', {
  '../../../shared/playback': { DEFAULT_PLAYER_VOLUME: 50 },
  './sleepTimer': { createSleepTimerState: () => ({}) },
});
const song = {
  id: '312274678',
  name: 'Test track',
  artist: 'Test artist',
  hash: 'ABC',
  artists: [{ id: 123, name: 'Test artist' }],
  coverUrl: 'https://example.com/cover.jpg',
  duration: 240,
  album: 'Test album',
  qualities: ['high', 'hires', 'viper_tape'],
};
function fixture(queueId = 'queue:home-discover') {
  const state = defaults.createPlayerState();
  Object.assign(state, {
    currentTrackId: song.id,
    currentTrackSnapshot: structuredClone(song),
    currentSourceQueueId: queueId,
    nativeTrackSeq: 13,
    currentAudioUrl: 'https://example.com/audio.flac',
    currentPlaybackSource: { url: 'https://example.com/audio.flac', audioTrackId: null },
    currentPlaylist: [structuredClone(song), { ...song, id: 'next' }],
    currentResolvedAudioQuality: 'hires',
    historyLocalRecorded: true,
    historyUploadCommitted: true,
    historyUploadTrackId: song.id,
  });
  const queue = {
    id: queueId,
    title: '刷歌',
    subtitle: '',
    coverUrl: song.coverUrl,
    type: 'home-discover',
    songs: state.currentPlaylist,
    currentTrackId: song.id,
    queuedNextTrackIds: [],
    filteredInvalidCount: 0,
    createdAt: 1,
    updatedAt: 2,
    dynamic: true,
    meta: {},
  };
  const session = structuredClone(renderer.capturePlayerSession(state, queue));
  const transport = {
    playing: false,
    paused: true,
    duration: 240,
    timePos: 72,
    idle: false,
    trackSeq: 13,
    speed: 1.25,
  };
  return { state, session, transport, owner: {}, cache: host.createPlayerSessionCache() };
}

for (const queueId of ['queue:home-discover', 'queue:personal-fm', 'queue:playlist:123']) {
  test(`renderer reload restores live metadata and source queue: ${queueId}`, () => {
    const { session, transport, cache, owner } = fixture(queueId);
    cache.sync(session, owner, transport);
    const fresh = defaults.createPlayerState();
    const restored = cache.get(owner, transport);
    assert.ok(restored);
    assert.equal(renderer.restorePlayerSession(fresh, restored), true);
    assert.deepEqual(fresh.currentTrackSnapshot, song);
    assert.equal(fresh.currentSourceQueueId, queueId);
    assert.equal(restored.session.queue.songs[1].id, 'next');
    assert.equal(fresh.nativeTrackSeq, 13);
    assert.equal(fresh.currentTime, 72);
    assert.equal(fresh.duration, 240);
    assert.equal(fresh.playbackRate, 1.25);
    assert.equal(fresh.currentResolvedAudioQuality, 'hires');
    assert.equal(fresh.currentPlaybackSource.url, 'https://example.com/audio.flac');
    assert.equal(fresh.awaitingTrackLoad, false);
    assert.equal(fresh.historyLocalRecorded, true);
    assert.equal(fresh.historyUploadCommitted, true);
    assert.equal(stateMachine.getPlaybackIsPlaying(fresh), false);
    const resumed = cache.get(owner, { ...transport, playing: true, paused: false, timePos: 73 });
    renderer.restorePlayerSession(fresh, resumed);
    assert.equal(fresh.currentTrackId, song.id);
    assert.equal(fresh.currentTime, 73);
    assert.equal(stateMachine.getPlaybackIsPlaying(fresh), true);
  });
}

test('cold startup, stopped playback and replacement engines do not restore transient sessions', () => {
  const { session, transport, cache, owner } = fixture();
  assert.equal(cache.get(owner, transport), null);
  cache.sync(session, owner, transport);
  assert.equal(cache.get({}, transport), null);
  assert.equal(cache.get(owner, { ...transport, idle: true }), null);
  assert.equal(cache.get(owner, { ...transport, trackSeq: 14 }), null);
  assert.equal(cache.get(owner, null), null);
  cache.clear();
  assert.equal(cache.get(owner, transport), null);
});

test('stale or unbound metadata cannot replace the live session', () => {
  const { session, transport, cache, owner } = fixture();
  cache.sync(session, owner, transport);
  const stale = structuredClone(session);
  stale.player.nativeTrackSeq = 12;
  stale.player.currentTrackSnapshot.name = 'Stale track';
  cache.sync(stale, owner, transport);
  assert.deepEqual(cache.get(owner, transport).session, session);
  const loading = structuredClone(session);
  loading.player.nativeTrackSeq = null;
  assert.equal(contract.matchesPlayerSession(loading, transport), false);
  const wrongSong = structuredClone(session);
  wrongSong.player.currentTrackSnapshot.id = 'other';
  const fresh = defaults.createPlayerState();
  assert.equal(renderer.restorePlayerSession(fresh, { session: wrongSong, transport }), false);
  assert.equal(fresh.currentTrackId, null);
});

function ipcFixture() {
  const { session, transport } = fixture();
  const handlers = new Map();
  const calls = [];
  const ref = {
    current: {
      getState: () => transport,
      clearPreparedNextSource: () => calls.push('clear-prepared'),
      stop: async () => {
        calls.push('stop');
        transport.idle = true;
      },
    },
  };
  const { registerPlayerIpc } = compile('../src/main/ipc/player.ts', {
    './registry': { ipcRegistry: { registerHandler: (key, fn) => handlers.set(key, fn) } },
    electron: { app: { getPath: () => '/tmp' }, dialog: {} },
    '../player': { restartPlayer: async () => ref.current },
    '../outputs/outputHost': { getOutputHost: () => null },
    '../player/audioEffectCommand': {},
    '../player/dspProviderRegistry': { DspProviderRegistry: class {} },
    '../player/session': host,
    '../logger': { warn() {} },
  });
  registerPlayerIpc(ref);
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { session, transport, calls, ref, invoke };
}

test('IPC recovers live playback without loading or restarting audio and discards old prepared transitions', async () => {
  const { session, transport, calls, invoke } = ipcFixture();
  assert.equal(await invoke('player:get-runtime-session'), null);
  assert.deepEqual(calls, []);
  await invoke('player:sync-runtime-session', session);
  const restored = await invoke('player:get-runtime-session');
  assert.deepEqual(restored, { session, transport });
  assert.deepEqual(calls, ['clear-prepared']);
  await invoke('player:sync-runtime-session', null);
  assert.equal(await invoke('player:get-runtime-session'), null);
});

test('IPC stop and restart invalidate cached metadata even if the engine reuses its sequence', async () => {
  for (const channel of ['player:stop', 'player:restart']) {
    const { session, transport, invoke } = ipcFixture();
    await invoke('player:sync-runtime-session', session);
    await invoke(channel);
    transport.idle = false;
    assert.equal(await invoke('player:get-runtime-session'), null);
  }
});

test('IPC will not return the previous song if a native transition wins during recovery', async () => {
  const { session, transport, ref, invoke } = ipcFixture();
  await invoke('player:sync-runtime-session', session);
  ref.current.clearPreparedNextSource = () => {
    transport.trackSeq += 1;
  };
  assert.equal(await invoke('player:get-runtime-session'), null);
});

test('a delayed session update cannot undo an explicit stop or session clear', async () => {
  for (const channel of ['player:stop', 'player:sync-runtime-session']) {
    const { session, transport, ref, invoke } = ipcFixture();
    let finish;
    ref.current.getState = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = invoke('player:sync-runtime-session', session);
    await invoke(channel, null);
    finish({ ...transport, idle: false });
    await pending;
    ref.current.getState = () => ({ ...transport, idle: false });
    assert.equal(await invoke('player:get-runtime-session'), null);
  }
});

test('real player-store init restores the transient queue before publishing metadata and accepts wake events', async () => {
  const { session, transport } = fixture();
  const calls = [];
  const published = [];
  let events;
  const noop = () => {};
  const manager = new Proxy({}, { get: () => noop });
  class Engine {
    setEvents(value) {
      events = value;
    }
    adoptPreparedSource(source) {
      this.source = source;
      calls.push('adopt-source');
    }
    updateMediaMetadata(meta) {
      calls.push(['metadata', meta.title]);
    }
    pause() {
      return Promise.resolve();
    }
    getAudioGraph() {
      return Promise.resolve(null);
    }
  }
  for (const name of [
    'setMediaSessionHandlers',
    'updateMediaPlaybackState',
    'updateMediaSkipIntervals',
    'adoptPreparedTrackLoudness',
    'setPlaybackRate',
    'setEqualizer',
    'setVolumeNormalization',
    'setReferenceLufs',
    'setLoopFile',
    'setStallTimeout',
    'setTransitionSettings',
  ])
    Engine.prototype[name] = noop;
  for (const name of ['setSource', 'reloadSource', 'play']) {
    Engine.prototype[name] = () => {
      throw new Error(`Unexpected audio command: ${name}`);
    };
  }
  const playlist = reactive({
    activeQueueId: 'queue:durable',
    activeQueue: { id: 'queue:durable', currentTrackId: 'old', songs: [{ ...song, id: 'old' }] },
    playbackQueues: [],
    getQueueById(id) {
      return this.playbackQueues.find((queue) => queue.id === id) ?? null;
    },
    upsertPlaybackQueueInMemory(queue) {
      this.playbackQueues.push(queue);
      this.activeQueue = queue;
    },
    updateQueueCurrentTrack(id) {
      this.activeQueue.currentTrackId = id;
    },
    replenishDiscoverQueue: noop,
  });
  const settings = {
    dspProviderPresetJson: '',
    getSelectedImpulseResponse: () => null,
    reconcileSpatialAudioEffects: async () => {},
    $subscribe: () => noop,
    syncPreventSleep: noop,
  };
  const lyric = { updateCurrentIndex: noop, fetchLyrics: async () => {} };
  const mocks = {
    pinia: { defineStore: (_name, setup) => setup },
    './playlist': {
      usePlaylistStore: () => playlist,
      DISCOVER_QUEUE_ID: session.queue.id,
      PERSONAL_FM_QUEUE_ID: 'queue:personal-fm',
    },
    './lyric': { useLyricStore: () => lyric },
    './setting': { useSettingStore: () => settings },
    './toast': { useToastStore: () => manager },
    './user': { useUserStore: () => ({}) },
    '@/utils/logger': { info: noop, warn: noop, error: noop },
    '@/utils/player': { PlayerEngine: Engine },
    '../../shared/playback': {
      createPlaybackClock: () => () => ({ positionMs: 0 }),
      matchesPendingSeekTarget: () => true,
    },
    '../../shared/latestRequestQueue': { createLatestRequestQueue: () => ({ enqueue: noop }) },
    '../../shared/playbackQueueDecision': {},
    '../../shared/audioEffectSupport': { spatialAudioEffectOptions: () => null },
    '../../shared/dspProviderSettings': {},
    './player/state': defaults,
    './player/session': renderer,
    './player/stateMachine': stateMachine,
    './player/sleepTimer': { createSleepTimer: () => manager },
    './player/playback': { createPlaybackManager: () => manager },
    './player/audio': { createAudioManager: () => manager },
    './player/resolver': { createResolver: () => manager },
    './player/history': { createHistoryManager: () => manager },
    './player/listeningTime': {
      createListeningTimeManager: () => ({ flush: async () => {}, resetPosition: noop }),
    },
    './player/device': { createDeviceManager: () => manager },
    './player/spatialAudioSupport': { createSpatialAudioSupport: () => manager },
    './player/progressStatus': { shouldShowPlaybackBuffering: () => false },
    './player/events': { createPlayerEventBus: () => manager },
    './player/utils': {
      normalizeEffect: () => 'none',
      buildMediaState: () => ({}),
      buildMediaMeta: (track) => ({ title: track.name }),
    },
    './playlist/helpers': { toRawSong: (track) => track },
  };
  const { usePlayerStore } = compile('../src/renderer/stores/player.ts', mocks, {
    electron: {
      player: {
        getRuntimeSession: async () => structuredClone({ session, transport }),
        getState: async () => structuredClone(transport),
        syncRuntimeSession: async (snapshot) => published.push(structuredClone(snapshot)),
        setPauseOnDeviceDisconnect: noop,
      },
    },
  });
  const scope = effectScope();
  const store = scope.run(() => reactive(usePlayerStore()));
  try {
    let initialized = false;
    const ready = store.whenInitialized().then(() => {
      initialized = true;
    });
    await Promise.resolve();
    assert.equal(initialized, false);
    assert.equal(await store.init(), true, 'live recovery must not trigger cold-start autoplay');
    await ready;
    assert.equal(initialized, true);
    await nextTick();
    assert.equal(store.currentTrackId, song.id);
    assert.equal(playlist.activeQueueId, session.queue.id);
    assert.equal(playlist.activeQueue.songs[1].id, 'next');
    assert.equal(published[0].queue.id, session.queue.id);
    assert.equal(published[0].player.currentTrackSnapshot.artists[0].id, 123);
    assert.ok(calls.includes('adopt-source'));
    assert.ok(calls.some((call) => call[0] === 'metadata' && call[1] === song.name));
    events.play({ trackSeq: 13, time: 73 });
    assert.equal(store.isPlaying, true);
    assert.equal(store.currentTrackId, song.id);
    assert.equal(store.currentTime, 73);
    events.pause({ trackSeq: 12, time: 0 });
    assert.equal(store.isPlaying, true);
    assert.equal(store.currentTime, 73);
    const count = published.length;
    store.playbackIntent.phase = 'loading';
    store.nativeTrackSeq = null;
    store.currentTrackId = 'next';
    store.currentTrackSnapshot = { ...song, id: 'next' };
    await nextTick();
    assert.equal(published.length, count, 'uncommitted song metadata must not be published');
    store.nativeTrackSeq = 14;
    store.playbackIntent.phase = 'ready';
    await nextTick();
    assert.equal(published.at(-1).player.nativeTrackSeq, 14);
    assert.equal(published.at(-1).player.currentTrackSnapshot.id, 'next');
  } finally {
    scope.stop();
  }
});
