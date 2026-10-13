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
  // 提交后的 seek 有确认兜底定时器，沙箱里必须提供，否则 clearTimeout 直接抛错。
  // 定时器不自动触发：用例靠显式触发来验证超时兜底。
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutStub = (fn) => {
    const id = nextTimerId++;
    timers.set(id, fn);
    return id;
  };
  const clearTimeoutStub = (id) => {
    timers.delete(id);
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
        setTimeout: setTimeoutStub,
        clearTimeout: clearTimeoutStub,
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
    /** 触发所有挂起的确认超时定时器，模拟「上游迟迟不确认」。 */
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    pendingTimers: () => timers.size,
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

test('a committed seek keeps showing the target until playback confirms it', () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleValueUpdate([65]);
  h.seek.handleCommit([65]);

  // 上游经 IPC 往返期间 getCurrentTime() 仍是旧值。直接 reset 会让进度条
  // 闪回旧位置再跳到目标，这是独立窗口里最刺眼的抖动。
  h.playback.value = { ...h.playback.value, currentTime: 12 };
  assert.equal(h.seek.progressValue.value[0], 65);

  // 向前 seek：播放头从旧位置一路爬向目标，爬过目标才交回实际进度。
  // 爬到一半（64）仍在显示目标值，不能提前交回造成一次回跳。
  h.playback.value = { ...h.playback.value, currentTime: 64 };
  assert.equal(h.seek.progressValue.value[0], 65);
  h.playback.value = { ...h.playback.value, currentTime: 65.2 };
  assert.equal(h.seek.progressValue.value[0], 65.2);
  h.scope.stop();
});

test('a backward seek hands control back once the playhead is at or below target', () => {
  const h = harness();
  h.playback.value = { ...h.playback.value, currentTime: 90 };
  h.seek.handleStart();
  h.seek.handleCommit([20]);

  // 上游尚未更新，播放头仍在高位：必须继续显示目标，不能被 current 拉回去。
  assert.equal(h.seek.progressValue.value[0], 20);
  h.playback.value = { ...h.playback.value, currentTime: 30 };
  assert.equal(h.seek.progressValue.value[0], 20);
  h.playback.value = { ...h.playback.value, currentTime: 20 };
  assert.equal(h.seek.progressValue.value[0], 20);
  h.playback.value = { ...h.playback.value, currentTime: 19.8 };
  assert.equal(h.seek.progressValue.value[0], 19.8);
  h.scope.stop();
});

test('a seek that is never confirmed falls back to real playback', () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleValueUpdate([80]);
  h.seek.handleCommit([80]);

  // 上游可能一直不报告新位置（暂停、断流、IPC 丢失）。在超时之前必须一直显示
  // 目标值，否则又会闪回旧位置。
  h.playback.value = { ...h.playback.value, currentTime: 10 };
  assert.equal(h.seek.progressValue.value[0], 80);
  h.flushTimers();
  assert.equal(h.seek.progressValue.value[0], 10);
  // 超时兜底已生效，不该再留定时器。
  assert.equal(h.pendingTimers(), 0);
  h.scope.stop();
});

test('confirming a seek clears its timeout instead of leaving it armed', () => {
  const h = harness();
  h.seek.handleStart();
  h.seek.handleCommit([30]);
  assert.equal(h.pendingTimers(), 1);
  h.playback.value = { ...h.playback.value, currentTime: 30.5 };
  assert.equal(h.seek.progressValue.value[0], 30.5);
  assert.equal(h.pendingTimers(), 0);
  h.scope.stop();
});
