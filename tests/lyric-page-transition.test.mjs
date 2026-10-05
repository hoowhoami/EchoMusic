import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const code = buildSync({
  entryPoints: ['src/renderer/composables/useLyricPageTransition.ts'],
  bundle: true,
  external: ['vue'],
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ cover = true, reduced = false, ready = true, sourceVisible = true } = {}) {
  const animations = [],
    flights = [],
    observers = [],
    frames = new Map(),
    timers = new Map();
  const operations = [];
  let dispose,
    nextId = 1;
  class Element {
    constructor(bounds = { left: 0, top: 0, width: 0, height: 0 }) {
      this.bounds = bounds;
      this.style = {
        getPropertyValue(key) {
          return this[key] ?? '';
        },
        getPropertyPriority(key) {
          return this[`${key}Priority`] ?? '';
        },
        setProperty(key, value, priority) {
          this[key] = value;
          this[`${key}Priority`] = priority;
        },
        removeProperty(key) {
          delete this[key];
          delete this[`${key}Priority`];
        },
      };
      this.attrs = new Map();
      this.dataset = {};
      this.isConnected = true;
    }
    setAttribute(key, value) {
      this.attrs.set(key, value);
    }
    removeAttribute(key) {
      this.attrs.delete(key);
    }
    getBoundingClientRect() {
      operations.push('geometry-read');
      return this.bounds;
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    cloneNode() {
      return new Element();
    }
    append(child) {
      (this.children ??= []).push(child);
    }
    remove() {
      this.removed = true;
    }
    animate(frames, options) {
      let resolve, reject;
      const animation = {
        element: this,
        frames,
        options,
        finished: new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
        finish: () => resolve(),
        cancel: () => {
          animation.cancelled = true;
          reject(new Error('cancelled'));
        },
      };
      animations.push(animation);
      return animation;
    }
  }
  const source = new Element({ left: 240, top: 630, width: sourceVisible ? 56 : 0, height: 56 });
  source.style.setProperty('opacity', '0.8', 'important');
  const target = new Element({ left: 150, top: 180, width: 320, height: 320 });
  const page = new Element();
  page.dataset.lyricTransition = cover ? 'cover' : 'panel';
  const host = new Element();
  host.querySelector = (selector) =>
    selector === '.lyric-page' ? page : ready && cover ? target : null;
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'document',
    'window',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    code,
  )(
    () => ({
      onScopeDispose: (callback) => {
        dispose = callback;
      },
    }),
    module,
    module.exports,
    {
      querySelector: () => source,
      createElement: () => new Element(),
      body: {
        append: (element) => {
          operations.push('flight-connected');
          flights.push(element);
        },
      },
    },
    {
      matchMedia: () => ({ matches: reduced }),
      setTimeout: (callback) => {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(_element, options) {
        this.options = options;
      }
      disconnect() {
        this.disconnected = true;
      }
    },
    (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    (id) => frames.delete(id),
    (element) => {
      operations.push('style-read');
      return {
        borderTopLeftRadius: element === source ? '10px' : '24px',
        backgroundColor: '#222',
        opacity: element.style.opacity || '1',
        transform: 'none',
        ...element.currentStyle,
      };
    },
  );
  return {
    transition: module.exports.useLyricPageTransition(),
    host,
    source,
    target,
    animations,
    flights,
    observers,
    operations,
    timers,
    dispose: () => dispose(),
    ready: () => {
      ready = true;
      observers
        .filter((observer) => !observer.disconnected)
        .forEach((observer) => observer.callback());
    },
    frame: async () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
      await tick();
    },
    finish: async () => {
      animations.forEach((animation) => animation.finish());
      await tick();
    },
  };
}

test('artwork lands at measured geometry and returns to the current player-bar position', async () => {
  const env = setup();
  let enters = 0,
    leaves = 0;
  env.transition.beforeEnter(env.host);
  env.transition.enter(env.host, () => enters++);
  await env.frame();
  assert.equal(env.flights.length, 1);
  assert.equal(env.host.dataset.motion, 'cover');
  assert.equal(env.animations[0].frames[0].transform, 'translate(90px, 450px) scale(0.175, 0.175)');
  assert.equal(env.source.style.opacity, '0');
  await env.finish();
  assert.equal(enters, 1);
  assert.equal(env.source.style.opacity, '0.8');
  assert.equal(env.source.style.getPropertyPriority('opacity'), 'important');
  assert.equal(env.target.style.opacity, undefined);
  assert.equal(env.flights[0].removed, true);
  env.source.bounds.left = 24;
  env.transition.leave(env.host, () => leaves++);
  assert.equal(
    env.animations.filter((animation) => env.flights.includes(animation.element))[1].frames[1]
      .transform,
    'translate(-126px, 450px) scale(0.175, 0.175)',
  );
  await env.finish();
  assert.equal(leaves, 1);
  assert.equal(env.flights[1].removed, true);
});

test('coverless skins and a missing player-bar anchor use the panel transition', async () => {
  for (const options of [{ cover: false }, { sourceVisible: false }]) {
    const env = setup(options);
    env.transition.enter(env.host, () => {});
    await env.frame();
    assert.equal(env.host.dataset.motion, 'panel');
    assert.equal(env.flights.length, 0);
    assert.equal(env.animations[0].frames[0].transform, 'translateY(100%)');
    await env.finish();
  }
});

test('async cover geometry is awaited and closing before readiness cannot create an orphan flight', async () => {
  const env = setup({ ready: false });
  let enters = 0;
  env.transition.enter(env.host, () => enters++);
  await env.frame();
  assert.equal(env.animations.length, 0);
  env.transition.cancel(env.host);
  env.ready();
  await env.frame();
  assert.equal(env.animations.length, 0);
  assert.equal(env.flights.length, 0);
  assert.equal(enters, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.observers[0].disconnected, true);
});

test('an asynchronously mounted cover still uses the artwork transition', async () => {
  const env = setup({ ready: false });
  env.transition.enter(env.host, () => {});
  env.ready();
  await env.frame();
  assert.equal(env.host.dataset.motion, 'cover');
  await env.finish();
});

test('interrupted motion and disposal restore both covers and cancel all animations', async () => {
  const env = setup();
  let enters = 0,
    leaves = 0;
  env.transition.enter(env.host, () => enters++);
  await env.frame();
  const entryAnimations = [...env.animations];
  env.transition.cancel(env.host);
  env.transition.leave(env.host, () => leaves++);
  await tick();
  assert.equal(enters, 0);
  assert.ok(entryAnimations.every((animation) => animation.cancelled));
  assert.equal(env.flights[0].removed, true);
  env.dispose();
  await tick();
  assert.equal(leaves, 0);
  assert.equal(env.source.style.opacity, '0.8');
  assert.equal(env.target.style.opacity, undefined);
  assert.ok(env.flights.every((flight) => flight.removed));
});

test('reduced motion completes with no artwork clone or spatial animation', async () => {
  const env = setup({ reduced: true });
  let completes = 0;
  env.transition.enter(env.host, () => completes++);
  await env.frame();
  env.transition.leave(env.host, () => completes++);
  await tick();
  assert.equal(completes, 2);
  assert.equal(env.animations.length, 0);
  assert.equal(env.flights.length, 0);
  assert.equal(env.host.style.opacity, undefined);
});

test('closing mid-entry continues from the visible cover rather than jumping to full size', async () => {
  const env = setup();
  env.transition.enter(env.host, () => {});
  await env.frame();
  env.flights[0].bounds = { left: 170, top: 300, width: 180, height: 180 };
  env.flights[0].offsetWidth = 320;
  env.host.currentStyle = { opacity: '0.65' };
  env.transition.cancel(env.host);
  env.transition.leave(env.host, () => {});
  assert.equal(
    env.animations.filter((animation) => env.flights.includes(animation.element))[1].frames[0]
      .transform,
    'translate(20px, 120px) scale(0.5625, 0.5625)',
  );
  assert.equal(
    env.animations.filter((animation) => animation.element === env.host)[1].frames[0].opacity,
    '0.65',
  );
  await env.finish();
});

test('closing before the async page mounts finishes immediately without a blank slide', async () => {
  const env = setup();
  env.host.querySelector = () => null;
  env.transition.enter(env.host, () => assert.fail('cancelled entry completed'));
  env.transition.cancel(env.host);
  let closed = 0;
  env.transition.leave(env.host, () => closed++);
  await tick();
  assert.equal(closed, 1);
  assert.equal(env.animations.length, 0);
  assert.equal(env.timers.size, 0);
});

test('motion keyframes only animate compositor properties and rounded clips stay static', async () => {
  const env = setup();
  env.transition.enter(env.host, () => {});
  await env.frame();
  assert.equal(env.flights[0].children.length, 2);
  assert.equal(env.flights[0].children[0].style.borderRadius, '24px');
  assert.equal(env.flights[0].children[1].style.borderRadius, `${10 / 0.175}px / ${10 / 0.175}px`);
  for (const animation of env.animations) {
    for (const frame of animation.frames) {
      assert.ok(
        Object.keys(frame).every((key) => ['opacity', 'transform', 'offset'].includes(key)),
      );
    }
  }
  await env.finish();
});

test('ready pages do not allocate observers or timeout timers; async pages only watch mounting', async () => {
  const ready = setup();
  ready.transition.enter(ready.host, () => {});
  assert.equal(ready.observers.length, 0);
  assert.equal(ready.timers.size, 0);
  await ready.frame();
  await ready.finish();
  const asyncPage = setup({ ready: false });
  asyncPage.transition.enter(asyncPage.host, () => {});
  assert.deepEqual(asyncPage.observers[0].options, { childList: true, subtree: true });
  asyncPage.ready();
  assert.equal(asyncPage.observers[0].disconnected, true);
  await asyncPage.frame();
  await asyncPage.finish();
});

test('reversing preserves the rounded artwork handover at its current opacity', async () => {
  const env = setup();
  env.transition.enter(env.host, () => {});
  await env.frame();
  const clips = env.flights[0].children;
  clips[0].currentStyle = { opacity: '0.7' };
  clips[1].currentStyle = { opacity: '1' };
  env.transition.cancel(env.host);
  env.transition.leave(env.host, () => {});
  const newClips = env.flights[1].children;
  assert.equal(
    env.animations.find((animation) => animation.element === newClips[0]).frames[0].opacity,
    '0.7',
  );
  assert.equal(
    env.animations.find((animation) => animation.element === newClips[1]).frames[0].opacity,
    '1',
  );
  await env.finish();
});

test('normal entry batches all geometry and computed-style reads before connecting the artwork', async () => {
  const env = setup();
  env.transition.enter(env.host, () => {});
  await env.frame();
  const connected = env.operations.indexOf('flight-connected');
  assert.ok(connected > 0);
  assert.deepEqual(env.operations.slice(connected + 1), []);
  await env.finish();
});
