import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';

const loadToastStore = () => {
  const source = readFileSync(new URL('../src/renderer/stores/toast.ts', import.meta.url), 'utf8');
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.equal(name, 'pinia');
      return pinia;
    },
    module,
    module.exports,
  );
  return module.exports.useToastStore;
};

test('toast store deduplicates, resolves variants, and keeps a short queue', (t) => {
  const originalWindow = globalThis.window;
  const originalDateNow = Date.now;
  const timers = new Map();
  let timerId = 0;
  let now = 1000;

  globalThis.window = {
    setTimeout(callback, duration) {
      const id = ++timerId;
      timers.set(id, { callback, duration });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  Date.now = () => now;

  t.after(() => {
    globalThis.window = originalWindow;
    Date.now = originalDateNow;
  });

  pinia.setActivePinia(pinia.createPinia());
  const useToastStore = loadToastStore();
  const store = useToastStore();

  const firstId = store.success('已添加到播放队列');
  assert.equal(store.items[0].variant, 'mini');
  assert.equal(store.items[0].count, 1);
  assert.equal(timers.size, 1);

  assert.equal(store.success('已添加到播放队列'), firstId);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].count, 2);
  assert.equal(timers.size, 1, 'a duplicate restarts rather than adds a timer');

  store.showAction('检测到分享链接', { label: '打开', handler() {} });
  assert.equal(store.items[1].variant, 'standard');

  store.warning('第二条不同提示');
  store.info('最新提示');
  assert.equal(store.items.length, 3);
  assert.deepEqual(
    store.items.map((item) => item.message),
    ['已添加到播放队列', '第二条不同提示', '最新提示'],
  );

  now += 600;
  store.pause(firstId);
  assert.equal(timers.size, 0);
  store.resume(firstId);
  assert.equal([...timers.values()][0].duration, 2000);

  store.remove(firstId);
  assert.equal(store.items[0].message, '第二条不同提示');
  assert.equal(timers.size, 1, 'the next queued toast starts its timer when shown');
});
