import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { planPageStickyLayout } from '../src/renderer/utils/pageStickyLayout.ts';

const code = transformSync(
  readFileSync(
    new URL('../src/renderer/composables/usePageStickyLayers.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
).code;

function setup() {
  const frames = new Map();
  const observers = [];
  const unmount = [];
  let nextFrame = 0;
  let context;
  let reads = 0;
  const element = (rect) => ({
    style: {
      values: new Map(),
      getPropertyValue(name) {
        return this.values.get(name) ?? '';
      },
      setProperty(name, value) {
        this.values.set(name, value);
      },
    },
    getBoundingClientRect() {
      reads++;
      return rect();
    },
  });
  class Observer {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.targets = [];
    }
  }
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'MutationObserver',
    'getComputedStyle',
    code,
  )(
    (name) => {
      if (name === 'vue')
        return {
          ref: (value) => ({ value }),
          provide: (_key, value) => {
            context = value;
          },
          onBeforeUnmount: (callback) => unmount.push(callback),
        };
      if (name === '@/utils/pageStickyLayout') return { planPageStickyLayout };
      throw new Error(name);
    },
    mod,
    mod.exports,
    (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    (id) => frames.delete(id),
    Observer,
    Observer,
    () => ({ marginTop: '0', marginBottom: '0', zIndex: '100' }),
  );
  const container = element(() => ({}));
  const viewport = Object.assign(
    element(() => ({ top: 0, left: 0, width: 800, height: 600 })),
    {
      isConnected: true,
      dataset: {},
      scrollTop: 0,
      closest: () => container,
    },
  );
  const api = mod.exports.providePageStickyLayers({ value: viewport });
  api.target.value = element(() => ({}));
  return {
    api,
    context,
    viewport,
    container,
    frames,
    observers,
    element,
    get reads() {
      return reads;
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    unmount() {
      unmount.forEach((callback) => callback());
    },
  };
}

test('scroll and observer bursts commit one layout using the latest sliver and tabs geometry', () => {
  const env = setup();
  let expandedHeight = 230;
  const entries = [0, 1].map((index) => ({
    placeholder: env.element(() => ({
      top: (index ? 230 : 0) - env.viewport.scrollTop,
      left: 0,
      width: 800,
    })),
    layer: env.element(() => ({})),
    content: env.element(() => ({ height: index ? 94 : 56 })),
    top: () => (index ? expandedHeight : 0),
    flowHeight: () => (index ? undefined : 56),
  }));
  entries.forEach(env.context.register);
  for (const scrollTop of [0, 50, 170, 5000, 100, 0]) {
    const before = env.reads;
    env.viewport.scrollTop = scrollTop;
    env.api.update(); // Page scroll runs before Vue patches the sliver.
    expandedHeight = Math.max(56, 230 - scrollTop);
    entries[0].content.style.setProperty('--sliver-background-height', `${expandedHeight}px`);
    for (let i = 0; i < 10; i++) env.observers.forEach((observer) => observer.callback());
    assert.equal(env.reads, before, 'event handlers must not synchronously force layout');
    assert.equal(env.frames.size, 1);
    env.flush();
    assert.equal(env.reads - before, 5, 'one viewport read and two reads per header');
    assert.equal(
      entries[1].layer.style.getPropertyValue('transform'),
      `translate3d(0, ${expandedHeight}px, 0)`,
    );
    assert.equal(
      env.container.style.getPropertyValue('--page-sticky-inset'),
      `${expandedHeight + 94}px`,
    );
    assert.equal(env.api.topInset.value, expandedHeight + 94);
  }
  const mutationObservers = env.observers.filter((observer) => observer.targets[0]?.options);
  assert.ok(
    mutationObservers.every((observer) => !observer.targets[0].options.subtree),
    'animated descendants must not trigger geometry measurement',
  );
});

test('removing headers resets clipping and unmount cancels queued layout work', () => {
  const env = setup();
  const unregister = env.context.register({
    placeholder: env.element(() => ({ top: 0, left: 0, width: 800 })),
    content: env.element(() => ({ height: 56 })),
    layer: env.element(() => ({})),
    top: () => 0,
    flowHeight: () => undefined,
  });
  env.flush();
  assert.equal(env.api.topInset.value, 56);
  unregister();
  env.flush();
  assert.equal(env.api.topInset.value, 0);
  assert.equal(env.container.style.getPropertyValue('--page-sticky-inset'), '0px');
  assert.ok(env.observers.every((observer) => observer.targets.length === 0));
  env.api.update();
  env.unmount();
  env.api.update();
  assert.equal(env.frames.size, 0);
});
