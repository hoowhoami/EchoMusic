import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

/**
 * 拖动提交后的进度条行为。
 *
 * 独立窗口（任务栏歌词 / mini）的 seek 要经 IPC 转发到主窗口执行，新位置再同步
 * 回来。提交后若立刻交回 getCurrentTime()，进度条会先闪回旧位置再跳到目标。
 */
function setup(initialTime = 10) {
  let currentTime = initialTime;
  const seeks = [];
  const vue = {
    ref: (value) => ({ value }),
    shallowRef: (value) => ({ value }),
    computed: (getter) => ({
      get value() {
        return getter();
      },
    }),
    onScopeDispose: () => {},
  };
  const module = { exports: {} };
  runInNewContext(
    transformSync(
      readFileSync(
        new URL('../src/renderer/composables/useDeferredSeek.ts', import.meta.url),
        'utf8',
      ),
      { loader: 'ts', format: 'cjs' },
    ).code,
    {
      module,
      exports: module.exports,
      require: (id) => {
        assert.equal(id, 'vue');
        return vue;
      },
      window: { addEventListener() {}, removeEventListener() {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
      queueMicrotask,
    },
  );
  const api = module.exports.useDeferredSeek({
    getCurrentTime: () => currentTime,
    seek: (time) => seeks.push(time),
  });
  return {
    api,
    seeks,
    setCurrentTime: (value) => {
      currentTime = value;
    },
    progress: () => api.progressValue.value[0],
  };
}

test('the committed target stays on screen until playback reaches it', () => {
  const f = setup(10);
  f.api.handleStart();
  f.api.handleValueUpdate([120]);
  assert.equal(f.progress(), 120, 'while dragging the preview follows the pointer');

  f.api.handleCommit([120]);
  assert.deepEqual(f.seeks, [120]);
  // 上游还没回报新位置（仍是 10），此时不能闪回 10。
  assert.equal(f.progress(), 120, 'after commit the target must not flash back');

  // 播放头还没爬到目标（向前 seek 的正常过程）。
  f.setCurrentTime(90);
  assert.equal(f.progress(), 120, 'still heading towards the target');

  // 到达目标后交回实际进度。
  f.setCurrentTime(121);
  assert.equal(f.progress(), 121, 'once reached, hand back the real position');
});

test('a backward seek keeps the target until playback crosses it', () => {
  const f = setup(300);
  f.api.handleStart();
  f.api.handleValueUpdate([30]);
  f.api.handleCommit([30]);
  assert.equal(f.progress(), 30, '上游还没动，继续显示目标');

  // 向后 seek 的方向是「向下」：播放头从高处落向目标，在越过之前都算未生效。
  // 钉在目标上的这段时间由「上游落点与目标的偏差」决定，通常不到一秒。
  f.setCurrentTime(120);
  assert.equal(f.progress(), 30);
  f.setCurrentTime(30);
  assert.equal(f.progress(), 30, '正好落在目标上，显示值与实际一致');
  f.setCurrentTime(29.4);
  assert.equal(f.progress(), 29.4, '越过目标后交回真实进度');
});

test('a track change clears the pending target', () => {
  const f = setup(10);
  f.api.handleStart();
  f.api.handleValueUpdate([120]);
  f.api.handleCommit([120]);
  // 切歌：useTaskbarSeek 在 trackId 变化时调用 handleCancel。
  f.api.handleCancel();
  f.setCurrentTime(0);
  assert.equal(f.progress(), 0, 'a cancelled gesture must not pin the old target');
});

test('cancelling mid-drag never seeks', () => {
  const f = setup(10);
  f.api.handleStart();
  f.api.handleValueUpdate([120]);
  f.api.handleCancel();
  assert.deepEqual(f.seeks, []);
  assert.equal(f.progress(), 10);
});
