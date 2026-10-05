import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as playback from '../src/shared/playback.ts';
import * as loudness from '../src/shared/loudness.ts';
import * as nowPlaying from '../src/shared/nowPlaying.ts';
import * as opencc from '../src/shared/opencc.ts';
import { createLyricTimeline } from '../src/renderer/composables/useLyricTimeline.ts';

const require = createRequire(import.meta.url);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const compile = (file, mocks, window = {}) => {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => (name in mocks ? mocks[name] : require(name)),
    module,
    module.exports,
    window,
  );
  return module.exports;
};
const clockFixture = (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(Date, 'now', () => 10_000 + elapsed);
  const source = {
    trackId: 'a',
    trackSeq: 1,
    currentTime: 10,
    duration: 200,
    isPlaying: true,
    isAdvancing: true,
    playbackRate: 1,
    updatedAt: Date.now(),
  };
  const update = playback.createPlaybackClock();
  return {
    source,
    read: () => ({ clock: update(source) }),
    advance: (ms) => {
      elapsed += ms;
    },
  };
};

test('all windows interpolate the same raw sample once, including IPC delay', (t) => {
  const f = clockFixture(t);
  const sample = f.read();
  const page = createLyricTimeline();
  assert.equal(page.getPlaybackMs(sample), 10_000);
  f.advance(250);
  const desktop = createLyricTimeline();
  const plugin = createLyricTimeline();
  assert.equal(desktop.getPlaybackMs(sample), 10_250);
  assert.equal(
    plugin.getPlaybackMs(JSON.parse(JSON.stringify(sample))),
    page.getPlaybackMs(sample),
  );
  assert.equal(f.read().clock.positionMs, 10_000, 'rebuilding does not project the source');
  f.advance(5000);
  for (const timeline of [page, desktop, plugin]) {
    assert.equal(timeline.getPlaybackMs(f.read()), 11_800);
  }
});

test('small backward seek delivered after 800ms resets every cursor', (t) => {
  const f = clockFixture(t);
  const timeline = createLyricTimeline();
  timeline.getPlaybackMs(f.read());
  const revision = timeline.revision;
  f.source.currentTime = 9.8;
  f.source.seekTimestamp = Date.now();
  f.source.isAdvancing = false;
  const pending = f.read();
  f.advance(2000);
  assert.equal(timeline.getPlaybackMs(pending), 9800);
  assert.ok(timeline.revision > revision);
  f.source.isAdvancing = true;
  assert.equal(timeline.getPlaybackMs(f.read()), 9800);
  f.advance(250);
  f.source.currentTime = 10.05;
  f.source.updatedAt = Date.now();
  assert.equal(timeline.getPlaybackMs(f.read()), 10_050);
});

test('pause/resume and speed changes start new segments without retrospective extrapolation', (t) => {
  const f = clockFixture(t);
  const timeline = createLyricTimeline();
  timeline.getPlaybackMs(f.read());
  f.advance(250);
  f.source.currentTime = 10.25;
  f.source.updatedAt = Date.now();
  f.source.isPlaying = false;
  assert.equal(timeline.getPlaybackMs(f.read()), 10_250);
  f.advance(500);
  f.source.isPlaying = true;
  assert.equal(timeline.getPlaybackMs(f.read()), 10_250);
  f.advance(250);
  f.source.currentTime = 10.5;
  f.source.updatedAt = Date.now();
  timeline.getPlaybackMs(f.read());
  f.source.playbackRate = 2;
  assert.equal(timeline.getPlaybackMs(f.read()), 10_500);
  f.advance(250);
  assert.equal(timeline.getPlaybackMs(f.read()), 11_000);
});

test('buffering freezes, repeated metadata cannot freshen a stopped sample, recovery resumes', (t) => {
  const f = clockFixture(t);
  const timeline = createLyricTimeline();
  timeline.getPlaybackMs(f.read());
  f.source.isAdvancing = false;
  const stalled = f.read();
  f.advance(30_000);
  assert.equal(timeline.getPlaybackMs(stalled), 10_000);
  f.source.duration = 220;
  assert.equal(timeline.getPlaybackMs(f.read()), 10_000);
  f.source.isAdvancing = true;
  assert.equal(timeline.getPlaybackMs(f.read()), 10_000);
  f.advance(200);
  assert.equal(timeline.getPlaybackMs(f.read()), 10_200);
});

test('same-track replay with a new native sequence resets the timeline', (t) => {
  const f = clockFixture(t);
  const timeline = createLyricTimeline();
  timeline.getPlaybackMs(f.read());
  const revision = timeline.revision;
  f.source.trackSeq = 2;
  f.source.currentTime = 0;
  assert.equal(timeline.getPlaybackMs(f.read()), 0);
  assert.ok(timeline.revision > revision);
});

