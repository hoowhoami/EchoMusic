import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { createFmStore, constants, helpers } from './helpers/personal-fm.mjs';
const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const sessionSource = transformSync(read('../src/renderer/utils/userSession.ts'), {
  loader: 'ts',
  format: 'cjs',
}).code;
const sessionModule = { exports: {} };
new Function('module', 'exports', sessionSource)(sessionModule, sessionModule.exports);
const { descriptor } = parse(read('../src/renderer/views/PersonalFm.vue'));
const script = transformSync(compileScript(descriptor, { id: 'fm-lifecycle' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await vue.nextTick();
  await new Promise((r) => setImmediate(r));
};
const song = (id) => ({
  id: String(id),
  hash: String(id),
  name: String(id),
  duration: 100,
  curMark: `mark-${id}`,
});
const changeSession = (user, change) => {
  if (change === 'revision') user.accountRevision++;
  if (change === 'token') user.info.token = 'two';
  if (change === 'userid') user.info.userid = 8;
  if (change === 'logout') user.isLoggedIn = false;
};
const queueSnapshot = (store) => JSON.parse(JSON.stringify(store.playbackQueues));
for (const preserveQueue of [true, false]) {
  test(`round14: FM reset uses requested mode and pool while preserving queue=${preserveQueue}`, async () => {
    const { store, requests } = createFmStore({ fetch: async () => [song('new')] });
    store.activeQueue.meta = { mode: 'normal', song_pool_id: 0 };
    store.activeQueue.songs[0].curMark = 'mark-a';
    const before = queueSnapshot(store);
    await store.resetPersonalFmPreview({
      mode: 'radio',
      songPoolId: 2,
      preserveQueue,
      action: 'change_song_pool',
    });
    assert.equal(requests[0].mode, 'radio');
    assert.equal(requests[0].song_pool_id, 2);
    assert.equal(requests[0].cur_mark, 'mark-a');
    if (preserveQueue) assert.deepEqual(queueSnapshot(store), before);
    else {
      assert.equal(store.activeQueue.songCount, 0);
      assert.deepEqual(store.activeQueue.songs, []);
    }
    assert.equal(store.personalFmBuffer[0].id, 'new');
  });
}
for (const failure of ['network']) {
  test(`round14: ${failure} reset failure preserves FM queue buffer and preferences`, async () => {
    const { store } = createFmStore({
      fetch: async () => {
        if (failure === 'network') throw new Error('network');
        return failure === 'business'
          ? { status: 0, data: { list: [song('bad')] } }
          : { status: 1, data: {} };
      },
    });
    const queues = queueSnapshot(store),
      buffer = store.personalFmBuffer.slice();
    const result = await store.resetPersonalFmPreview({ mode: 'radio', songPoolId: 2 });
    assert.equal(result, null);
    assert.deepEqual(queueSnapshot(store), queues);
    assert.deepEqual(store.personalFmBuffer, buffer);
    assert.equal(store.personalFmMode, 'normal');
    assert.equal(store.personalFmSongPoolId, 0);
  });
}
test('round14: reset keeps the active FM queue until a successful response commits', async (t) => {
  const request = deferred();
  t.after(() => request.resolve([]));
  const { store } = createFmStore({ fetch: () => request.promise });
  const before = queueSnapshot(store),
    buffer = store.personalFmBuffer.slice();
  const operation = store.resetPersonalFmPreview({ mode: 'radio' });
  assert.deepEqual(queueSnapshot(store), before);
  assert.deepEqual(store.personalFmBuffer, buffer);
  request.resolve([song('new')]);
  await operation;
  assert.deepEqual(store.activeQueue.songs, []);
  assert.equal(store.personalFmBuffer[0].id, 'new');
});
test('round14: failed old reset cannot restore preferences or sync a replaced session', async () => {
  const old = deferred();
  let requests = 0;
  const { store } = createFmStore({
    fetch: () => (++requests === 1 ? old.promise : Promise.resolve([song('new')])),
  });
  let syncs = 0;
  store.syncLegacyPlaybackState = () => syncs++;
  const first = store.resetPersonalFmPreview({ mode: 'radio' });
  await store.resetPersonalFmPreview({ mode: 'small', songPoolId: 2 });
  const committedSyncs = syncs;
  old.reject(new Error('old'));
  await first;
  assert.equal(store.personalFmMode, 'small');
  assert.equal(store.personalFmSongPoolId, 2);
  assert.equal(store.personalFmBuffer[0].id, 'new');
  assert.equal(syncs, committedSyncs);
});
test('round14: reset cannot clear a same-ID FM queue recreated during its request', async () => {
  const read = deferred();
  const { store } = createFmStore({ fetch: () => read.promise });
  const operation = store.resetPersonalFmPreview({ mode: 'radio' });
  store.playbackQueues = [
    { ...store.activeQueue, songs: [song('replacement')], currentTrackId: 'replacement' },
  ];
  read.resolve([song('old')]);
  assert.equal(await operation, null);
  assert.equal(store.activeQueue.songs[0].id, 'replacement');
  assert.equal(store.personalFmBuffer[0].id, 'b');
});
for (const change of ['revision', 'token', 'userid', 'logout']) {
  test(`round14: ${change} invalidates pending raw FM and feedback results`, async () => {
    const read = deferred();
    const { store, user } = createFmStore({ fetch: () => read.promise });
    const raw = store.fetchPersonalFmSongs();
    const feedback = store.reportPersonalFmFeedback('click_red', store.activeQueue.songs[0]);
    const before = store.personalFmBuffer.slice();
    changeSession(user, change);
    read.resolve([song('old')]);
    assert.deepEqual(await raw, []);
    assert.equal(await feedback, 0);
    assert.deepEqual(store.personalFmBuffer, before);
  });
  test(`round14: ${change} allows a new refill without reusing the old session flight`, async (t) => {
    const old = deferred(),
      current = deferred();
    t.after(() => {
      old.resolve([]);
      current.resolve([]);
    });
    let calls = 0;
    const { store, user, requests } = createFmStore({
      fetch: () => (++calls === 1 ? old.promise : current.promise),
    });
    const first = store.replenishPersonalFmBuffer();
    changeSession(user, change);
    const second = store.replenishPersonalFmBuffer();
    assert.equal(requests.length, 2);
    old.resolve([song('old')]);
    assert.equal(await first, 0);
    store.replenishPersonalFmBuffer();
    assert.equal(requests.length, 2);
    current.resolve([song('new')]);
    assert.equal(await second, 1);
    assert.ok(store.personalFmBuffer.some((s) => s.id === 'new'));
    assert.equal(
      store.personalFmBuffer.some((s) => s.id === 'old'),
      false,
    );
  });
}
test('round14: ordinary profile replacement preserves refill flight and commits its response', async () => {
  const read = deferred();
  const { store, user, requests } = createFmStore({ fetch: () => read.promise });
  const first = store.replenishPersonalFmBuffer();
  user.info = { ...user.info, nickname: 'changed' };
  const second = store.replenishPersonalFmBuffer();
  assert.equal(requests.length, 1);
  read.resolve([song('new')]);
  assert.equal(await first, 1);
  assert.equal(await second, 1);
});
test('round14: duplicate cold FM starts share one request and activate once', async (t) => {
  const read = deferred();
  t.after(() => read.resolve([]));
  const { store, requests } = createFmStore({
    buffer: [],
    queue: { id: constants.PERSONAL_FM_QUEUE_ID, songs: [], meta: {}, queuedNextTrackIds: [] },
    fetch: () => read.promise,
  });
  store.activeQueueId = 'other';
  let syncs = 0;
  store.syncLegacyPlaybackState = () => syncs++;
  const first = store.startPersonalFm(),
    second = store.startPersonalFm();
  assert.equal(requests.length, 1);
  read.resolve([song('new')]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(syncs, 1);
  assert.equal(store.activeQueueId, constants.PERSONAL_FM_QUEUE_ID);
});
for (const change of ['activeQueue', 'queue', 'session']) {
  test(`round14: cold FM start cannot commit after ${change} changes`, async () => {
    const read = deferred();
    const { store, user } = createFmStore({
      buffer: [],
      queue: { id: constants.PERSONAL_FM_QUEUE_ID, songs: [], meta: {}, queuedNextTrackIds: [] },
      fetch: () => read.promise,
    });
    const task = store.startPersonalFm();
    if (change === 'activeQueue') store.activeQueueId = 'other';
    if (change === 'queue')
      store.playbackQueues = [{ ...store.activeQueue, songs: [song('replacement')] }];
    if (change === 'session') user.accountRevision++;
    read.resolve([song('old')]);
    assert.equal(await task, false);
    assert.deepEqual(store.personalFmBuffer, []);
    if (change === 'activeQueue') assert.equal(store.activeQueueId, 'other');
  });
}
test('round14: failed cold start releases its flight for retry', async () => {
  let calls = 0;
  const { store, requests } = createFmStore({
    buffer: [],
    queue: { id: constants.PERSONAL_FM_QUEUE_ID, songs: [], meta: {}, queuedNextTrackIds: [] },
    fetch: async () => {
      if (++calls === 1) throw new Error('failure');
      return [song('new')];
    },
  });
  await assert.rejects(store.startPersonalFm());
  assert.equal(await store.startPersonalFm(), true);
  assert.equal(requests.length, 2);
});
test('round14: current explicit empty FM and song-list aliases remain valid', async () => {
  const { store } = createFmStore({ fetch: async () => ({ status: 1, data: { list: null } }) });
  assert.deepEqual(await store.fetchPersonalFmSongs(), []);
  store.fetchPersonalFmSongs = async () => [song('new')];
  assert.equal(await store.startPersonalFm(), true);
});

function pageFixture(t, loggedIn = true) {
  const hooks = Object.fromEntries(
    ['onMounted', 'onActivated', 'onDeactivated', 'onBeforeUnmount'].map((key) => [key, []]),
  );
  const calls = [],
    plays = [],
    observers = [];
  const user = vue.reactive({
    isLoggedIn: loggedIn,
    accountRevision: 0,
    info: { userid: 7, token: 'one' },
  });
  let resetPending = true,
    reset = async () => song('new'),
    start = async () => true;
  const playlist = vue.reactive({
    personalFmMode: 'normal',
    personalFmSongPoolId: 0,
    personalFmBuffer: [],
    activeQueueId: constants.PERSONAL_FM_QUEUE_ID,
    playbackQueues: [
      { id: constants.PERSONAL_FM_QUEUE_ID, songs: [song('current')], currentTrackId: 'current' },
    ],
    isPersonalFmSessionResetPending: () => resetPending,
    getPersonalFmPreviewTrack: () =>
      playlist.personalFmBuffer[0] ?? playlist.playbackQueues[0]?.songs[0] ?? null,
    getPersonalFmDisplayTracks: () => playlist.personalFmBuffer,
    resetPersonalFmPreview: (...args) => {
      calls.push(['reset', ...args]);
      return reset(...args);
    },
    startPersonalFm: (...args) => {
      calls.push(['start', ...args]);
      return start(...args);
    },
  });
  const player = vue.reactive({
    playbackRequestSeq: 0,
    currentSourceQueueId: constants.PERSONAL_FM_QUEUE_ID,
    currentTrackId: 'current',
    isPlaying: false,
    playPersonalFmTrack: async (track) => {
      plays.push(['play', track]);
      player.playbackRequestSeq++;
    },
    togglePlay: async () => plays.push(['toggle']),
    dislikePersonalFm: async () => plays.push(['dislike']),
  });
  class Observer {
    constructor(fn) {
      this.fn = fn;
      this.nodes = [];
      observers.push(this);
    }
    observe(node) {
      this.nodes.push(node);
    }
    disconnect() {
      this.nodes = [];
    }
    fire() {
      this.fn();
    }
  }
  const deps = {
    vue: {
      ...vue,
      ...Object.fromEntries(
        Object.entries(hooks).map(([key, list]) => [key, (fn) => list.push(fn)]),
      ),
    },
    '@/stores/playlist': { usePlaylistStore: () => playlist, ...constants, ...helpers },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/theme': { useThemeStore: () => ({ sourceColor: '#fff' }) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/utils/cover': { createThemedIconCoverUrl: () => '' },
    '@/utils/song': { getSongQualityTags: () => [] },
    '@/utils/userSession': sessionModule.exports,
    '@/icons': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'ResizeObserver', script)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    mod,
    mod.exports,
    Observer,
  );
  const scope = vue.effectScope();
  const view = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    hooks.onBeforeUnmount.forEach((fn) => fn());
    scope.stop();
  };
  t.after(stop);
  return {
    view,
    user,
    player,
    playlist,
    calls,
    plays,
    observers,
    stop,
    reset: (fn) => {
      reset = fn;
    },
    start: (fn) => {
      start = fn;
    },
    pending: (value) => {
      resetPending = value;
    },
    mount: () => hooks.onMounted.forEach((fn) => fn()),
    deactivate: () => hooks.onDeactivated.forEach((fn) => fn()),
    activate: () => hooks.onActivated.forEach((fn) => fn()),
  };
}
for (const change of [
  'revision',
  'token',
  'logout',
  'unmount',
  'deactivate',
  'playback',
  'queue',
]) {
  test(`round14: page play waiting for preview yields to ${change}`, async (t) => {
    const f = pageFixture(t),
      read = deferred();
    f.reset(() => read.promise);
    const preload = f.view.preloadPersonalFmPreview();
    const task = f.view.handlePlayPersonalFm();
    if (['revision', 'token', 'logout'].includes(change)) changeSession(f.user, change);
    if (change === 'unmount') f.stop();
    if (change === 'deactivate') f.deactivate();
    if (change === 'playback') f.player.playbackRequestSeq++;
    if (change === 'queue') f.playlist.activeQueueId = 'other';
    read.resolve(song('new'));
    await preload;
    await task;
    assert.equal(
      f.calls.some(([kind]) => kind === 'start'),
      false,
    );
    assert.deepEqual(f.plays, []);
  });
}
for (const action of ['mode', 'pool']) {
  for (const change of ['unmount', 'revision', 'deactivate', 'playback', 'queue']) {
    test(`round14: ${action} switch cannot resume after ${change}`, async (t) => {
      const f = pageFixture(t),
        read = deferred();
      f.reset(() => read.promise);
      const task =
        action === 'mode'
          ? f.view.handleChangePersonalFmMode('radio')
          : f.view.handleChangePersonalFmSongPool(2);
      if (change === 'unmount') f.stop();
      if (change === 'revision') f.user.accountRevision++;
      if (change === 'deactivate') f.deactivate();
      if (change === 'playback') f.player.playbackRequestSeq++;
      if (change === 'queue') f.playlist.activeQueueId = 'other';
      read.resolve(song('new'));
      await task;
      assert.deepEqual(f.plays, []);
    });
  }
}
test('round14: page old preload completion cannot clear a new session flight', async (t) => {
  const f = pageFixture(t),
    old = deferred(),
    current = deferred();
  f.reset(() => old.promise);
  const first = f.view.preloadPersonalFmPreview();
  f.user.accountRevision++;
  f.reset(() => current.promise);
  await flush();
  const second = f.view.preloadPersonalFmPreview();
  const count = f.calls.length;
  old.resolve(null);
  await first;
  assert.equal(f.view.personalFmPreloading.value, true);
  assert.equal(f.view.preloadPersonalFmPreview(), second);
  assert.equal(f.calls.length, count);
  current.resolve(song('new'));
  await second;
  assert.equal(f.view.personalFmPreloading.value, false);
});
test('round14: page old operation cannot release new session busy state', async (t) => {
  const f = pageFixture(t),
    old = deferred(),
    current = deferred();
  f.reset(() => old.promise);
  const first = f.view.handleChangePersonalFmMode('radio');
  f.user.accountRevision++;
  f.reset(() => current.promise);
  const second = f.view.handleChangePersonalFmSongPool(2);
  old.resolve(song('old'));
  await first;
  assert.equal(f.view.personalFmLoading.value, true);
  const count = f.calls.length;
  await f.view.handleChangePersonalFmMode('small');
  assert.equal(f.calls.length, count);
  current.resolve(song('new'));
  await second;
  assert.equal(f.view.personalFmLoading.value, false);
  assert.equal(f.plays.length, 1);
});
test('round14: FM page login after mount loads a preview and ordinary profile update reuses it', async (t) => {
  const f = pageFixture(t, false);
  f.mount();
  assert.equal(f.calls.length, 0);
  f.user.isLoggedIn = true;
  await flush();
  assert.equal(f.calls.length, 1);
  f.user.info = { ...f.user.info, nickname: 'new' };
  await flush();
  assert.equal(f.calls.length, 1);
});
test('round14: page failed mode or pool switch does not restart playback', async (t) => {
  const f = pageFixture(t);
  f.reset(async () => null);
  await f.view.handleChangePersonalFmMode('radio');
  await f.view.handleChangePersonalFmSongPool(2);
  assert.deepEqual(f.plays, []);
  assert.equal(f.view.personalFmLoading.value, false);
});
test('round14: current mode switch plays once and releases busy state after playback sequence changes', async (t) => {
  const f = pageFixture(t);
  await f.view.handleChangePersonalFmMode('radio');
  assert.equal(f.plays.length, 1);
  assert.equal(f.view.personalFmLoading.value, false);
});
test('round14: mode switching while another queue plays cannot begin FM when it later becomes active', async (t) => {
  const f = pageFixture(t),
    read = deferred();
  f.playlist.activeQueueId = 'other';
  f.reset(() => read.promise);
  const task = f.view.handleChangePersonalFmMode('radio');
  f.playlist.activeQueueId = constants.PERSONAL_FM_QUEUE_ID;
  read.resolve(song('new'));
  await task;
  assert.deepEqual(f.plays, []);
});
test('round14: unmounted and logged-out page callbacks do not submit any actions', async (t) => {
  const f = pageFixture(t);
  f.stop();
  await f.view.handlePlayPersonalFm();
  await f.view.handleSelectPersonalFmTrack(song('b'));
  await f.view.handleChangePersonalFmMode('radio');
  await f.view.handleChangePersonalFmSongPool(2);
  await f.view.handleDislikePersonalFm();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.plays, []);
});
test('round14: vinyl observer binds after a late element and ignores stopped callbacks', async (t) => {
  const f = pageFixture(t);
  f.user.isLoggedIn = false;
  f.mount();
  const element = vue.markRaw({ clientWidth: 300 });
  f.view.personalFmVinylsRef.value = element;
  await flush();
  assert.equal(f.observers.length, 1);
  f.deactivate();
  assert.deepEqual(f.observers[0].nodes, []);
  const count = f.view.personalFmVisibleSideCount.value;
  element.clientWidth = 1000;
  f.observers[0].fire();
  assert.equal(f.view.personalFmVisibleSideCount.value, count);
  f.activate();
  assert.equal(f.observers.length, 2);
  assert.equal(f.view.personalFmVisibleSideCount.value, 3);
  f.stop();
  assert.deepEqual(f.observers[1].nodes, []);
});

