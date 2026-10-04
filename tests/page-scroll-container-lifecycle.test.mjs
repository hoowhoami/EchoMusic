import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const { descriptor } = parse(
  readFileSync('src/renderer/components/ui/PageScrollContainer.vue', 'utf8'),
);
const { code } = transformSync(compileScript(descriptor, { id: 'page-scroll-lifecycle' }).content, {
  loader: 'ts',
  format: 'cjs',
});
function fixture(t) {
  const hooks = {},
    observers = [],
    listeners = new Set(),
    writes = [];
  let top = 0,
    invalidations = 0;
  class ResizeObserver {
    targets = new Set();
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(el) {
      this.targets.add(el);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'ResizeObserver', 'window', code)(
    (id) => {
      if (id === 'vue')
        return {
          ...vue,
          useAttrs: () => ({}),
          onMounted: (fn) => {
            hooks.mount = fn;
          },
          onActivated: (fn) => {
            hooks.activate = fn;
          },
          onDeactivated: (fn) => {
            hooks.deactivate = fn;
          },
          onBeforeUnmount: (fn) => {
            hooks.unmount = fn;
          },
        };
      if (id === '@/composables/usePageStickyLayers')
        return {
          providePageStickyLayers: () => ({
            target: vue.ref(null),
            topInset: vue.ref(0),
            update() {},
            invalidate: () => {
              invalidations++;
            },
            onWheel() {},
          }),
        };
      if (id === '@/composables/usePageScroll') return { provideScrollContainer() {} };
      return { default: {} };
    },
    mod,
    mod.exports,
    ResizeObserver,
    {
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    },
  );
  const scope = vue.effectScope();
  const api = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  api.scrollContainerEl.value = vue.markRaw({
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      top = value;
      writes.push(value);
    },
  });
  t.after(() => {
    hooks.unmount();
    scope.stop();
  });
  return {
    api,
    hooks,
    observers,
    listeners,
    writes,
    get top() {
      return top;
    },
    set top(value) {
      top = value;
    },
    get invalidations() {
      return invalidations;
    },
    activeObservers: () => observers.filter((observer) => observer.targets.size).length,
  };
}

test('page mount/activate deduplicates observation, cache pauses it, return restores position', async (t) => {
  const f = fixture(t);
  f.hooks.mount();
  f.hooks.activate();
  await vue.nextTick();
  assert.equal(f.activeObservers(), 1);
  assert.equal(f.listeners.size, 1);
  f.top = 960;
  f.api.handleScroll();
  f.hooks.deactivate();
  assert.equal(f.activeObservers(), 0);
  assert.equal(f.listeners.size, 0);
  f.top = 0;
  f.api.handleScroll(); // detached DOM reset must not overwrite saved position
  f.hooks.activate();
  await vue.nextTick();
  assert.equal(f.top, 960);
  assert.equal(f.activeObservers(), 1);
  assert.equal(f.listeners.size, 1);
});

test('quick activate/deactivate prevents a queued restore from mutating a hidden page', async (t) => {
  const f = fixture(t);
  f.hooks.mount();
  await vue.nextTick();
  f.top = 420;
  f.api.handleScroll();
  f.hooks.deactivate();
  f.top = 0;
  f.hooks.activate();
  f.hooks.deactivate();
  await vue.nextTick();
  assert.equal(f.top, 0);
  assert.deepEqual(f.writes, []);
  f.hooks.activate();
  await vue.nextTick();
  assert.deepEqual(f.writes, [420]);
});

test('unmount invalidates pending restoration and a late activation cannot resurrect resources', async (t) => {
  const f = fixture(t);
  f.hooks.mount();
  await vue.nextTick();
  f.top = 200;
  f.api.handleScroll();
  f.hooks.deactivate();
  f.top = 0;
  const invalidations = f.invalidations;
  f.hooks.activate();
  f.hooks.unmount();
  f.hooks.activate();
  await vue.nextTick();
  assert.equal(f.top, 0);
  assert.equal(f.invalidations, invalidations);
  assert.equal(f.activeObservers(), 0);
  assert.equal(f.listeners.size, 0);
});