test('snapshot ordering rejects old seeks, forward jumps and obsolete pause states', () => {
  const current = {
    trackId: 'a',
    currentTime: 10,
    updatedAt: 2000,
    seekTimestamp: 1500,
    isPlaying: true,
  };
  for (const old of [
    { ...current, currentTime: 90, seekTimestamp: 1000, updatedAt: 2100 },
    { ...current, currentTime: 90, updatedAt: 1990 },
    { ...current, isPlaying: false, updatedAt: 1990 },
  ])
    assert.equal(playback.shouldAcceptPlaybackSnapshot(old, current), false);
  assert.equal(
    playback.shouldAcceptPlaybackSnapshot(
      { ...current, currentTime: 5, seekTimestamp: 2001 },
      current,
    ),
    true,
  );
});

test('duration-only bridge patches do not extend sample freshness or replace seek identity', (t) => {
  const f = clockFixture(t);
  const sample = f.read();
  const current = { ...f.source, clock: sample.clock };
  f.advance(4000);
  const patched = playback.patchPlaybackSnapshot(current, { duration: 240 });
  assert.equal(patched.clock.sampledAt, sample.clock.sampledAt);
  assert.equal(patched.clock.positionMs, sample.clock.positionMs);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
};
const engineFixture = () => {
  const handlers = {},
    requests = [],
    times = [];
  const api = new Proxy(
    {
      seek: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    {
      get(target, name) {
        if (String(name).startsWith('on'))
          return (fn) => {
            handlers[name] = fn;
            return () => {};
          };
        return target[name];
      },
    },
  );
  const { PlayerEngine } = compile(
    '../src/renderer/utils/player.ts',
    {
      './logger': logger,
      '../../shared/loudness': loudness,
      '../../shared/playback': playback,
    },
    { electron: { player: api } },
  );
  const engine = new PlayerEngine();
  engine.setEvents({ timeUpdate: (time) => times.push(time) });
  return { engine, requests, handlers, times };
};

test('successful seek without a seeked event cannot permanently suppress progress', async () => {
  const f = engineFixture();
  const seek = f.engine.seek(20);
  f.handlers.onTimeUpdate({ time: 2, trackSeq: 1 });
  assert.deepEqual(f.times, []);
  f.requests[0].resolve();
  await seek;
  f.handlers.onTimeUpdate({ time: 20.25, trackSeq: 1 });
  assert.deepEqual(f.times, [20.25]);
});

test('older seek completion/rejection and old restart cannot unlock a newer seek', async () => {
  for (const reject of [false, true]) {
    const f = engineFixture();
    const first = f.engine.seek(20);
    const second = f.engine.seek(80);
    if (reject) f.requests[0].reject(new Error('superseded'));
    else f.requests[0].resolve();
    await first;
    f.handlers.onSeeked(20);
    f.handlers.onPlaybackRestart({ time: 20, reason: 'seek' });
    f.handlers.onTimeUpdate({ time: 21, trackSeq: 1 });
    assert.deepEqual(f.times, []);
    f.requests[1].resolve();
    await second;
    f.handlers.onTimeUpdate({ time: 80.25, trackSeq: 1 });
    assert.deepEqual(f.times, [80.25]);
  }
});

test('plugin snapshot transport preserves source clock and seek identity', () => {
  const thumbnailStates = [];
  const api = compile('../src/main/nowPlaying.ts', {
    '../shared/opencc': opencc,
    './ipc/registry': {},
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../shared/nowPlaying': nowPlaying,
    '../shared/playback': playback,
    './window': { getMainWindow: () => null },
    './taskbarThumbnail': {
      isCoverPreviewEnabled: () => false,
    },
    './thumbar': { updateThumbarPlayback: (state) => thumbnailStates.push(state) },
    './taskbarProgress': {},
    './storage/settings': {},
  });
  const source = {
    trackId: 'a',
    trackSeq: 7,
    currentTime: 20,
    duration: 200,
    isPlaying: true,
    isAdvancing: false,
    seekTimestamp: 12345,
    updatedAt: 12350,
  };
  const result = api.syncNowPlayingSnapshot({
    playback: {
      ...source,
      clock: playback.buildPlaybackClockSnapshot(source),
    },
  });
  assert.equal(result.playback.seekTimestamp, 12345);
  assert.equal(result.playback.clock.generation, 12345);
  assert.equal(result.playback.clock.sampledAt, 12350);
  assert.equal(result.playback.clock.trackSeq, 7);
  assert.equal(result.playback.clock.positionMs, 20_000);
  assert.equal(result.playback.clock.isAdvancing, false);
  assert.equal(thumbnailStates[0], result.playback);
});

test('seeking after manual lyric scrolling immediately restores automatic following', async (t) => {
  const player = vue.reactive({ currentTrackId: 'a', seekTimestamp: 0 });
  const activeIndex = vue.ref(2);
  const frames = new Map();
  let nextFrame = 0;
  const oldRaf = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => {
    frames.set(++nextFrame, fn);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
  });
  const calls = [];
  const container = {
    scrollTop: 0,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0, height: 400 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 200, bottom: 240, height: 40 }) }),
    querySelectorAll: () => [],
    scrollTo: (request) => calls.push(request),
  };
  const { useLyricScroll } = compile(
    '../src/renderer/views/lyric/composables/useLyricScroll.ts',
    {
      vue,
      '@/stores/lyric': { useLyricStore: () => ({ lines: [{ time: 0 }], currentIndex: 2 }) },
      '@/stores/player': { usePlayerStore: () => player },
      '@/plugins/lyricEffects': { requestPluginLyricAutoScroll: () => false },
    },
    { setTimeout, clearTimeout },
  );
  const scope = vue.effectScope();
  const scroll = scope.run(() => useLyricScroll(() => container, vue.ref(false), activeIndex));
  t.after(() => {
    scroll.dispose();
    scope.stop();
  });
  scroll.handleWheel();
  assert.equal(scroll.isUserScrolling.value, true);
  player.seekTimestamp = 10;
  activeIndex.value = 10;
  await vue.nextTick();
  await vue.nextTick();
  for (const [id, fn] of [...frames]) {
    frames.delete(id);
    fn();
  }
  assert.equal(scroll.isUserScrolling.value, false);
  assert.equal(scroll.scrollHighlightIndex.value, -1);
  assert.ok(calls.length > 0);
});

