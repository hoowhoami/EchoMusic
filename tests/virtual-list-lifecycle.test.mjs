import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const code = transformSync(
  readFileSync(new URL('../src/renderer/composables/useVirtualList.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const gridCode = transformSync(
  readFileSync(new URL('../src/renderer/composables/useVirtualGrid.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
async function fixture(grid = false) {
  const hooks = {};
  const observers = [];
  let width = 800;
  let widthReads = 0;
  const frames = new Map();
  const listeners = new Set();
  let nextId = 0;
  let requests = 0;
  let contentTop = 100;
  const scrollTargets = [];
  const scroll = {
    scrollTop: 0,
    clientHeight: 120,
    getBoundingClientRect: () => ({ top: 10 }),
    addEventListener(_, fn) {
      listeners.add(fn);
    },
    removeEventListener(_, fn) {
      listeners.delete(fn);
    },
    scrollTo(value) {
      scrollTargets.push(value);
    },
  };
  const container = {
    get clientWidth() {
      widthReads++;
      return width;
    },
    getBoundingClientRect: () => ({ top: 10 + contentTop - scroll.scrollTop }),
  };
  const options = {
    items: vue.ref(Array.from({ length: 100 }, (_, id) => ({ id }))),
    itemHeight: 100,
    itemCount: vue.ref(100),
    itemSize: 20,
    overscan: vue.ref(2),
    paddingEnd: 1000,
    scrollContainer: vue.shallowRef(scroll),
    active: vue.ref(true),
  };
  const mod = { exports: {} };
  const load = (source, output) =>
    new Function(
      'require',
      'module',
      'exports',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      source,
    )(
      (name) =>
        name === 'vue'
          ? {
              ...vue,
              onBeforeUnmount: (fn) => {
                hooks.unmount = fn;
              },
              onActivated: (fn) => {
                hooks.activate = fn;
              },
              onDeactivated: (fn) => {
                hooks.deactivate = fn;
              },
            }
          : name === './useVirtualList'
            ? mod.exports
            : {
                useResizeObserver(target, callback) {
                  const observer = { target: null, callback };
                  observers.push(observer);
                  vue.watch(
                    () => vue.toValue(target),
                    (value) => {
                      observer.target = value;
                    },
                    { immediate: true, flush: 'post' },
                  );
                  vue.onScopeDispose(() => {
                    observer.target = null;
                  });
                },
              },
      output,
      output.exports,
      (fn) => {
        requests++;
        frames.set(++nextId, fn);
        return nextId;
      },
      (id) => frames.delete(id),
    );
  load(code, mod);
  const gridMod = { exports: {} };
  if (grid) load(gridCode, gridMod);
  const scope = vue.effectScope();
  const api = scope.run(() =>
    grid ? gridMod.exports.useVirtualGrid(options) : mod.exports.useVirtualList(options),
  );
  api.containerRef.value = container;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await vue.nextTick();
  };
  const frame = () => {
    const jobs = [...frames.values()];
    frames.clear();
    jobs.forEach((fn) => fn());
  };
  await flush();
  frame();
  return {
    api,
    options,
    scroll,
    frames,
    listeners,
    hooks,
    flush,
    frame,
    scrollTargets,
    observers,
    get widthReads() {
      return widthReads;
    },
    setWidth(value) {
      width = value;
    },
    notifyWidth(value) {
      observers
        .at(-1)
        .callback([{ target: api.containerRef.value, contentRect: { width: value } }]);
    },
    get requests() {
      return requests;
    },
    setContentTop(value) {
      contentTop = value;
    },
    dispose() {
      hooks.unmount();
      scope.stop();
    },
  };
}
test('scroll bursts coalesce to one frame and measure the latest position', async () => {
  const s = await fixture();
  const before = s.requests;
  for (let i = 0; i < 100; i++) {
    s.scroll.scrollTop = 200 + i;
    for (const fn of s.listeners) fn();
  }
  assert.equal(s.requests - before, 1);
  assert.equal(s.frames.size, 1);
  s.frame();
  assert.equal(s.api.visibleStart.value, 7);
  assert.equal(s.api.visibleEnd.value, 18);
  s.dispose();
});
test('pending nextTick work cannot schedule frames or rebind scrolling after unmount', async () => {
  const s = await fixture();
  s.options.itemCount.value = 50;
  s.api.containerRef.value = { getBoundingClientRect: () => ({ top: 0 }) };
  await vue.nextTick();
  s.dispose();
  await s.flush();
  assert.equal(s.frames.size, 0);
  assert.equal(s.listeners.size, 0);
  s.api.refresh(true);
  assert.equal(s.frames.size, 0);
});
test('KeepAlive and inactive lists release listeners and remeasure on activation', async () => {
  const s = await fixture();
  s.hooks.deactivate();
  assert.equal(s.listeners.size, 0);
  s.api.refresh(true);
  assert.equal(s.frames.size, 0);
  s.setContentTop(200);
  s.scroll.scrollTop = 300;
  s.hooks.activate();
  s.frame();
  assert.equal(s.listeners.size, 1);
  assert.equal(s.api.visibleStart.value, 3);
  s.options.active.value = false;
  await s.flush();
  s.frame();
  assert.equal(s.listeners.size, 0);
  assert.equal(s.api.visibleEnd.value, 0);
  s.options.active.value = true;
  await s.flush();
  s.frame();
  assert.equal(s.listeners.size, 1);
  assert.ok(s.api.visibleEnd.value > 0);
  s.dispose();
});
test('bottom padding and changing overscan never produce out-of-bounds ranges', async () => {
  const s = await fixture();
  s.scroll.scrollTop = 2400;
  s.api.refresh();
  s.frame();
  assert.ok(s.api.visibleStart.value <= 100);
  assert.ok(s.api.visibleEnd.value <= 100);
  s.scroll.scrollTop = 300;
  s.api.refresh();
  s.frame();
  s.options.overscan.value = 8;
  await s.flush();
  s.frame();
  assert.equal(s.api.visibleStart.value, 2);
  s.api.scrollToIndex(Infinity);
  assert.equal(s.scrollTargets.length, 0);
  s.api.scrollToIndex(999);
  assert.equal(s.scrollTargets[0].top, 2080);
  s.dispose();
});

test('inactive lists disconnect resize targets and reject late resize callbacks and refreshes', async () => {
  const s = await fixture();
  assert.equal(s.observers.filter((o) => o.target).length, 2);
  s.api.refresh();
  s.options.active.value = false;
  await s.flush();
  assert.equal(s.frames.size, 0);
  assert.equal(s.observers.filter((o) => o.target).length, 0);
  s.observers.forEach((o) => o.callback([]));
  s.options.itemCount.value = 200;
  s.api.refresh(true);
  s.api.scrollToIndex(20, 'instant');
  await s.flush();
  assert.equal(s.frames.size, 0);
  assert.equal(s.scrollTargets.length, 0);
  s.options.active.value = true;
  await s.flush();
  assert.equal(s.observers.filter((o) => o.target).length, 2);
  assert.equal(s.frames.size, 1);
  s.dispose();
  s.hooks.activate();
  await s.flush();
  assert.equal(s.observers.filter((o) => o.target).length, 0);
  assert.equal(s.frames.size, 0);
});
test('cached grids retain columns and resume with the latest width and visible range', async () => {
  const s = await fixture(true);
  s.scroll.scrollTop = 1000;
  s.api.refresh();
  s.frame();
  assert.equal(s.api.columnCount.value, 4);
  assert.equal(s.api.visibleItems.value[0].index, 20);
  assert.equal(s.observers.filter((o) => o.target).length, 3);
  s.hooks.deactivate();
  await s.flush();
  assert.equal(s.observers.filter((o) => o.target).length, 0);
  const reads = s.widthReads;
  s.setWidth(0);
  s.notifyWidth(0);
  s.api.refresh();
  s.options.items.value = [...s.options.items.value, { id: 100 }];
  await s.flush();
  assert.equal(s.widthReads, reads);
  assert.equal(s.api.columnCount.value, 4);
  assert.equal(s.frames.size, 0);
  s.setWidth(380);
  s.hooks.activate();
  await s.flush();
  s.frame();
  assert.equal(s.observers.filter((o) => o.target).length, 3);
  assert.equal(s.api.columnCount.value, 2);
  assert.equal(s.api.visibleItems.value[0].index, 10);
  assert.equal(s.api.visibleItems.value.at(-1).index, 21);
  assert.equal(s.scroll.scrollTop, 1000);
  s.dispose();
});
test('zero width and detached-node resize notifications cannot collapse a grid', async () => {
  const s = await fixture(true);
  s.notifyWidth(0);
  assert.equal(s.api.columnCount.value, 4);
  s.observers.at(-1).callback([{ target: {}, contentRect: { width: 180 } }]);
  assert.equal(s.api.columnCount.value, 4);
  s.options.active.value = false;
  await s.flush();
  const reads = s.widthReads;
  s.notifyWidth(180);
  s.api.refresh();
  assert.equal(s.api.columnCount.value, 4);
  assert.equal(s.widthReads, reads);
  s.setWidth(580);
  s.options.active.value = true;
  await s.flush();
  s.frame();
  assert.equal(s.api.columnCount.value, 3);
  s.dispose();
  s.notifyWidth(180);
  s.api.refresh();
  assert.equal(s.api.columnCount.value, 3);
});
