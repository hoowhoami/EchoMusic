import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';

function load(path, dependencies) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(path, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  new Function('require', 'module', 'exports', code)(
    (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const noticeDetails = load('src/renderer/stores/player/noticeDetails.ts', {});
const { watchPlaybackNoticeToasts } = load('src/renderer/stores/player/noticeToast.ts', {
  vue,
  './noticeDetails': noticeDetails,
});
function fixture(t) {
  const originalWindow = globalThis.window;
  let id = 0;
  const timers = new Map();
  globalThis.window = {
    setTimeout: (fn, duration) => {
      timers.set(++id, { fn, duration });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const useToastStore = load('src/renderer/stores/toast.ts', { pinia }).useToastStore;
  const toast = useToastStore(pinia.createPinia());
  const state = vue.reactive({
    playbackNotice: null,
    playbackRequestSeq: 1,
    currentTrackSnapshot: { id: 'a', name: '测试歌曲' },
    autoNextTimer: null,
  });
  const stop = watchPlaybackNoticeToasts(state, toast);
  t.after(() => {
    stop();
    globalThis.window = originalWindow;
  });
  const fail = (patch = {}) => {
    state.playbackNotice = {
      code: 'playback-failed',
      title: '播放失败',
      reason: '音频加载或播放过程中出现异常',
      detail: '3 秒后尝试下一首',
      trackId: 'a',
      ...patch,
    };
  };
  return { toast, state, timers, fail };
}

test('fatal playback errors use a titled six-second toast and only promise an arranged auto-next', async (t) => {
  const f = fixture(t);
  f.fail();
  await vue.nextTick();
  assert.equal(f.toast.items.length, 1);
  assert.deepEqual(
    (({ title, message, tone, variant, duration }) => ({
      title,
      message,
      tone,
      variant,
      duration,
    }))(f.toast.items[0]),
    {
      title: '播放失败 · 测试歌曲',
      message: '音频加载或播放过程中出现异常\n请稍后重试',
      tone: 'danger',
      variant: 'standard',
      duration: 6000,
    },
  );
  assert.equal([...f.timers.values()][0].duration, 6000);
  [...f.timers.values()][0].fn();
  assert.equal(f.toast.items.length, 0);

  f.state.playbackRequestSeq++;
  f.fail({ code: 'audio-url-unavailable' });
  f.state.autoNextTimer = 42;
  await vue.nextTick();
  assert.match(f.toast.items[0].message, /3 秒后尝试下一首/);
});

test('an unscheduled auto-next falls back to advice for the actual cause', async (t) => {
  const f = fixture(t);
  for (const [reason, message] of [
    ['当前歌曲需要 VIP 权限', '当前歌曲需要 VIP 权限'],
    ['需要购买歌曲或专辑后播放', '需要购买歌曲或专辑后播放'],
    ['网络连接异常', '网络连接异常\n请检查网络后重试'],
    ['音源加载超时', '音源加载超时\n请检查网络后重试'],
  ]) {
    f.state.playbackRequestSeq++;
    f.fail({ reason });
    await vue.nextTick();
    assert.equal(f.toast.items[0].message, message);
    f.toast.remove(f.toast.items[0].id);
  }
  f.state.playbackRequestSeq++;
  f.state.autoNextTimer = 42;
  f.fail({ reason: '当前歌曲需要 VIP 权限' });
  await vue.nextTick();
  assert.equal(f.toast.items[0].message, '当前歌曲需要 VIP 权限\n3 秒后尝试下一首');
});

test('duplicate engine events do not repeat an attempt but a new retry can notify again', async (t) => {
  const f = fixture(t);
  f.fail();
  await vue.nextTick();
  const firstId = f.toast.items[0].id;
  f.fail();
  await vue.nextTick();
  assert.equal(f.toast.items.length, 1);
  assert.equal(f.toast.items[0].count, 1);
  f.toast.remove(firstId);
  f.fail();
  await vue.nextTick();
  assert.equal(f.toast.items.length, 0, 'dismissed failures stay dismissed for the same attempt');
  f.state.playbackRequestSeq++;
  f.fail();
  await vue.nextTick();
  assert.equal(f.toast.items.length, 1);
});

test('recovery and effect feedback do not create stale error toasts', async (t) => {
  const f = fixture(t);
  f.fail();
  f.state.playbackNotice = null;
  await vue.nextTick();
  assert.equal(f.toast.items.length, 0, 'an error cleared by same-turn recovery is not shown');
  for (const code of [
    'audio-effect-unavailable',
    'audio-effect-apply-failed',
    'audio-effect-cloud-fallback',
  ]) {
    f.fail({ code });
    await vue.nextTick();
  }
  assert.equal(f.toast.items.length, 0);
  f.fail();
  await vue.nextTick();
  f.toast.remove(f.toast.items[0].id);
  f.state.playbackNotice = null;
  await vue.nextTick();
  f.fail();
  await vue.nextTick();
  assert.equal(f.toast.items.length, 1, 'a new failure after recovery can notify');
});

test('output-device notices retain their own recovery advice without falsely reporting another song', async (t) => {
  const f = fixture(t);
  f.fail({
    code: 'output-device-unavailable',
    title: '输出设备不可用',
    reason: '输出设备已断开',
    detail: '连接或启用音频输出设备后重试',
    trackId: null,
  });
  await vue.nextTick();
  assert.equal(f.toast.items[0].title, '输出设备不可用');
  assert.equal(f.toast.items[0].message, '输出设备已断开\n连接或启用音频输出设备后重试');
});

test('toast deduplication keeps identical reasons for different tracks distinct', async (t) => {
  const f = fixture(t);
  f.fail();
  await vue.nextTick();
  f.state.playbackRequestSeq++;
  f.state.currentTrackSnapshot = { id: 'b', name: '下一首歌曲' };
  f.fail({ trackId: 'b' });
  await vue.nextTick();
  assert.deepEqual(
    f.toast.items.map((item) => item.title),
    ['播放失败 · 测试歌曲', '播放失败 · 下一首歌曲'],
  );
  assert.ok(f.toast.items.every((item) => item.count === 1));
});