test('window bootstrap replays seeks/pauses received during the initial snapshot query', async () => {
  const { subscribeWithSnapshot } = await import('../src/renderer/utils/snapshotSubscription.ts');
  const query = deferred();
  let receive;
  let snapshot;
  const sub = subscribeWithSnapshot({
    read: () => query.promise,
    subscribe: (fn) => {
      receive = fn;
      return () => {};
    },
    applySnapshot: (value) => {
      snapshot = value;
    },
    applyMessage: (patch) => {
      snapshot = { ...snapshot, ...patch };
    },
  });
  receive({ currentTime: 90 });
  receive({ isPlaying: false });
  query.resolve({ currentTime: 10, isPlaying: true, lyrics: ['line'] });
  await sub.ready;
  assert.deepEqual(snapshot, { currentTime: 90, isPlaying: false, lyrics: ['line'] });
  sub.dispose();
});

test('closing a lyric window during bootstrap cannot install a late snapshot', async () => {
  const { subscribeWithSnapshot } = await import('../src/renderer/utils/snapshotSubscription.ts');
  const query = deferred();
  const applied = [];
  let unsubscribed = false;
  const sub = subscribeWithSnapshot({
    read: () => query.promise,
    subscribe: () => () => {
      unsubscribed = true;
    },
    applySnapshot: (value) => applied.push(value),
    applyMessage: (value) => applied.push(value),
  });
  sub.dispose();
  query.resolve({ currentTime: 90 });
  await sub.ready;
  assert.equal(unsubscribed, true);
  assert.deepEqual(applied, []);
});

test('transport events carry the authoritative position between throttled ticks', () => {
  const f = engineFixture();
  const positions = [];
  f.engine.setEvents({ play: (p) => positions.push(p.time), pause: (p) => positions.push(p.time) });
  f.handlers.onStateChange({ playing: false, paused: true, timePos: 20.125, trackSeq: 1 });
  f.handlers.onStateChange({ playing: true, paused: false, timePos: 20.125, trackSeq: 1 });
  assert.deepEqual(positions, [20.125, 20.125]);
});

const publisherFixture = () => {
  const messages = [],
    desktop = [],
    mini = [];
  const api = compile('../src/main/player/index.ts', {
    '../logger': logger,
    '../window': {
      getMainWindow: () => ({ webContents: { send: (...args) => messages.push(args) } }),
    },
    './controller': {},
    '../desktopLyric': { patchDesktopLyricPlaybackFromPlayer: (patch) => desktop.push(patch) },
    '../miniPlayer': { patchMiniPlayerPlaybackFromPlayer: (patch) => mini.push(patch) },
    '../taskbarProgress': {},
    '../outputs/outputHost': {},
  });
  return { ...api, messages, desktop, mini };
};

