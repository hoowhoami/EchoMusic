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
    '../../shared/audio-effect-support': {},
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
      play: async (requestId) => calls.push(['play', requestId]),
      playWithFade: async (_volume, _duration, requestId) => calls.push(['fade', requestId]),
      stop: async () => {},
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
      '../../shared/loudness': { DEFAULT_REFERENCE_LUFS: -14 },
      '../../shared/playback': { DEFAULT_PLAYER_VOLUME: 50 },
    },
    { electron: { player: api } },
  );
  const engine = new PlayerEngine();
  return { engine, handlers, loads, calls };
}

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
