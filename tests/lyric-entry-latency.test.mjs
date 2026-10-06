import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';

function loaders() {
  const calls = [],
    failures = new Set();
  const source = readFileSync('src/renderer/views/lyric/loaders.ts', 'utf8').replace(
    /import\('\.\/(LyricPage|AmllMode)\.vue'\)/g,
    "loadModule('$1')",
  );
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'loadModule', code)(module, module.exports, async (name) => {
    calls.push(name);
    if (failures.delete(name)) throw new Error('temporary load failure');
    return { default: name };
  });
  return { ...module.exports, calls, failures };
}

test('preload and both async components share imports, including concurrent calls', async () => {
  const api = loaders();
  await Promise.all([
    api.preloadLyricPage('host:amll', 'cover'),
    api.loadLyricPage(),
    api.loadAmllMode(),
    api.preloadLyricPage('host:amll', 'amll'),
  ]);
  assert.deepEqual(api.calls, ['LyricPage', 'AmllMode']);
});

test('AMLL only preloads for the selected skin, including the legacy host setting', async () => {
  for (const [provider, mode] of [
    ['host:cover', 'amll'],
    ['plugin:custom', 'amll'],
    ['host', 'cover'],
  ]) {
    const api = loaders();
    await api.preloadLyricPage(provider, mode);
    assert.deepEqual(api.calls, ['LyricPage']);
  }
  const api = loaders();
  await api.preloadLyricPage('host', 'amll');
  assert.deepEqual(api.calls, ['LyricPage', 'AmllMode']);
});

test('failed speculative imports can retry without refetching the successful module', async () => {
  const api = loaders();
  api.failures.add('AmllMode');
  await assert.rejects(api.preloadLyricPage('host:amll', 'amll'));
  await api.preloadLyricPage('host:amll', 'amll');
  assert.deepEqual(api.calls, ['LyricPage', 'AmllMode', 'AmllMode']);
});

function queue() {
  let next = 1;
  const frames = new Map(),
    timers = new Map();
  const add = (map, callback) => {
    const id = next++;
    map.set(id, callback);
    return id;
  };
  const flush = (map) => {
    const callbacks = [...map.values()];
    map.clear();
    callbacks.forEach((fn) => fn());
  };
  return {
    frames,
    timers,
    requestAnimationFrame: (fn) => add(frames, fn),
    cancelAnimationFrame: (id) => frames.delete(id),
    window: { setTimeout: (fn) => add(timers, fn), clearTimeout: (id) => timers.delete(id) },
    frame: () => flush(frames),
    task: () => flush(timers),
  };
}
function afterPaint(clock) {
  const module = { exports: {} };
  const code = buildSync({
    entryPoints: ['src/renderer/utils/afterPaint.ts'],
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  new Function(
    'module',
    'exports',
    'window',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    code,
  )(module, module.exports, clock.window, clock.requestAnimationFrame, clock.cancelAnimationFrame);
  return module.exports.afterPaint;
}

test('heavy lyric initialization runs once in a task after the first opening frame', () => {
  const clock = queue();
  let calls = 0;
  afterPaint(clock)(() => calls++);
  clock.frame();
  assert.equal(calls, 0);
  clock.frame();
  assert.equal(calls, 0);
  clock.task();
  assert.equal(calls, 1);
  clock.frame();
  clock.task();
  assert.equal(calls, 1);
});

test('closing before initialization cancels it in either frame and in the queued task', () => {
  for (const phase of [0, 1, 2]) {
    const clock = queue();
    let calls = 0;
    const cancel = afterPaint(clock)(() => calls++);
    for (let i = 0; i < phase; i++) clock.frame();
    cancel();
    clock.frame();
    clock.frame();
    clock.task();
    assert.equal(calls, 0);
    assert.equal(clock.frames.size + clock.timers.size, 0);
  }
});

function warmup({ idle = true } = {}) {
  const clock = queue(),
    idles = new Map(),
    calls = [];
  let mount,
    dispose,
    changed,
    provider = 'host:cover';
  if (idle)
    Object.assign(clock.window, {
      requestIdleCallback: (fn) => {
        idles.set(1, fn);
        return 1;
      },
      cancelIdleCallback: (id) => idles.delete(id),
    });
  const code = buildSync({
    entryPoints: ['src/renderer/composables/useLyricPagePreload.ts'],
    bundle: true,
    external: ['vue', '@/views/lyric/loaders'],
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) =>
      name === 'vue'
        ? {
            onMounted: (fn) => {
              mount = fn;
            },
            onScopeDispose: (fn) => {
              dispose = fn;
            },
            watch: (_, fn) => {
              changed = fn;
            },
          }
        : {
            preloadLyricPage: (...args) => {
              calls.push(args);
              return Promise.resolve();
            },
          },
    module,
    module.exports,
    clock.window,
  );
  const preload = module.exports.useLyricPagePreload(
    () => provider,
    () => 'amll',
  );
  return {
    clock,
    idles,
    calls,
    preload,
    mount: () => mount(),
    dispose: () => dispose(),
    change: () => {
      provider = 'host:amll';
      changed();
    },
  };
}

test('idle warmup uses latest selected skin and pointer intent cancels the scheduled duplicate', () => {
  const api = warmup();
  assert.equal(api.idles.size, 0);
  api.mount();
  api.change();
  assert.equal(api.idles.size, 1);
  api.preload();
  assert.deepEqual(api.calls, [['host:amll', 'amll']]);
  assert.equal(api.idles.size, 0);
});

test('unmount cancels idle warmup or the timer fallback', () => {
  for (const idle of [true, false]) {
    const api = warmup({ idle });
    api.mount();
    assert.equal(api.idles.size + api.clock.timers.size, 1);
    api.dispose();
    api.clock.task();
    assert.equal(api.idles.size + api.clock.timers.size, 0);
    assert.equal(api.calls.length, 0);
  }
});
