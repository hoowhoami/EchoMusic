// 直播流时间轴语义（feat/engine-streaming-sync）：
// 1) engine 依据 file-loaded 的 capabilities 落定 live/finite，live 时 seek 静默忽略；
// 2) store 的 resume 对直播走"重新加入"（重走解析加载），不触引擎恢复；
// 3) seek 门禁在 store 层同样吞掉直播 seek；
// 4) beginNativeTrackLoad 在换源时重置直播标记，等待新 capabilities 落定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function compile(file, mocks = {}, window = {}) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('.')) throw new Error(`Unmocked dependency: ${name}`);
      return require(name);
    },
    mod,
    mod.exports,
    window,
  );
  return mod.exports;
}

const stateMachine = compile('../src/renderer/stores/player/stateMachine.ts');
const { createPlayerState } = compile('../src/renderer/stores/player/state.ts', {
  '../../../shared/playback': { DEFAULT_PLAYER_VOLUME: 50, matchesPendingSeekTarget: () => false },
  './sleepTimer': { createSleepTimerState: () => ({}) },
});

const song = {
  id: 'song-1',
  name: 'Live radio',
  artist: 'Station',
  hash: 'LIVE',
  coverUrl: '',
  duration: 0,
  album: '',
  artists: [],
  qualities: ['standard'],
};

// ── engine 层：capabilities → isLive/seek 门禁 ──
function engineWindow(bridgeCalls) {
  // 捕获 preload 桥注册的 file-loaded 回调，模拟主进程事件到达。
  const fileLoadedCallbacks = [];
  const player = {
    onTimeUpdate: () => () => {},
    onDurationChange: () => () => {},
    onStateChange: () => () => {},
    onPlaybackEnd: () => () => {},
    onError: () => () => {},
    onFileLoaded: (handler) => {
      fileLoadedCallbacks.push(handler);
      return () => {};
    },
    seek: (target) => {
      bridgeCalls.push(['seek', target]);
      return Promise.resolve();
    },
    play: () => {
      bridgeCalls.push(['play']);
      return Promise.resolve();
    },
    pause: () => {
      bridgeCalls.push(['pause']);
      return Promise.resolve();
    },
  };
  const window = { electron: { player } };
  const emitFileLoaded = (payload) => fileLoadedCallbacks.forEach((handler) => handler(payload));
  return { window, emitFileLoaded };
}
const engineMocks = {
  './logger': logger,
  '../../shared/loudness': {
    calculateNormalizationGainDb: () => 0,
    DEFAULT_REFERENCE_LUFS: -14,
  },
  '../../shared/playback': { DEFAULT_PLAYER_VOLUME: 50, matchesPendingSeekTarget: () => false },
};

test('engine 落定直播能力后 seek 被静默忽略', async () => {
  const bridgeCalls = [];
  const { window, emitFileLoaded } = engineWindow(bridgeCalls);
  const { PlayerEngine } = compile('../src/renderer/utils/player.ts', engineMocks, window);
  const engine = new PlayerEngine();
  assert.equal(engine.isLive, false, '未上报能力前必须保持非直播的既有行为');
  emitFileLoaded({ capabilities: { timelineKind: 'live', seekable: false } });
  assert.equal(engine.isLive, true);
  assert.equal(engine.mediaCapabilities?.timelineKind, 'live');
  await engine.seek(30);
  assert.deepEqual(bridgeCalls, [], '直播时间轴不得向 native 发送 seek 命令');
});

test('engine 收到 finite 能力后 seek 正常下发', async () => {
  const bridgeCalls = [];
  const { window, emitFileLoaded } = engineWindow(bridgeCalls);
  const { PlayerEngine } = compile('../src/renderer/utils/player.ts', engineMocks, window);
  const engine = new PlayerEngine();
  emitFileLoaded({ capabilities: { timelineKind: 'finite', seekable: true } });
  assert.equal(engine.isLive, false);
  await engine.seek(30);
  assert.deepEqual(bridgeCalls, [['seek', 30]]);
});

test('engine 换源后未上报新能力前回落 unknown，不残留直播判定', () => {
  const bridgeCalls = [];
  const { window, emitFileLoaded } = engineWindow(bridgeCalls);
  const { PlayerEngine } = compile('../src/renderer/utils/player.ts', engineMocks, window);
  const engine = new PlayerEngine();
  emitFileLoaded({ capabilities: { timelineKind: 'live', seekable: false } });
  assert.equal(engine.isLive, true);
  // 换源路径 file-loaded 未携带 capabilities 时回落 unknown（保持既有行为）。
  emitFileLoaded({});
  assert.equal(engine.isLive, false);
  assert.equal(engine.mediaCapabilities, undefined);
});

