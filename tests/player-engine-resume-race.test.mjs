import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as loudness from '../src/shared/loudness.ts';
import * as playback from '../src/shared/playback.ts';

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
function engineFixture() {
  const bridge = {
    beginSourceChange: () => Promise.resolve(1001),
    onTimeUpdate: () => () => {},
    onDurationChange: () => () => {},
    onStateChange: () => () => {},
    onPlaybackEnd: () => () => {},
    onError: () => () => {},
  };
  const calls = [];
  const loads = [];
  const plays = [];
  bridge.load = (url, seq) => {
    const pending = defer();
    loads.push({ url, seq, ...pending });
    return pending.promise;
  };
  bridge.play = (seq) => {
    calls.push('play');
    plays.push(seq);
  };
  const { PlayerEngine } = compile(
    '../src/renderer/utils/player.ts',
    {
      './logger': logger,
      '../../shared/loudness': loudness,
      '../../shared/playback': playback,
    },
    { electron: { player: bridge, mediaControls: {} } },
  );
  const engine = new PlayerEngine();
  return { engine, bridge, calls, loads, plays };
}

test('play during an in-flight source load is deferred and delivered after the load settles', async () => {
  const { engine, calls, loads, plays } = engineFixture();
  const loading = engine.setSource('http://cdn/a.mp3');
  await flush();
  assert.equal(engine.source, 'http://cdn/a.mp3');
  assert.equal(loads[0].url, 'http://cdn/a.mp3');

  // 恢复播放撞上仍在下发的换源加载：必须先等加载落地，禁止静默成功
  const playPromise = engine.play();
  await flush();
  assert.equal(calls.includes('play'), false);
  assert.equal(calls.includes('fade'), false);

  loads[0].resolve({ duration: 100, seq: 500 });
  await loading;
  await playPromise;

  assert.equal(calls.includes('play'), true);
  assert.deepEqual(plays, [1001]);
});

test('play rejects instead of silently succeeding when the pending load failed', async () => {
  const { engine, calls, loads } = engineFixture();
  const loading = engine.setSource('http://cdn/a.mp3');
  await flush();
  loads[0].reject(new Error('network down'));
  await assert.rejects(loading, /network down/);

  await assert.rejects(engine.play(), /Play deferred/);
  assert.equal(calls.includes('play'), false);
});

test('play targeted at a stale source revision is cancelled, not played', async () => {
  const { engine, calls, loads } = engineFixture();
  const loading = engine.setSource('http://cdn/a.mp3');
  await flush();
  const playPromise = engine.play();
  await flush();
  const superseding = engine.setSource('http://cdn/b.mp3');
  await flush();
  assert.equal(calls.includes('play'), false);

  loads[0].resolve({ duration: 100, seq: 500 });
  await loading;
  loads[1].resolve({ duration: 90, seq: 600 });
  await superseding;
  await playPromise;
  assert.equal(calls.includes('play'), false);
});
