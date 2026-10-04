import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

function loadPolicy(windowValue) {
  const module = { exports: {} };
  const code = transformSync(readFileSync('src/renderer/utils/scrollMotion.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'window', code)(module, module.exports, windowValue);
  return module.exports;
}

test('smooth scroll reads the current preference for every interaction', () => {
  let reduced = false;
  const { resolveScrollBehavior } = loadPolicy({
    matchMedia: (query) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return { matches: reduced };
    },
  });
  assert.equal(resolveScrollBehavior('smooth'), 'smooth');
  reduced = true;
  assert.equal(resolveScrollBehavior('smooth'), 'instant'); // auto could inherit smooth CSS
  reduced = false;
  assert.equal(resolveScrollBehavior('smooth'), 'smooth');
});

test('explicit instant, auto and omitted behavior preserve existing scroll contracts', () => {
  const { resolveScrollBehavior } = loadPolicy({ matchMedia: () => ({ matches: true }) });
  assert.equal(resolveScrollBehavior('instant'), 'instant');
  assert.equal(resolveScrollBehavior('auto'), 'auto');
  assert.equal(resolveScrollBehavior(), 'auto');
});

test('policy is safe without a browser or matchMedia', () => {
  for (const target of [undefined, {}]) {
    assert.equal(loadPolicy(target).resolveScrollBehavior('smooth'), 'smooth');
  }
});

function fixture(threshold) {
  let cleanup;
  let activate, deactivate;
  const { descriptor } = parse(readFileSync('src/renderer/components/ui/BackToTop.vue', 'utf8'));
  const script = compileScript(descriptor, { id: 'back-to-top-test' });
  const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id === 'vue')
        return {
          ...vue,
          onActivated: (fn) => {
            activate = fn;
          },
          onDeactivated: (fn) => {
            deactivate = fn;
          },
          onUnmounted: (fn) => {
            cleanup = fn;
          },
        };
      return { default: {} };
    },
    module,
    module.exports,
  );
  function target(top) {
    const listeners = new Set(),
      calls = [];
    return {
      scrollTop: top,
      listeners,
      calls,
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
      scrollTo: (options) => calls.push(options),
    };
  }
  const first = target(500),
    props = vue.shallowReactive({ scrollContainer: first, threshold });
  const scope = vue.effectScope();
  const api = scope.run(() => module.exports.default.setup(props, { expose() {} }));
  return {
    api,
    props,
    first,
    target,
    activate: () => activate?.(),
    deactivate: () => deactivate?.(),
    dispose: () => {
      cleanup();
      scope.stop();
    },
  };
}

test('back to top jumps immediately even from a long scroll distance', () => {
  const f = fixture();
  try {
    assert.equal(f.api.visible.value, true);
    f.api.scrollToTop();
    f.first.scrollTop = 100_000;
    f.api.scrollToTop();
    assert.deepEqual(f.first.calls, [
      { top: 0, behavior: 'instant' },
      { top: 0, behavior: 'instant' },
    ]);
  } finally {
    f.dispose();
  }
});

test('back to top detaches old targets and has no stale action after unmount', async () => {
  const f = fixture();
  const second = f.target(0);
  f.props.scrollContainer = second;
  await vue.nextTick();
  assert.equal(f.first.listeners.size, 0);
  assert.equal(second.listeners.size, 1);
  assert.equal(f.api.visible.value, false);
  second.scrollTop = 301;
  second.listeners.forEach((fn) => fn());
  assert.equal(f.api.visible.value, true);
  f.api.scrollToTop();
  assert.equal(f.first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  f.dispose();
  assert.equal(second.listeners.size, 0);
  f.api.scrollToTop();
  assert.equal(second.calls.length, 1);
});

test('a zero threshold shows the button after the first positive scroll offset', () => {
  const f = fixture(0);
  try {
    f.first.scrollTop = 1;
    f.api.handleScroll();
    assert.equal(f.api.visible.value, true);
    f.first.scrollTop = 0;
    f.api.handleScroll();
    assert.equal(f.api.visible.value, false);
  } finally {
    f.dispose();
  }
});

test('cached back-to-top buttons release scrolling and do not act on hidden containers', async () => {
  const f = fixture();
  const lateScroll = [...f.first.listeners][0];
  f.deactivate();
  assert.equal(f.first.listeners.size, 0);
  assert.equal(f.api.visible.value, false);
  f.api.scrollToTop();
  lateScroll();
  assert.equal(f.first.calls.length, 0);
  assert.equal(f.api.visible.value, false);
  f.first.scrollTop = 100;
  f.activate();
  assert.equal(f.first.listeners.size, 1);
  assert.equal(f.api.visible.value, false);
  f.first.scrollTop = 960;
  f.deactivate();
  f.activate();
  assert.equal(f.api.visible.value, true);
  f.api.scrollToTop();
  assert.deepEqual(f.first.calls, [{ top: 0, behavior: 'instant' }]);
  f.dispose();
});

test('container replacements during cache wait until activation to bind', async () => {
  const f = fixture();
  f.deactivate();
  const second = f.target(900);
  f.props.scrollContainer = second;
  await vue.nextTick();
  assert.equal(f.first.listeners.size, 0);
  assert.equal(second.listeners.size, 0);
  assert.equal(f.api.visible.value, false);
  f.activate();
  assert.equal(second.listeners.size, 1);
  assert.equal(f.api.visible.value, true);
  f.api.scrollToTop();
  assert.equal(f.first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  f.dispose();
  f.activate();
  assert.equal(second.listeners.size, 0);
  assert.equal(f.api.visible.value, false);
});

test('threshold changes update visibility without waiting for scroll or rebinding the target', async () => {
  const f = fixture();
  const listener = [...f.first.listeners][0];
  f.props.threshold = 600;
  await vue.nextTick();
  assert.equal(f.api.visible.value, false);
  assert.deepEqual([...f.first.listeners], [listener]);
  f.props.threshold = 0;
  await vue.nextTick();
  assert.equal(f.api.visible.value, true);
  f.first.scrollTop = 50;
  f.deactivate();
  f.props.threshold = 100;
  await vue.nextTick();
  assert.equal(f.first.listeners.size, 0);
  assert.equal(f.api.visible.value, false);
  f.activate();
  assert.equal(f.api.visible.value, false);
  f.dispose();
});

test('pending target changes cannot reconnect a disposed back-to-top button', async () => {
  const f = fixture();
  const second = f.target(1000);
  f.props.scrollContainer = second;
  f.dispose();
  await vue.nextTick();
  f.activate();
  f.api.bind(second);
  f.api.scrollToTop();
  assert.equal(f.first.listeners.size, 0);
  assert.equal(second.listeners.size, 0);
  assert.equal(second.calls.length, 0);
  assert.equal(f.api.visible.value, false);
});
