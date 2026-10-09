import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as vue from 'vue';

const rendererModule = { exports: {} };
new Function(
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/views/lyric/fluidBackgroundRenderer.ts'],
    format: 'cjs',
    write: false,
  }).outputFiles[0].text,
)(rendererModule, rendererModule.exports);
const { FluidBackgroundRenderer, fluidRenderDimensions, FLUID_RENDER_SIZE } =
  rendererModule.exports;

function gpu() {
  const calls = [],
    live = new Set();
  let id = 0;
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (name.toUpperCase() === name) return name;
        if (name.startsWith('create'))
          return () => {
            const resource = { type: name, id: ++id };
            live.add(resource);
            calls.push([name, resource]);
            return resource;
          };
        if (name.startsWith('delete'))
          return (resource) => {
            live.delete(resource);
            calls.push([name]);
          };
        if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
        if (name === 'getAttribLocation') return () => 0;
        if (name === 'getUniformLocation') return () => ({});
        if (name === 'checkFramebufferStatus') return () => 'FRAMEBUFFER_COMPLETE';
        if (name === 'getExtension')
          return () => ({ loseContext: () => calls.push(['loseContext']) });
        return (...args) => calls.push([name, ...args]);
      },
    },
  );
  return { gl, calls, live };
}

test('render targets stay bounded at full HD, 4K and portrait sizes without a DPR multiplier', () => {
  for (const [w, h] of [
    [1920, 1080],
    [3840, 2160],
    [2160, 3840],
    [7680, 4320],
    [1, 1],
  ]) {
    const size = fluidRenderDimensions(w, h);
    assert.ok(size.width > 0 && size.height > 0);
    assert.ok(Math.max(size.width, size.height) <= FLUID_RENDER_SIZE);
    assert.ok(Math.abs(size.width / size.height - w / h) < 0.02);
  }
});

