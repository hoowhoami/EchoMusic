import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

function harness() {
  const listeners = new Map();
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  function load(path, mocks) {
    const module = { exports: {} };
    runInNewContext(
      transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        loader: 'ts',
        format: 'cjs',
      }).code,
      {
        module,
        window,
        queueMicrotask,
        require: (name) => {
          if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
          return mocks[name];
        },
      },
    );
    return module.exports;
  }
  const deferred = load('../src/renderer/composables/useDeferredSeek.ts', { vue });
  const { useTaskbarSeek } = load('../src/renderer/taskbarPlayer/useTaskbarSeek.ts', {
    vue,
    '../composables/useDeferredSeek': deferred,
  });
  const playback = vue.ref({ trackId: 'first', currentTime: 10, duration: 100 });
  const sent = [];
  const scope = vue.effectScope();
  const seek = scope.run(() =>
    useTaskbarSeek(
      () => playback.value,
      (time) => sent.push(time),
    ),
  );
  return {
    seek,
    playback,
    sent,
    scope,
    listeners,
    emit: (type) => {
      for (const fn of listeners.get(type) || []) fn();
    },
  };
}

test('preview is stable across playback refresh; only release commits one seek', () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleValueUpdate([65]);
  h.playback.value = { ...h.playback.value, currentTime: 11 };
  assert.equal(h.seek.progressValue.value[0], 65);
  assert.deepEqual(h.sent, []);
  h.seek.handleCommit([65]);
  h.seek.handleCommit([65]);
  assert.deepEqual(h.sent, [65]);
  assert.equal(h.seek.isDragging.value, false);
  h.scope.stop();
});

test('song changes cancel the gesture and reject delayed commits', () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleValueUpdate([80]);
  h.playback.value = { trackId: 'second', currentTime: 0, duration: 200 };
  h.seek.handleCommit([80]);
  assert.deepEqual(h.sent, []);
  assert.equal(h.seek.progressValue.value[0], 0);
  h.seek.handleStart();
  h.seek.handleCommit([40]);
  assert.deepEqual(h.sent, [40]);
  h.scope.stop();
});

test('keyboard seeking reuses the same commit path', () => {
  const h = harness();
  h.seek.handleKeydown({ key: 'Tab' });
  assert.equal(h.seek.isDragging.value, false);
  for (const key of ['ArrowRight', 'Home', 'End']) {
    h.seek.handleKeydown({ key });
    h.seek.handleCommit([30]);
  }
  assert.deepEqual(h.sent, [30, 30, 30]);
  h.scope.stop();
});

test('cancel, blur, and pointer cancel never commit a stale preview', async () => {
  for (const type of ['blur', 'pointercancel']) {
    const h = harness();
    h.seek.handleStart();
    h.seek.handleValueUpdate([75]);
    h.emit(type);
    await Promise.resolve();
    h.seek.handleCommit([75]);
    assert.deepEqual(h.sent, []);
    assert.equal(h.seek.isDragging.value, false);
    h.scope.stop();
  }
});

test('unchanged release resets preview and removes global listeners', async () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleEnd();
  await Promise.resolve();
  assert.equal(h.seek.isDragging.value, false);
  assert.deepEqual(h.sent, []);
  for (const list of h.listeners.values()) assert.equal(list.size, 0);
  h.scope.stop();
});

test('missing duration disables seek; finite targets clamp to current duration', () => {
  const h = harness();
  for (const value of [NaN, Infinity, -3, 0]) {
    h.playback.value.duration = value;
    h.seek.handleStart();
    h.seek.handleCommit([50]);
    assert.equal(h.seek.duration.value, 0);
  }
  assert.deepEqual(h.sent, []);
  h.playback.value.duration = 60;
  for (const value of [NaN, Infinity, -20, 500]) {
    h.seek.handleStart();
    h.seek.handleCommit([value]);
  }
  assert.deepEqual(h.sent, [0, 60]);
  h.seek.handleStart();
  h.playback.value = null;
  h.seek.handleCommit([30]);
  assert.deepEqual(h.sent, [0, 60]);
  h.scope.stop();
});

test('unmount disposes the reused composable global listeners', () => {
  const h = harness();
  h.seek.handleStart();
  assert.equal(h.listeners.get('pointerup').size, 1);
  h.scope.stop();
  for (const list of h.listeners.values()) assert.equal(list.size, 0);
});

test('keyboard at an unchanged boundary releases preview on keyup', async () => {
  const h = harness();
  h.playback.value.currentTime = 0;
  h.seek.handleKeydown({ key: 'Home' });
  h.seek.handleEnd();
  await Promise.resolve();
  h.playback.value.currentTime = 1;
  assert.equal(h.seek.progressValue.value[0], 1);
  assert.deepEqual(h.sent, []);
  h.scope.stop();
});