test('round14: cancelled FM start cannot activate a queue or reuse its flight', async (t) => {
  const old = deferred(),
    current = deferred();
  t.after(() => {
    old.resolve([]);
    current.resolve([]);
  });
  let reads = 0;
  const { store, requests } = createFmStore({
    buffer: [],
    queue: { id: constants.PERSONAL_FM_QUEUE_ID, songs: [], meta: {}, queuedNextTrackIds: [] },
    fetch: () => (++reads === 1 ? old.promise : current.promise),
  });
  store.activeQueueId = 'other';
  let owned = true;
  const first = store.startPersonalFm({ isCurrent: () => owned });
  owned = false;
  const second = store.startPersonalFm();
  old.resolve([song('old')]);
  assert.equal(await first, false);
  assert.equal(store.activeQueueId, 'other');
  assert.equal(requests.length, 2);
  current.resolve([song('new')]);
  assert.equal(await second, true);
  assert.equal(store.personalFmBuffer[0].id, 'new');
});
test('round14: already cancelled FM start does not mutate preferences or issue requests', async () => {
  const { store, requests } = createFmStore();
  const before = queueSnapshot(store);
  assert.equal(
    await store.startPersonalFm({ mode: 'radio', fresh: true, isCurrent: () => false }),
    false,
  );
  assert.equal(requests.length, 0);
  assert.equal(store.personalFmMode, 'normal');
  assert.deepEqual(queueSnapshot(store), before);
});
test('round14: page supplies its ownership check to pending startup', async (t) => {
  const f = pageFixture(t),
    read = deferred();
  f.start(() => read.promise);
  const task = f.view.handlePlayPersonalFm();
  const options = f.calls.find(([kind]) => kind === 'start')[1];
  assert.equal(typeof options?.isCurrent, 'function');
  assert.equal(options.isCurrent(), true);
  f.deactivate();
  assert.equal(options.isCurrent(), false);
  read.resolve(true);
  await task;
  assert.deepEqual(f.plays, []);
});
