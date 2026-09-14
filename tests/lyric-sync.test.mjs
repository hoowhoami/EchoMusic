import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as playback from '../src/shared/playback.ts';
import * as loudness from '../src/shared/loudness.ts';
import * as nowPlaying from '../src/shared/now-playing.ts';
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
  const api = compile('../src/main/nowPlaying.ts', {
    './ipc/registry': {},
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../shared/now-playing': nowPlaying,
    '../shared/playback': playback,
    './window': { getMainWindow: () => null },
    './taskbarThumbnail': { isCoverPreviewEnabled: () => false },
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
