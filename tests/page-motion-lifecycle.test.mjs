import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const require = createRequire(import.meta.url);
const { effectScope, nextTick, ref } = require('vue');
const module = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/composables/usePageEntryMotion.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
  }).outputFiles[0].text,
)(require, module, module.exports);
const { usePageEntryMotion } = module.exports;
const settle = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};
function animation(options = {}) {
  let resolve, reject;
  const finished = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return {
    animationName: 'plugin-entry',
    playState: 'running',
    playbackRate: 1,
    effect: { getComputedTiming: () => ({ endTime: 220 }) },
    finished,
    resolve,
    reject,
    ...options,
  };
}
function fixture() {
  const scope = effectScope();
  const enabled = ref(true),
    reducedMotion = ref(false),
    name = ref('page');
  const api = scope.run(() => usePageEntryMotion({ enabled, reducedMotion, name }));
  let animations = [],
    queries = [];
  api.host.value = {
    getAnimations(...args) {
      queries.push(args);
      return animations;
    },
  };
  return {
    ...api,
    enabled,
    reducedMotion,
    name,
    queries,
    setAnimations(value) {
      animations = value;
    },
    dispose: () => scope.stop(),
  };
}

test('system reduced motion cancels queued and active entry without animationend', async () => {
  const f = fixture();
  try {
    const a = animation();
    f.setAnimations([a]);
    f.replay();
    f.reducedMotion.value = true;
    await settle();
    assert.equal(f.entering.value, false);
    assert.equal(f.queries.length, 0);
    f.reducedMotion.value = false;
    f.replay();
    await settle();
    assert.equal(f.entering.value, true);
    f.reducedMotion.value = true;
    assert.equal(f.entering.value, false);
    a.reject(new Error('animation cancelled'));
    await settle();
    f.reducedMotion.value = false;
    await settle();
    assert.equal(f.entering.value, false); // Do not replay a visible page.
  } finally {
    f.dispose();
  }
});

test('plugin disabling before DOM update suppresses entry', async () => {
  const f = fixture();
  try {
    f.replay();
    f.enabled.value = false;
    await settle();
    assert.equal(f.entering.value, false);
    assert.equal(f.queries.length, 0);
  } finally {
    f.dispose();
  }
});

test('custom animation names complete and clear the entry class', async () => {
  const f = fixture();
  try {
    f.name.value = 'custom';
    const a = animation();
    f.setAnimations([a]);
    f.replay();
    await settle();
    assert.equal(f.className.value, 'custom-route-enter-active');
    assert.equal(f.entering.value, true);
    a.resolve();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('all parallel entry animations finish before cleanup', async () => {
  const f = fixture();
  try {
    const short = animation(),
      long = animation({ animationName: 'long-entry' });
    f.setAnimations([short, long]);
    f.replay();
    await settle();
    short.resolve();
    await settle();
    assert.equal(f.entering.value, true);
    long.resolve();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('cancellation is handled without an unhandled rejection or stuck class', async () => {
  const f = fixture();
  try {
    const a = animation();
    f.setAnimations([a]);
    f.replay();
    await settle();
    a.reject(new Error('CSS removed'));
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('missing plugin CSS or zero running animations clean up immediately', async () => {
  const f = fixture();
  try {
    f.name.value = 'missing';
    f.replay();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('unrelated transitions and non-terminating animations do not block entry', async () => {
  const f = fixture();
  try {
    const transition = animation();
    delete transition.animationName;
    f.setAnimations([
      transition,
      animation({ playState: 'paused' }),
      animation({ playbackRate: 0 }),
      animation({ effect: { getComputedTiming: () => ({ endTime: Infinity }) } }),
    ]);
    f.replay();
    await settle();
    assert.equal(f.entering.value, false);
    assert.ok(
      f.queries.every((args) => args.length === 0),
      'never request subtree animations',
    );
  } finally {
    f.dispose();
  }
});

test('rapid navigation coalesces pending starts and old completion cannot stop a new entry', async () => {
  const f = fixture();
  try {
    const old = animation(),
      current = animation();
    f.setAnimations([old]);
    f.replay();
    f.replay();
    f.replay();
    await settle();
    assert.equal(f.queries.length, 2); // One restart style flush and one observation.
    f.setAnimations([current]);
    f.replay();
    await settle();
    old.reject(new Error('superseded'));
    await settle();
    assert.equal(f.entering.value, true);
    current.resolve();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('changing plugin name clears old entry without restarting visible content', async () => {
  const f = fixture();
  try {
    const a = animation();
    f.setAnimations([a]);
    f.replay();
    await settle();
    f.name.value = 'replacement';
    assert.equal(f.entering.value, false);
    a.resolve();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});

test('scope disposal invalidates pending DOM work and active completions', async () => {
  const queued = fixture();
  queued.replay();
  queued.dispose();
  await settle();
  assert.equal(queued.queries.length, 0);
  const f = fixture(),
    a = animation();
  f.setAnimations([a]);
  f.replay();
  await settle();
  f.dispose();
  a.resolve();
  await settle();
  assert.equal(f.entering.value, false);
  f.replay();
  await settle();
  assert.equal(f.entering.value, false);
});

test('a missing host is harmless and a subsequent mounted host can enter', async () => {
  const f = fixture();
  try {
    const host = f.host.value;
    f.host.value = null;
    f.replay();
    await settle();
    assert.equal(f.entering.value, false);
    f.host.value = host;
    const a = animation();
    f.setAnimations([a]);
    f.replay();
    await settle();
    assert.equal(f.entering.value, true);
    a.resolve();
    await settle();
    assert.equal(f.entering.value, false);
  } finally {
    f.dispose();
  }
});