// Execute the real store callbacks without starting audio devices or network services.
const storeProgressFixture = () => {
  const source = readFileSync(new URL('../src/renderer/stores/player.ts', import.meta.url), 'utf8');
  const start = source.indexOf('      const syncTransportPosition =');
  const end = source.indexOf('        durationChange:', start);
  assert.ok(start >= 0 && end > start);
  const state = { currentTime: 0, nativeTrackSeq: 1, currentTimeUpdatedAt: 0 };
  const mocks = {
    state,
    matchesPendingSeekTarget: playback.matchesPendingSeekTarget,
    isCurrentNativePlaybackContext: () => true,
    getPlaybackHasFailed: () => false,
    listeningTimeManager: { tick() {} },
    playbackManager: { prepareGaplessNext() {} },
    historyManager: { commitListeningHistory() {} },
    engine: { updateMediaPlaybackState() {} },
    buildMediaState: () => ({}),
    emitPlayerEvent() {},
  };
  const code = transformSync(
    `
    let lastEventTimeUpdate = 0, lastHistoryCheck = 0, lastMediaSessionSync = 0;
    const EVENT_TIMEUPDATE_MS = 1000, HISTORY_CHECK_MS = 5000, MEDIA_SESSION_SYNC_MS = 2000;
    ${source.slice(start, end)} };
    return { events, syncTransportPosition };
  `,
    { loader: 'ts' },
  ).code;
  return { state, ...new Function(...Object.keys(mocks), code)(...Object.values(mocks)) };
};

test('delayed renderer round trips retain the same sample age as desktop and Mini bridges', (t) => {
  let elapsed = 0;
  const epoch = 1_790_000_000_000;
  t.mock.method(Date, 'now', () => epoch + elapsed);
  // Each window has a different performance origin; none is a Unix timestamp.
  let origin = 12_345;
  t.mock.method(performance, 'now', () => origin + elapsed);
  const pub = publisherFixture();
  const engine = engineFixture();
  const store = storeProgressFixture();
  engine.engine.setEvents(store.events);
  for (const delay of [50, 100, 200]) {
    const sampledAt = Date.now();
    const position = 10 + elapsed / 1000;
    pub.publishPlayerEvent('time-update', { time: position, trackSeq: 1 });
    const event = pub.messages.at(-1)[1];
    assert.equal(event.sampledAt, sampledAt);
    const current = { trackId: 'a', trackSeq: 1, isPlaying: true, currentTime: position };
    const desktopSample = playback.patchPlaybackSnapshot(current, pub.desktop.at(-1));
    const miniSample = playback.patchPlaybackSnapshot(current, pub.mini.at(-1));
    elapsed += delay;
    engine.handlers.onTimeUpdate(event);
    assert.equal(store.state.currentTimeUpdatedAt, sampledAt);
    const rendererSample = {
      ...current,
      currentTime: store.state.currentTime,
      updatedAt: store.state.currentTimeUpdatedAt,
    };
    const expected = position * 1000 + delay;
    for (const sample of [desktopSample, miniSample, rendererSample]) {
      origin += 30_000;
      assert.equal(createLyricTimeline().getPlaybackMs(sample), expected);
    }
    // A delayed resend must not appear newer than a subsequent direct native tick.
    const newer = playback.patchPlaybackSnapshot(current, { currentTime: position + delay / 1000 });
    assert.equal(playback.shouldAcceptPlaybackSnapshot(rendererSample, newer), false);
    elapsed += 300;
  }
});

test('pause and resume positions keep the shared publication timestamp through IPC', (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => 100);
  const pub = publisherFixture();
  const engine = engineFixture();
  const store = storeProgressFixture();
  engine.engine.setEvents({
    play: store.syncTransportPosition,
    pause: store.syncTransportPosition,
  });
  for (const playing of [false, true]) {
    const sampledAt = now;
    pub.publishPlayerEvent('state-change', { timePos: 20, playing, paused: !playing, speed: 2 });
    now += 100;
    engine.handlers.onStateChange(pub.messages.at(-1)[1]);
    assert.equal(store.state.currentTimeUpdatedAt, sampledAt);
    for (const patch of [pub.desktop.at(-1), pub.mini.at(-1)]) {
      const sample = playback.patchPlaybackSnapshot({ trackId: 'a' }, patch);
      assert.equal(sample.clock.sampledAt, sampledAt);
      assert.equal(createLyricTimeline().getPlaybackMs(sample), playing ? 20_200 : 20_000);
    }
  }
});

test('small clock corrections are applied even below the former 300ms tolerance', (t) => {
  const epoch = 1_790_000_000_000;
  let elapsed = 0;
  t.mock.method(Date, 'now', () => epoch + elapsed);
  t.mock.method(performance, 'now', () => 500 + elapsed);
  const timeline = createLyricTimeline();
  const sample = { currentTime: 10, isPlaying: true, updatedAt: epoch };
  assert.equal(timeline.getPlaybackMs(sample), 10_000);
  elapsed = 200;
  sample.currentTime = 10.1;
  sample.updatedAt = Date.now();
  assert.equal(timeline.getPlaybackMs(sample), 10_100);
  elapsed += 80;
  assert.equal(timeline.getPlaybackMs(sample), 10_180);
  timeline.sync({ ...sample });
  assert.equal(timeline.getPlaybackMs(sample), 10_180, 'resends do not compensate twice');
});