test('steady animation allocates no textures, uploads, buffers or shader programs, and disposal releases each resource', (t) => {
  const g = gpu();
  const canvas = { width: 1, height: 1, getContext: () => g.gl };
  const renderer = new FluidBackgroundRenderer(canvas);
  const saved = globalThis.document;
  const atlases = [];
  globalThis.document = {
    createElement() {
      const atlas = {
        width: 0,
        height: 0,
        getContext: () => ({
          save() {},
          beginPath() {},
          rect() {},
          clip() {},
          drawImage() {},
          restore() {},
        }),
      };
      atlases.push(atlas);
      return atlas;
    },
  };
  t.after(() => {
    globalThis.document = saved;
  });
  renderer.resize(3840, 2160);
  renderer.setCover({ naturalWidth: 400, naturalHeight: 400 }, 'cover-a');
  assert.equal(g.calls.filter(([name]) => name === 'createTexture').length, 4);
  const before = g.calls.length;
  for (let i = 0; i < 300; i++) renderer.draw(i / 30);
  const animation = g.calls.slice(before);
  assert.equal(animation.filter(([name]) => name === 'drawArrays').length, 900);
  assert.ok(
    animation.every(
      ([name]) => !name.startsWith('create') && name !== 'texImage2D' && name !== 'bufferData',
    ),
  );
  renderer.setCover({ naturalWidth: 400, naturalHeight: 400 }, 'cover-b');
  assert.equal(
    g.calls.filter(([name]) => name === 'createTexture').length,
    4,
    'switches reuse texture objects',
  );
  assert.ok(atlases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  const allocated = g.calls.length;
  renderer.resize(3840, 2160);
  assert.equal(g.calls.length, allocated, 'unchanged layout does not allocate or rebuild noise');
  renderer.dispose();
  assert.equal(g.live.size, 0);
  assert.equal(canvas.width, 1);
  const disposed = g.calls.length;
  renderer.dispose();
  renderer.draw(1);
  renderer.resize(800, 600);
  assert.equal(g.calls.length, disposed);
});

function lifecycle(t, { enabled = true, supported = true } = {}) {
  const timers = new Map(),
    frames = new Map(),
    listeners = new Map();
  const hooks = { mounted: [], unmounted: [], activated: [], deactivated: [] };
  const images = [],
    instances = [],
    events = [];
  let next = 1;
  const clock = {
    setTimeout(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(fn) {
      const id = next++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    task() {
      const jobs = [...timers.values()];
      timers.clear();
      jobs.forEach((fn) => fn());
    },
    frame(time) {
      const jobs = [...frames.values()];
      frames.clear();
      jobs.forEach((fn) => fn(time));
    },
  };
  const document = {
    hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const window = {
    ...clock,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  class Renderer {
    draws = [];
    resizes = [];
    uploads = [];
    disposed = false;
    constructor() {
      if (!supported) throw new Error('no WebGL');
      instances.push(this);
    }
    resize(...size) {
      this.resizes.push(size);
    }
    setCover(image, url) {
      this.uploads.push(url);
    }
    draw(time) {
      this.draws.push(time);
    }
    dispose() {
      this.disposed = true;
    }
  }
  class Image {
    onload = null;
    onerror = null;
    src = '';
    constructor() {
      images.push(this);
    }
  }
  const descriptor = parse(
    readFileSync('src/renderer/views/lyric/LyricFluidBackground.vue', 'utf8'),
  ).descriptor;
  const script = compileScript(descriptor, { id: 'fluid-test' });
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'document',
    'Image',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    transformSync(script.content, { loader: 'ts', format: 'cjs' }).code,
  )(
    (name) =>
      name === 'vue'
        ? {
            ...vue,
            onMounted: (fn) => hooks.mounted.push(fn),
            onUnmounted: (fn) => hooks.unmounted.push(fn),
            onActivated: (fn) => hooks.activated.push(fn),
            onDeactivated: (fn) => hooks.deactivated.push(fn),
          }
        : { FluidBackgroundRenderer: Renderer },
    module,
    module.exports,
    window,
    document,
    Image,
    clock.requestAnimationFrame,
    clock.cancelAnimationFrame,
  );
  const props = vue.reactive({ enabled, coverUrl: 'a' });
  const scope = vue.effectScope();
  const api = scope.run(() =>
    module.exports.default.setup(props, { expose() {}, emit: (...event) => events.push(event) }),
  );
  api.canvas.value = {};
  hooks.mounted.forEach((fn) => fn());
  t.after(() => {
    hooks.unmounted.forEach((fn) => fn());
    scope.stop();
    assert.equal(frames.size + timers.size + listeners.size, 0);
  });
  const load = () => {
    clock.task();
    images.at(-1).onload();
    clock.frame(0);
  };
  const hide = (value) => {
    document.hidden = value;
    listeners.get('visibilitychange')();
  };
  return {
    api,
    props,
    clock,
    images,
    instances,
    events,
    frames,
    timers,
    listeners,
    window,
    load,
    hide,
    hooks,
  };
}

test('initial activation loads a cover once, releases the image after upload and caps high-refresh draws at 30 fps', (t) => {
  const f = lifecycle(t);
  f.hooks.activated.forEach((fn) => fn());
  f.load();
  assert.equal(f.images.length, 1);
  assert.equal(f.images[0].src, '');
  assert.equal(f.images[0].onload, null);
  assert.deepEqual(f.instances[0].uploads, ['a']);
  for (let i = 1; i <= 144; i++) f.clock.frame((i * 1000) / 144);
  assert.ok(f.instances[0].draws.length <= 31);
  assert.deepEqual(f.events, [['ready', true]]);
});

test('rapid cover changes immediately cancel stale image callbacks and coalesce to the latest cover', async (t) => {
  const f = lifecycle(t);
  f.clock.task();
  const old = f.images[0],
    staleLoad = old.onload;
  f.props.coverUrl = 'b';
  await vue.nextTick();
  assert.equal(old.src, '');
  assert.equal(old.onload, null);
  f.props.coverUrl = 'c';
  await vue.nextTick();
  staleLoad();
  assert.deepEqual(f.instances[0].uploads, []);
  f.load();
  assert.deepEqual(f.instances[0].uploads, ['c']);
  assert.equal(f.images.length, 2);
});

test('hidden and deactivated pages stop all work and resume the existing texture without reloading', (t) => {
  const f = lifecycle(t);
  f.load();
  f.hide(true);
  assert.equal(f.frames.size + f.timers.size, 0);
  f.clock.frame(100000);
  assert.equal(f.instances[0].draws.length, 1);
  f.hide(false);
  f.clock.frame(100000);
  assert.equal(f.instances[0].draws.at(-1), 0, 'hidden time does not jump the animation');
  assert.equal(f.images.length, 1);
  f.hooks.deactivated.forEach((fn) => fn());
  assert.equal(f.frames.size + f.timers.size, 0);
  f.hooks.activated.forEach((fn) => fn());
  f.clock.frame(200000);
  assert.equal(f.images.length, 1);
});

test('turning the feature off cancels pending decode and frees the render resources immediately', async (t) => {
  const f = lifecycle(t);
  f.clock.task();
  const old = f.images[0],
    stale = old.onload;
  f.props.enabled = false;
  await vue.nextTick();
  assert.equal(f.instances[0].disposed, true);
  assert.equal(f.frames.size + f.timers.size, 0);
  assert.equal(old.src, '');
  assert.equal(old.onload, null);
  stale();
  assert.deepEqual(f.instances[0].uploads, []);
});

test('context loss shows the static fallback and restoration rebuilds once for the latest cover', async (t) => {
  const f = lifecycle(t);
  f.load();
  let prevented = false;
  const event = {
    currentTarget: f.api.canvas.value,
    preventDefault() {
      prevented = true;
    },
  };
  f.api.handleContextLost(event);
  assert.equal(prevented, true);
  assert.equal(f.frames.size + f.timers.size, 0);
  assert.deepEqual(f.events.at(-1), ['ready', false]);
  f.props.coverUrl = 'b';
  await vue.nextTick();
  assert.equal(f.instances.length, 1, 'lost context cannot be used while awaiting restoration');
  f.api.handleContextRestored(event);
  f.load();
  assert.equal(f.instances.length, 2);
  assert.deepEqual(f.instances[1].uploads, ['b']);
  assert.deepEqual(f.events.at(-1), ['ready', true]);
});

test('unsupported WebGL or cover failure leave the static backdrop available without an idle animation loop', (t) => {
  const unsupported = lifecycle(t, { supported: false });
  assert.equal(unsupported.frames.size + unsupported.timers.size, 0);
  assert.equal(unsupported.api.ready.value, false);
  const failed = lifecycle(t);
  failed.clock.task();
  failed.images[0].onerror();
  assert.equal(failed.frames.size + failed.timers.size, 0);
  assert.equal(failed.api.ready.value, false);
  assert.equal(failed.instances[0].disposed, true);
});

test('resize bursts are coalesced into one background draw using the latest viewport', (t) => {
  const f = lifecycle(t);
  f.load();
  const count = f.instances[0].resizes.length;
  for (let width = 1200; width <= 1280; width++) {
    f.window.innerWidth = width;
    f.listeners.get('resize')();
  }
  assert.equal(f.instances[0].resizes.length, count);
  f.clock.frame(40);
  assert.equal(f.instances[0].resizes.length, count + 1);
  assert.deepEqual(f.instances[0].resizes.at(-1), [1430, 1230]);
});

test('unmount during cover decoding cancels the image and removes the global listeners', (t) => {
  const f = lifecycle(t);
  f.clock.task();
  const old = f.images[0],
    stale = old.onload;
  f.hooks.unmounted.forEach((fn) => fn());
  stale();
  assert.equal(old.src, '');
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
  assert.equal(f.instances[0].disposed, true);
  assert.deepEqual(f.instances[0].uploads, []);
});
