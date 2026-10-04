import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const { descriptor } = parse(readFileSync('src/renderer/components/ui/Scrollbar.vue', 'utf8'));
const script = compileScript(descriptor, { id: 'scrollbar-lifecycle' });
const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });

async function fixture(t, mounted = true) {
  const hooks = {},
    frames = new Map(),
    timers = new Map(),
    listeners = new Map(),
    observers = [],
    events = [];
  let sequence = 0,
    requests = 0;
  class Element {
    scrollTop = 120;
    scrollHeight = 1600;
    clientHeight = 400;
    firstElementChild = null;
    getBoundingClientRect() {
      return { top: 0 };
    }
    scrollTo(options) {
      if (options.top !== undefined) this.scrollTop = options.top;
    }
  }
  class ResizeObserver {
    observed = new Set();
    constructor(callback) {
      this.fire = callback;
      observers.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
  }
  const doc = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'HTMLElement',
    'ResizeObserver',
    'document',
    'window',
    'clearTimeout',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    code,
  )(
    (id) => {
      if (id === 'vue')
        return {
          ...vue,
          useAttrs: () => ({}),
          onMounted: (fn) => {
            hooks.mount = fn;
          },
          onBeforeUnmount: (fn) => {
            hooks.unmount = fn;
          },
          onActivated: (fn) => {
            hooks.activate = fn;
          },
          onDeactivated: (fn) => {
            hooks.deactivate = fn;
          },
        };
      if (id === '@/utils/scrollMotion')
        return { resolveScrollBehavior: (value = 'auto') => value };
      throw new Error(`Unexpected dependency ${id}`);
    },
    mod,
    mod.exports,
    Element,
    ResizeObserver,
    doc,
    {
      setTimeout: (fn) => {
        const id = ++sequence;
        timers.set(id, fn);
        return id;
      },
    },
    (id) => timers.delete(id),
    (fn) => {
      requests++;
      const id = ++sequence;
      frames.set(id, fn);
      return id;
    },
    (id) => frames.delete(id),
  );
  const scope = vue.effectScope();
  const props = vue.shallowReactive({
    hideScrollbar: false,
    scrollbarInset: 6,
    scrollbarRightInset: 2,
    scrollbarRightBleed: 0,
    scrollbarTopInset: 0,
    contentProps: null,
  });
  const api = scope.run(() =>
    mod.exports.default.setup(props, { expose() {}, emit: (...args) => events.push(args) }),
  );
  const wrap = vue.markRaw(new Element()),
    view = vue.markRaw(new Element());
  api.setContentRef(wrap);
  api.setViewRef(view);
  api.scrollAreaRef.value = wrap;
  const flush = async () => {
    for (let i = 0; i < 4; i++) await vue.nextTick();
  };
  const frame = () => {
    const jobs = [...frames.values()];
    frames.clear();
    jobs.forEach((fn) => fn());
  };
  let disposed = false;
  const unmount = () => {
    if (!disposed) {
      disposed = true;
      hooks.unmount();
      scope.stop();
    }
  };
  t.after(unmount);
  await flush();
  if (mounted) {
    hooks.mount();
    await flush();
    frame();
  }
  return {
    api,
    props,
    hooks,
    wrap,
    frames,
    timers,
    listeners,
    observers,
    events,
    flush,
    frame,
    unmount,
    activeObservers: () => observers.filter((o) => o.observed.size),
    get requests() {
      return requests;
    },
  };
}

test('resize bursts share one frame and measure the latest dimensions', async (t) => {
  const f = await fixture(t),
    requests = f.requests;
  const observer = f.activeObservers()[0];
  for (let i = 0; i < 40; i++) observer.fire();
  f.wrap.scrollHeight = 2200;
  assert.equal(f.frames.size, 1);
  assert.equal(f.requests - requests, 1);
  f.frame();
  assert.equal(f.api.scrollHeight.value, 2200);
});

test('unmount cancels queued mount work and late observer callbacks', async (t) => {
  const f = await fixture(t, false);
  f.hooks.mount();
  const observer = f.activeObservers()[0];
  f.unmount();
  observer.fire();
  await f.flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.activeObservers().length, 0);
  assert.equal(f.requests, 0);
});

test('deactivation releases dragging listeners, timers, measurement and observation', async (t) => {
  const f = await fixture(t),
    observer = f.activeObservers()[0];
  f.api.handleScroll({ type: 'scroll' });
  f.api.handleThumbMouseDown({ preventDefault() {}, clientY: 30 });
  observer.fire();
  assert.equal(f.listeners.get('mousemove').size, 1);
  assert.equal(f.timers.size, 1);
  f.hooks.deactivate();
  assert.equal(f.api.isDragging.value, false);
  assert.equal(f.api.isHovering.value, false);
  assert.equal(f.listeners.get('mousemove').size, 0);
  assert.equal(f.listeners.get('mouseup').size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.activeObservers().length, 0);
  const count = f.events.length;
  f.wrap.scrollTop = 0;
  f.api.handleScroll({ type: 'scroll' });
  observer.fire();
  await f.flush();
  assert.equal(f.events.length, count, 'hidden reset must not overwrite the page scroll cache');
  assert.equal(f.frames.size, 0);
});

test('activation measures current geometry without duplicate observers or changing scroll position', async (t) => {
  const f = await fixture(t);
  f.hooks.deactivate();
  f.wrap.clientHeight = 520;
  f.wrap.scrollHeight = 3100;
  f.wrap.scrollTop = 420;
  f.hooks.activate();
  f.hooks.activate();
  await f.flush();
  assert.equal(f.activeObservers().length, 1);
  assert.equal(f.frames.size, 1);
  f.frame();
  assert.equal(f.api.clientHeight.value, 520);
  assert.equal(f.api.scrollHeight.value, 3100);
  assert.equal(f.api.scrollTop.value, 420);
  assert.equal(f.wrap.scrollTop, 420);
  f.api.handleThumbMouseDown({ preventDefault() {}, clientY: 0 });
  f.api.handleMouseMove({ clientY: 10 });
  assert.ok(f.wrap.scrollTop > 420);
  f.api.handleMouseUp();
  assert.equal(f.listeners.get('mousemove').size, 0);
});

test('content-ref updates in a cached page cannot reconnect observers', async (t) => {
  const f = await fixture(t);
  f.hooks.deactivate();
  f.props.contentProps = { ref() {} };
  await f.flush();
  assert.equal(f.activeObservers().length, 0);
  assert.equal(f.frames.size, 0);
  f.hooks.activate();
  await f.flush();
  assert.equal(f.activeObservers().length, 1);
});

test('queued content-ref work cannot reconnect after disposal or late activation', async (t) => {
  const f = await fixture(t);
  f.props.contentProps = { ref() {} };
  await vue.nextTick();
  f.unmount();
  f.hooks.activate();
  await f.flush();
  assert.equal(f.activeObservers().length, 0);
  assert.equal(f.frames.size, 0);
});