// ── store 层：seek 门禁与 resume 重新加入 ──
function playbackFixture({ live }) {
  const engineCalls = [];
  const resolverCalls = [];
  const engine = {
    // 换源/预加载/媒体会话等本路径用不到的成员给宽松实现，缺方法在迭代中按需补。
    source: 'https://example.com/live.m3u8',
    duration: 0,
    volume: 50,
    normalizationGainDb: null,
    volumeNormalizationEnabled: false,
    getEmbeddedMetadata: async () => ({}),
    getTrackLoudnessGainDb: () => null,
    adoptPreparedSource: () => {},
    adoptPreparedTrackLoudness: () => {},
    applyTrackLoudness: () => {},
    beginNextSourcePreparation: () => ({ promise: Promise.resolve() }),
    beginSourceChange: () => Promise.resolve(1001),
    cancelNextSourcePreparation: () => {},
    clearPreparedNextSource: () => {},
    commitPreparedNextSource: () => {},
    reloadSource: () => Promise.resolve(),
    reset: () => {},
    setLoopFile: () => {},
    setPlaybackRate: () => {},
    setSource: () => Promise.resolve(),
    setVolume: () => {},
    updateMediaMetadata: () => {},
    updateMediaPlaybackState: () => engineCalls.push(['updateMediaPlaybackState']),
    seek: (target) => {
      engineCalls.push(['seek', target]);
      return Promise.resolve();
    },
    play: () => {
      engineCalls.push(['play']);
      return Promise.resolve();
    },
    pause: () => {
      engineCalls.push(['pause']);
      return Promise.resolve();
    },
  };
  const playlistStore = {
    activeQueue: { id: 'queue:home-discover', songs: [song], currentTrackId: song.id },
    activeQueueId: 'queue:home-discover',
    defaultList: [song],
    favorites: [],
    playbackQueues: [],
    lastNonFmQueueId: 'queue:home-discover',
    personalFmSessionEpoch: 0,
    updateQueueCurrentTrack: () => {},
    consumeQueuedNextTrackIds: () => [],
    syncQueuedNextTrackIds: () => {},
    ensurePlaybackQueueSongsLoaded: async () => {},
    getQueueById: () => null,
    removeFromQueue: () => {},
    replenishDiscoverQueue: async () => {},
    replenishPersonalFmBuffer: async () => {},
    setActiveQueue: () => {},
    startPersonalFm: async () => {},
    commitPersonalFmCandidate: () => {},
    peekNextPersonalFmCandidate: () => null,
    reportPersonalFmAdvance: async () => {},
    skipFailedPersonalFmCandidate: () => {},
  };
  const settingStore = {
    syncPreventSleep: () => {},
    autoNext: false,
    autoNextDelaySeconds: 1,
    autoNextMaxAttempts: 3,
    playResumeTimeout: 5,
    defaultAudioQuality: 'standard',
    compatibilityMode: false,
    effectiveTrackTransitionMode: 'none',
    fadeCrossSecs: 0,
    mvAudioFallbackEnabled: false,
    playbackStallMaxAttempts: 3,
    volumeFade: false,
    volumeFadeTime: 0,
    volumeNormalizationLufs: -14,
  };
  // 解析挂起：rejoin 触发一次 resolveAudioUrl 后停在等待，不再驱动后续加载。
  const pendingResolve = defer();
  const resolver = {
    resolveAudioUrl: (track) => {
      resolverCalls.push(track?.id);
      return pendingResolve.promise;
    },
    transformAudioSource: async () => null,
    fetchClimaxMarks: () => {},
  };
  const playlistMocks = {
    '../playlist': {
      DISCOVER_QUEUE_ID: 'queue:home-discover',
      PERSONAL_FM_QUEUE_ID: 'queue:personal-fm',
    },
    '../playlist/helpers': { toRawSong: (track) => track, toRawSongList: (list) => [...list] },
    '../historyStore': { useHistoryStore: () => ({ recordPlay: () => {} }) },
    '../toast': { useToastStore: () => ({}) },
  };
  const mocks = {
    '@/utils/logger': logger,
    './embeddedMetadata': {
      createEmbeddedMetadataCompleter: () => ({ complete: async () => {} }),
    },
    '../../../shared/playbackQueueDecision': {
      buildNextTrackDecisionKey: () => 'key',
      findPlaybackSourceQueue: () => null,
      resolveOrderedPlaybackMode: (mode) => mode,
      resolvePlaybackSourceQueueId: () => playlistStore.activeQueueId,
      resolveQueuedNextTrackDecision: () => null,
      resolveNextTrackDecision: () => null,
    },
    '../../../shared/playbackQueueExecution': { consumePlayedQueuedNextTrack: () => null },
    '@/utils/song': { isPlayableSong: () => true },
    '@/utils/player': { normalizePlayerErrorPayload: (error) => error },
    ...playlistMocks,
    './utils': {
      buildMediaMeta: (track) => ({ title: track?.name }),
      buildMediaState: () => ({}),
      buildStoppedPlaybackState: () => ({ playbackRate: 1 }),
      clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
      findPlayableIndex: () => 0,
      findTrackById: (list, id) => list.find((item) => String(item.id) === String(id)),
      normalizeQuality: (value) => value,
      normalizeEffect: () => 'none',
      summarizeSong: () => ({}),
      resolveAudioFailureReason: () => 'unknown',
      resolvePlaybackNotice: () => ({}),
      resolveTrackMxid: () => null,
      resolveUrlFromResponse: () => '',
      resolveUrlsFromResponse: () => [],
      resolveTrackLoudness: () => null,
    },
    './mvAudio': {
      canFallbackToMvAudio: () => false,
      captureMvAudioSession: () => ({}),
      resolveMvAudioSource: async () => null,
    },
    './queueAdvancePolicy': {
      canPrepareGaplessForQueue: () => false,
      getQueueAdvanceAuthority: () => ({ authority: 'none' }),
    },
    '../../../shared/trackTransition': {
      formatTrackTransitionNotice: () => '',
      transitionPrefetchLeadSecs: 5,
      transitionPreparationTimeoutSecs: 10,
      transitionPreparesNextTrack: () => false,
    },
    './stateMachine': stateMachine,
  };
  const state = createPlayerState();
  Object.assign(state, {
    currentTrackId: song.id,
    currentTrackSnapshot: { ...song },
    currentSourceQueueId: 'queue:home-discover',
    currentAudioUrl: engine.source,
    currentPlaybackSource: { url: engine.source, audioTrackId: null },
    currentPlaylist: [song],
    isLiveStream: live,
    playbackEnded: false,
    isPlaying: false,
  });
  const playback = compile('../src/renderer/stores/player/playback.ts', mocks, {
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const manager = playback.createPlaybackManager(
    state,
    engine,
    playlistStore,
    settingStore,
    {
      clear: () => {},
      currentCandidateKey: null,
      fetchLyrics: async () => {},
      setLyric: () => {},
    },
    resolver,
    { resetHistoryUploadState: () => {} }, // historyManager
    () => {}, // showPlaybackNotice
    () => {}, // clearPlaybackNotice
  );
  return { state, manager, engineCalls, resolverCalls, playlistStore };
}

test('直播流暂停恢复走重新加入，不触引擎恢复', async () => {
  const { state, manager, engineCalls, resolverCalls } = playbackFixture({ live: true });
  // togglePlay 的恢复分支对直播源应立即改走 playTrack（重新解析加载）；
  // 解析 mock 挂起，因此只需 flush 微任务后断言恢复路径的分流结果。
  const resuming = manager.togglePlay();
  // 只拦截 rejection 打印，不 await 主体：解析 mock 永久挂起，await 会卡死测试。
  resuming.catch((error) => {
    console.error('togglePlay rejected:', error);
  });
  await flush();
  assert.ok(resolverCalls.includes('song-1'), '恢复必须重走音源解析（重新加入直播）');
  assert.equal(
    engineCalls.some(([action]) => action === 'play' || action === 'pause'),
    false,
    '直播恢复不得走引擎级 play/pause',
  );
  assert.equal(state.isResuming, false, '重走解析不属于引擎恢复护栏路径');
  // 挂起的解析 promise 在测试结束后无人 resolve，也不会产生 rejection。
  void resuming;
});

test('直播流 seek 在 store 层被静默吞掉', async () => {
  const { state, manager, engineCalls } = playbackFixture({ live: true });
  await manager.seek(30);
  assert.equal(
    engineCalls.some(([action]) => action === 'seek'),
    false,
    '直播时间轴不可 seek，store 必须先行拦截',
  );
  assert.equal(state.seekTargetTime, null, '被吞掉的 seek 不得登记 seek 目标');
});

test('非直播源 seek 正常下发引擎', async () => {
  const { state, manager, engineCalls } = playbackFixture({ live: false });
  state.duration = 240;
  await manager.seek(30);
  // mock 的引擎 seek 立即完成并触发完成回调清空 seekTargetTime，
  // 因此只断言"门禁放行、命令下发"这个核心事实。
  assert.deepEqual(
    engineCalls.filter(([action]) => action === 'seek'),
    [['seek', 30]],
  );
});

// ── stateMachine：换源重置直播标记 ──
test('beginNativeTrackLoad 重置直播标记，等待新 capabilities 落定', () => {
  const state = createPlayerState();
  state.isLiveStream = true;
  state.nativeTrackSeq = 13;
  stateMachine.beginNativeTrackLoad(state);
  assert.equal(state.isLiveStream, false, '新源能力未知前不得沿用上一首的直播判定');
  assert.equal(state.awaitingTrackLoad, true);
  assert.equal(state.nativeTrackSeq, null);
});
