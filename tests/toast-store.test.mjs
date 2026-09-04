import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

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
  assert.equal(timers.size, 1, 'passive notices expire even while hovered');
  store.resume(firstId);
  assert.equal([...timers.values()][0].duration, 2600);

  store.remove(firstId);
  assert.equal(store.items[0].message, '第二条不同提示');
  assert.equal(timers.size, 1, 'the next queued toast starts its timer when shown');
});

test('action toasts resume remaining time without stale events extending the queue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  pinia.setActivePinia(pinia.createPinia());
  const store = loadToastStore()();
  const id = store.showAction('已下载音效', { label: '立即使用', handler() {} }, 'success', 6000);
  t.mock.timers.tick(1000);
  store.pause(id);
  t.mock.timers.tick(10000);
  assert.equal(store.items[0].id, id, 'the action stays available while hovered');
  store.resume(id);
  t.mock.timers.tick(2000);
  store.resume(id);
  t.mock.timers.tick(3000);
  assert.equal(store.items.length, 0, 'repeated resume does not restart a running timer');

  const actionId = store.showAction('已下载另一音效', { label: '立即使用', handler() {} });
  store.pause(actionId);
  const noticeId = store.success(`已使用“${'下载音效'.repeat(10)}”`, 2600);
  store.remove(actionId);
  t.mock.timers.tick(600);
  store.pause(actionId);
  store.resume(actionId);
  store.pause(noticeId);
  assert.equal(store.items[0].variant, 'standard');
  t.mock.timers.tick(2000);
  assert.equal(store.items.length, 0, 'the success notice expires after applying a download');
});

test('toast viewport binds hover to the rendered card and resumes on blur or unmount', (t) => {
  const calls = [];
  const store = {
    items: [{ id: 2 }],
    pause: (id) => calls.push(['pause', id]),
    resume: (id) => calls.push(['resume', id]),
  };
  const listeners = new Map();
  let mount, unmount;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalObserver = globalThis.MutationObserver;
  globalThis.window = {
    innerWidth: 1000,
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  globalThis.document = { body: {} };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const scope = vue.effectScope();
  t.after(() => {
    scope.stop();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalObserver;
  });
  const { descriptor } = parse(
    readFileSync(
      new URL('../src/renderer/components/app/ToastViewport.vue', import.meta.url),
      'utf8',
    ),
  );
  const { code } = transformSync(compileScript(descriptor, { id: 'toast-test' }).content, {
    loader: 'ts',
    format: 'cjs',
  });
  const module = { exports: {} };
  const imports = {
    vue: {
      ...vue,
      onMounted: (fn) => {
        mount = fn;
      },
      onUnmounted: (fn) => {
        unmount = fn;
      },
    },
    'vue-router': { useRoute: () => ({ fullPath: '/' }) },
    '@/stores/toast': { useToastStore: () => store },
  };
  new Function('require', 'module', 'exports', code)(
    (id) => imports[id] ?? {},
    module,
    module.exports,
  );
  const api = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  const leavingCard = { currentTarget: { dataset: { toastId: '1' } } };
  api.pauseToast(leavingCard);
  api.resumeToast(leavingCard);
  assert.deepEqual(
    calls.splice(0),
    [
      ['pause', 1],
      ['resume', 1],
    ],
    'events from a leaving card cannot pause or restart its replacement',
  );
  mount();
  listeners.get('blur')();
  unmount();
  assert.deepEqual(calls, [
    ['resume', 2],
    ['resume', 2],
  ]);
  assert.equal(listeners.size, 0);
});
