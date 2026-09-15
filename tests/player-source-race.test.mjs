import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as loudness from '../src/shared/loudness.ts';

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
function compile(file, mocks, window) {
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
function controllerFixture(proxy = async () => []) {
  const { PlayerController } = compile('../src/main/player/controller.ts', {
    electron: { app: {} },
    '../logger': logger,
    '../networkSettings': {},
    '../storage/persistedStores': {},
    '../networkPolicy': { resolveNativeProxyUrls: proxy },
    '../../shared/audioEffectSupport': {},
  });
  const controller = new PlayerController();
  const loads = [],
    calls = [];
  const addon = {
    beginSourceChange() {
      calls.push('invalidate');
    },
    setHttpProxies() {},
    loadFile(url, seq) {
      const pending = defer();
      loads.push({ url, seq, ...pending });
      return pending.promise;
    },
    loadMkvTrack(url, track, seq) {
      return this.loadFile(url, seq);
    },
    getState() {
      return { duration: 123 };
    },
    play() {
      calls.push('play');
    },
    playWithFade() {
      calls.push('fade');
      return Promise.resolve();
    },
    cancelFade() {},
    stop() {
      calls.push('stop');
    },
  };
  controller.addon = addon;
  return { controller, addon, loads, calls };
}

test('a slow native load does not block newer loads and only the latest completion binds', async () => {
  const { controller, loads, calls } = controllerFixture();
  const oldRequest = controller.beginSourceChange();
  const oldLoad = controller.loadFile('old', oldRequest);
  await flush();
  const request = controller.beginSourceChange();
  const newLoad = controller.loadMkvTrack('new', 2, request);
  await flush();
  assert.deepEqual(
    loads.map((x) => x.url),
    ['old', 'new'],
  );
  loads[1].resolve();
  const result = await newLoad;
  assert.equal(result.seq, loads[1].seq);
  loads[0].resolve();
  assert.equal(await oldLoad, null);
  await controller.play(oldRequest);
  await controller.play(request);
  assert.deepEqual(calls, ['invalidate', 'invalidate', 'play']);
  const events = [];
  controller.on('time-update', (x) => events.push(x.time));
  controller.handleAddonEvent({ event: 'time-update', time: 90, trackSeq: loads[0].seq });
  controller.handleAddonEvent({ event: 'time-update', time: 1, trackSeq: result.seq });
  assert.deepEqual(events, [1]);
});

test('12 rapid requests coalesce even when proxy resolution completes out of order', async () => {
  const proxies = new Map();
  const { controller, loads } = controllerFixture((url) => {
    const pending = defer();
    proxies.set(url, pending);
    return pending.promise;
  });
  const pending = [];
  for (let i = 0; i < 12; i++)
    pending.push(controller.loadFile(String(i), controller.beginSourceChange()));
  proxies.get('11').resolve([]);
  await flush();
  loads[0].resolve();
  assert.ok(await pending[11]);
  for (let i = 10; i >= 0; i--) proxies.get(String(i)).resolve([]);
  assert.deepEqual((await Promise.all(pending)).slice(0, 11), Array(11).fill(null));
  assert.deepEqual(
    loads.map((x) => x.url),
    ['11'],
  );
});

test('a queued old fade is dropped and native start failures reach the caller', async () => {
  const { controller, addon, calls } = controllerFixture();
  const blocker = defer();
  controller.commandQueue = blocker.promise;
  const oldFade = controller.playWithFade(50, 1000);
  controller.beginSourceChange();
  blocker.resolve();
  await oldFade;
  assert.deepEqual(calls, ['invalidate']);
  controller.pendingLoadSeq = null;
  addon.playWithFade = async () => {
    throw new Error('no audio source loaded');
  };
  await assert.rejects(controller.playWithFade(50, 1000), /no audio source loaded/);
});

test('stop supersedes an in-flight load instead of waiting behind it', async () => {
  const { controller, loads, calls } = controllerFixture();
  const pending = controller.loadFile('old', controller.beginSourceChange());
  await flush();
  await controller.stop();
  assert.equal(calls.at(-1), 'stop');
  loads[0].resolve();
  assert.equal(await pending, null);
});

test('quality switches retain the live timeline even if their renderer acknowledgement is superseded', async () => {
  const { controller, addon, loads } = controllerFixture();
  const loading = controller.loadFile('ordinary');
  await flush();
  loads[0].resolve();
  const { seq } = await loading;
  const switches = [];
  addon.switchSource = (url, _trackId, trackSeq) => {
    const pending = defer();
    switches.push({ url, trackSeq, ...pending });
    return pending.promise;
  };
  const times = [];
  controller.on('time-update', (event) => times.push(event));
  const vpt = controller.switchSource('vpt');
  await flush();
  const ordinary = controller.switchSource('ordinary');
  const obsolete = assert.rejects(vpt, /superseded/);
  await flush();
  switches[0].resolve([20, 120]);
  await obsolete;
  controller.handleAddonEvent({ event: 'time-update', time: 21, trackSeq: switches[0].trackSeq });
  switches[1].resolve([22, 120]);
  assert.equal((await ordinary)[2], seq);
  controller.handleAddonEvent({ event: 'time-update', time: 23, trackSeq: switches[1].trackSeq });
  assert.deepEqual(
    times.map((event) => [event.time, event.trackSeq]),
    [
      [21, seq],
      [23, seq],
    ],
  );
});

test('a delayed proxy lookup cannot launch an older quality switch after the latest choice', async () => {
  const proxies = new Map();
  const { controller, addon } = controllerFixture((url) => {
    const pending = defer();
    proxies.set(url, pending);
    return pending.promise;
  });
  const switched = [];
  addon.switchSource = async (url) => {
    switched.push(url);
    return [20, 120];
  };
  const old = controller.switchSource('vpt');
  const obsolete = assert.rejects(old, /superseded/);
  const current = controller.switchSource('ordinary');
  proxies.get('ordinary').resolve([]);
  await current;
  proxies.get('vpt').resolve([]);
  await obsolete;
  assert.deepEqual(switched, ['ordinary']);
});

test('a quality acknowledgement cannot roll back an automatic next-track boundary', async () => {
  const { controller, addon } = controllerFixture();
  controller.activeTrackSeq = 4;
  const pending = defer();
  addon.switchSource = () => pending.promise;
  const switched = controller.switchSource('vpt');
  const obsolete = assert.rejects(switched, /superseded/);
  await flush();
  controller.handleAddonEvent({ event: 'time-update', time: 1, trackSeq: 5 });
  pending.resolve([20, 120]);
  await obsolete;
  assert.equal(controller.activeTrackSeq, 5);
});

function engineFixture() {
  const handlers = {},
    loads = [],
    calls = [];
  let request = 0;
  const api = new Proxy(
    {
      beginSourceChange: async () => ++request,
      load(url, requestId) {
        const pending = defer();
        loads.push({ url, requestId, ...pending });
        return pending.promise;
      },
      switchSource(url) {
        const pending = defer();
        loads.push({ url, ...pending });
        return pending.promise;
      },
      play: async (requestId) => calls.push(['play', requestId]),
      playWithFade: async (_volume, _duration, requestId) => calls.push(['fade', requestId]),
      stop: async () => {},
      setNormalizationGain: async (gain) => calls.push(['normalization', gain]),
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
      '../../shared/playback': { DEFAULT_PLAYER_VOLUME: 50 },
    },
    { electron: { player: api } },
  );
  const engine = new PlayerEngine();
  return { engine, handlers, loads, calls };
}

test('prepared loudness adoption updates the cache without overwriting native overlap gains', () => {
  const { engine, calls } = engineFixture();
  const a = { lufs: -10, peak: null, gain: 0 };
  const b = { lufs: -8, peak: null, gain: 0 };
  engine.setVolumeNormalization(true);
  engine.applyTrackLoudness(a);
  assert.equal(calls.filter(([name]) => name === 'normalization').length, 1);
  engine.adoptPreparedTrackLoudness(b);
  assert.ok(Math.abs(engine.normalizationGainDb - -6) < 1e-6);
  assert.equal(calls.filter(([name]) => name === 'normalization').length, 1);
  engine.setReferenceLufs(-16);
  assert.deepEqual(calls.at(-1), ['normalization', -8], 'reference changes use B metadata');
  engine.adoptPreparedTrackLoudness(null);
  assert.equal(engine.normalizationGainDb, 0);
  assert.equal(calls.filter(([name]) => name === 'normalization').length, 2);
  engine.applyTrackLoudness(a);
  assert.deepEqual(calls.at(-1), ['normalization', -6], 'ordinary loads still issue a gain update');
});

test('adopting while normalization is disabled retains metadata for a later enable', () => {
  const { engine, calls } = engineFixture();
  engine.adoptPreparedTrackLoudness({ lufs: -8, peak: null, gain: 0 });
  assert.equal(engine.normalizationGainDb, 0);
  assert.equal(calls.filter(([name]) => name === 'normalization').length, 0);
  engine.setVolumeNormalization(true);
  assert.deepEqual(calls.at(-1), ['normalization', -6]);
});

test('old file-loaded during URL resolution cannot bind; load acknowledgement restores progress without an event', async () => {
  const { engine, handlers, loads } = engineFixture();
  const files = [],
    times = [];
  engine.setEvents({ fileLoaded: (x) => files.push(x.seq), timeUpdate: (t) => times.push(t) });
  engine.beginSourceChange();
  handlers.onFileLoaded({ path: 'old', seq: 1 });
  handlers.onTimeUpdate({ time: 90, trackSeq: 1 });
  assert.deepEqual(files, []);
  assert.deepEqual(times, []);
  const pending = engine.setSource('new');
  await flush();
  handlers.onFileLoaded({ path: 'new', seq: 2 });
  assert.deepEqual(files, []);
  loads[0].resolve({ seq: 2, duration: 100 });
  await pending;
  assert.deepEqual(files, [2]);
  handlers.onTimeUpdate({ time: 0.25, trackSeq: 2 });
  assert.deepEqual(times, [0.25]);
  assert.equal(engine.duration, 100);
});

test('an obsolete load acknowledgement cannot clear the latest load guard', async () => {
  const { engine, handlers, loads, calls } = engineFixture();
  const files = [],
    times = [];
  engine.setEvents({ fileLoaded: (x) => files.push(x.seq), timeUpdate: (t) => times.push(t) });
  const old = engine.setSource('old');
  await flush();
  const current = engine.setSource('new');
  await flush();
  loads[0].resolve({ seq: 1, duration: 50 });
  await old;
  handlers.onTimeUpdate({ time: 91, trackSeq: 1 });
  assert.deepEqual(files, []);
  assert.deepEqual(times, []);
  loads[1].resolve({ seq: 2, duration: 123 });
  await current;
  await engine.play({ fadeIn: true });
  assert.deepEqual(files, [2]);
  assert.deepEqual(calls, [['fade', loads[1].requestId]]);
});

test('late quality switch acknowledgement cannot replace the latest engine source', async () => {
  const { engine, loads } = engineFixture();
  const old = engine.switchSource('vpt');
  const current = engine.switchSource('ordinary');
  loads[1].resolve([22, 120, 4]);
  assert.equal(await current, 4);
  loads[0].resolve([20, 120, 4]);
  assert.equal(await old, undefined);
  assert.equal(engine.source, 'ordinary');
});
