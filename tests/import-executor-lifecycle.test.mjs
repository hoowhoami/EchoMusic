import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';

const root = new URL('../', import.meta.url);
const load = (path, deps = {}, runtime = {}, override) => {
  const source = readFileSync(override || new URL(path, root), 'utf8');
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    ...Object.keys(runtime),
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )(
    (id) => {
      assert.ok(id in deps, `unexpected dependency: ${id}`);
      return deps[id];
    },
    module,
    module.exports,
    ...Object.values(runtime),
  );
  return module.exports;
};
const object = load('src/shared/object.ts');
const flush = () => new Promise(setImmediate);
const task = (extra = {}) => ({
  id: 7,
  status: 3,
  listid: 9,
  songs_num: 2,
  imported_num: 2,
  missed_num: 0,
  ...extra,
});
const body = (data, extra = {}) => ({ status: 1, data, ...extra });
const missedPage = (length, label = 'missed') =>
  Array.from({ length }, (_, i) => ({
    audio_name: `${label}-${i}`,
    author_name: 'Artist',
    reason: '未匹配',
  }));

function fixture(t, { autoTimers = true, actualMatching = false } = {}) {
  const calls = [],
    notices = [],
    progress = [],
    timers = new Map(),
    delays = [];
  let stopped = false,
    serial = 0;
  let statuses = async () => body([task()]);
  let result = async () => body({ listid: 9, missed: [] });
  let add = async () => ({ status: 1 });
  let search = async () => body({ lists: [] });
  let match = async (track) => ({
    song: { name: track.title, hash: `hash-${track.title}`, albumId: 1, mixSongId: track.title },
    score: 0.95,
    scoreDetails: { title: 1, artist: 1, duration: 1, titleExtraRatio: 0, total: 0.95 },
  });
  const deferreds = [];
  const defer = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    deferreds.push(resolve);
    return { promise, resolve, reject };
  };
  const setTimer = (fn, delay) => {
    const id = ++serial;
    delays.push(delay);
    timers.set(id, fn);
    if (autoTimers)
      queueMicrotask(() => {
        if (timers.delete(id)) fn();
      });
    return id;
  };
  const drain = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
  };
  t.after(async () => {
    stopped = true;
    deferreds.forEach((resolve) => resolve());
    for (let i = 0; i < 12; i++) {
      drain();
      await flush();
    }
  });
  const request = {
    post: async (url, data, config) => {
      calls.push({ url, data, config });
      if (data.operation === 'query_task_status') return statuses(data);
      if (data.operation === 'query_task') return result(data);
      assert.fail(`unexpected operation: ${data.operation}`);
    },
    get: async (url, config) => {
      calls.push({ url, config });
      if (url === '/playlist/tracks/add') return add(config.params);
      if (url === '/search') return search(config.params);
      assert.fail(`unexpected URL: ${url}`);
    },
  };
  const api = load('src/renderer/api/importPlaylist.ts', { '@/utils/request': request });
  const playlist = load('src/renderer/api/playlist.ts', { '@/utils/request': request });
  const searchApi = load('src/renderer/api/search.ts', { '@/utils/request': request });
  const logger = { warn: (...args) => notices.push(args) };
  const matching = load(
    'src/renderer/utils/songMatching.ts',
    {
      '@/api/search': searchApi,
      '@/utils/mappers': { mapSearchSong: (row) => row },
      '@/utils/logger': logger,
    },
    { setTimeout: setTimer },
  );
  const native = load(
    'src/renderer/utils/nativeImportPlaylist.ts',
    { '@/api/importPlaylist': api, '../../shared/object': object },
    { window: { setTimeout: setTimer } },
    process.env.ECHOMUSIC_NATIVE_IMPORT_TEST_SOURCE,
  );
  const local = load(
    'src/renderer/utils/importPlaylist.ts',
    {
      '@/api/playlist': playlist,
      '@/utils/logger': logger,
      '@/utils/songMatching': {
        ...matching,
        findBestMatch: actualMatching
          ? matching.findBestMatch
          : (track, options) => match(track, options),
        matchThinkDelay: () => new Promise((resolve) => setTimer(resolve, 250)),
      },
    },
    { setTimeout: setTimer },
    process.env.ECHOMUSIC_LOCAL_IMPORT_TEST_SOURCE,
  );
  const callbacks = {
    shouldStop: () => stopped,
    shouldAbort: () => stopped,
    onProgress: (...args) => progress.push(args),
  };
  return {
    ...native,
    ...local,
    callbacks,
    calls,
    progress,
    notices,
    timers,
    delays,
    defer,
    drain,
    stop: () => {
      stopped = true;
    },
    statuses: (fn) => {
      statuses = fn;
    },
    result: (fn) => {
      result = fn;
    },
    add: (fn) => {
      add = fn;
    },
    search: (fn) => {
      search = fn;
    },
    match: (fn) => {
      match = fn;
    },
    polls: () => calls.filter((c) => c.data?.operation === 'query_task_status'),
    pages: () => calls.filter((c) => c.data?.operation === 'query_task'),
    adds: () => calls.filter((c) => c.url === '/playlist/tracks/add'),
    searches: () => calls.filter((c) => c.url === '/search'),
  };
}
const tracks = (count) =>
  Array.from({ length: count }, (_, i) => ({ title: `Song${i}`, artist: 'Artist' }));
test('native import accepts string IDs, string counts and responses without status flags', async (t) => {
  const f = fixture(t);
  f.statuses(async () => ({
    data: task({ id: '7', status: '3', songs_num: '2', imported_num: '2', missed_num: '0' }),
  }));
  const result = await f.waitForNativeImport('7', f.callbacks);
  assert.equal(result.task.imported_num, '2');
  assert.deepEqual(result.missed, []);
});
for (const failure of [false, true]) {
  test(`stopping during native status ${failure ? 'failure' : 'success'} suppresses progress and follow-up`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    f.statuses(() => wait.promise);
    const pending = f.waitForNativeImport(7, f.callbacks);
    f.stop();
    if (failure) wait.reject(new Error('old query'));
    else wait.resolve(body(task({ missed_num: 200 })));
    assert.equal(await pending, null);
    assert.equal(f.progress.length, 0);
    assert.equal(f.pages().length, 0);
  });
}
for (const status of [0, 3, 10, 11]) {
  test(`stopping in progress callback prevents continuation at native status ${status}`, async (t) => {
    const f = fixture(t);
    f.statuses(async () => body(task({ status, songs_num: 0, missed_num: 100 })));
    const result = await f.waitForNativeImport(7, { ...f.callbacks, onProgress: () => f.stop() });
    assert.equal(result, null);
    assert.equal(f.pages().length, 0);
    assert.equal(f.delays.length, 0);
  });
}
for (const fail of [false, true]) {
  test(`stopping during missed-page ${fail ? 'failure' : 'success'} prevents next page`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    f.statuses(async () => body(task({ missed_num: 201 })));
    f.result(() => wait.promise);
    const pending = f.waitForNativeImport(7, f.callbacks);
    await flush();
    assert.equal(f.pages().length, 1);
    f.stop();
    if (fail) wait.reject(new Error('old missed query'));
    else wait.resolve(body({ listid: 9, missed: missedPage(100) }));
    assert.equal(await pending, null);
    assert.equal(f.pages().length, 1);
  });
}
test('a failed missed page is not reported as successful completion', async (t) => {
  const f = fixture(t);
  f.statuses(async () => body(task({ missed_num: 201 })));
  f.result(async ({ page }) =>
    page === 1 ? body({ missed: missedPage(100) }) : Promise.reject(new Error('请求失败')),
  );
  await assert.rejects(f.waitForNativeImport(7, f.callbacks), /失败/);
  assert.equal(f.pages().length, 2);
});
test('completed task retrieves missed pages in source order and uses actual API fields', async (t) => {
  const f = fixture(t);
  f.statuses(async () => body(task({ missed_num: 201 })));
  f.result(async ({ page }) =>
    body({ listid: '9', missed: missedPage(page === 3 ? 1 : 100, `page${page}`) }),
  );
  const result = await f.waitForNativeImport(7, f.callbacks);
  assert.equal(result.missed.length, 201);
  assert.equal(result.missed[100].audio_name, 'page2-0');
  assert.deepEqual(
    f.pages().map((v) => v.data),
    [1, 2, 3].map((page) => ({
      operation: 'query_task',
      listid: 9,
      page,
      pagesize: 100,
      show_missed: 1,
    })),
  );
});
test('a short missed page ends pagination', async (t) => {
  const f = fixture(t);
  f.statuses(async () => body(task({ missed_num: 1000 })));
  f.result(async () => body({ missed: missedPage(3) }));
  assert.equal((await f.waitForNativeImport(7, f.callbacks)).missed.length, 3);
  assert.equal(f.pages().length, 1);
});
for (const interval of [undefined, NaN, Infinity, -100]) {
  test(`native polling normalizes interval ${String(interval)} and stops during sleep`, async (t) => {
    const f = fixture(t, { autoTimers: false });
    f.statuses(async () => body(task({ status: 1 })));
    const pending = f.waitForNativeImport(7, { ...f.callbacks, intervalMs: interval });
    await flush();
    assert.equal(f.delays[0], interval === -100 ? 500 : 1500);
    f.stop();
    f.drain();
    assert.equal(await pending, null);
    assert.equal(f.polls().length, 1);
  });
}
test('native import continues polling until completion', async (t) => {
  const f = fixture(t);
  let polls = 0;
  f.statuses(async () => body(task({ status: ++polls === 3 ? 3 : 1 })));
  assert.equal((await f.waitForNativeImport(7, f.callbacks)).task.status, 3);
  assert.equal(f.polls().length, 3);
  assert.deepEqual(f.delays, [1500, 1500]);
});
for (const [status, type, songs, unsupported] of [
  [10, 0, 0, true],
  [10, 1, 0, false],
  [10, 0, 2, false],
  [11, 0, 0, false],
]) {
  test(`native failure preserves fallback contract ${status}/${type}/${songs}`, async (t) => {
    const f = fixture(t);
    f.statuses(async () =>
      body(task({ status, task_type: type, songs_num: songs, msg: 'upstream message' })),
    );
    await assert.rejects(f.waitForNativeImport(7, f.callbacks), (error) =>
      unsupported
        ? error instanceof f.NativeImportUnsupportedError
        : error.message === 'upstream message' &&
          !(error instanceof f.NativeImportUnsupportedError),
    );
  });
}
for (const kind of ['native', 'local']) {
  test(`already-stopped ${kind} executor sends no requests or progress`, async (t) => {
    const f = fixture(t);
    f.stop();
    if (kind === 'native') assert.equal(await f.waitForNativeImport(7, f.callbacks), null);
    else
      assert.deepEqual(await f.runImport(tracks(2), 9, f.callbacks), {
        total: 2,
        success: 0,
        low: 0,
        skipped: 0,
        failed: 0,
      });
    assert.equal(f.calls.length, 0);
    assert.equal(f.progress.length, 0);
  });
}
for (const stage of ['success', 'failure', 'delay']) {
  test(`local executor cancels actual keyword search after ${stage}`, async (t) => {
    const f = fixture(t, { autoTimers: false, actualMatching: true }),
      wait = f.defer();
    f.search(stage === 'delay' ? async () => body({ lists: [] }) : () => wait.promise);
    const pending = f.runImport(tracks(2), 9, f.callbacks);
    await flush();
    f.stop();
    if (stage === 'failure') wait.reject(new Error('old search'));
    else wait.resolve(body({ lists: [] }));
    for (let i = 0; i < 12; i++) {
      f.drain();
      await flush();
    }
    assert.equal((await pending).success, 0);
    assert.equal(f.searches().length, 1);
    assert.equal(f.adds().length, 0);
    assert.equal(f.progress.length, 1);
    assert.equal(f.notices.length, 0);
  });
}
for (const fail of [false, true]) {
  test(`local executor suppresses late match ${fail ? 'failure' : 'success'} progress`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    f.match(() => wait.promise);
    const pending = f.runImport(tracks(2), 9, f.callbacks);
    await flush();
    f.stop();
    if (fail) wait.reject(new Error('old match'));
    else wait.resolve(null);
    await pending;
    assert.equal(f.progress.length, 1);
    assert.equal(f.notices.length, 0);
    assert.equal(f.adds().length, 0);
  });
}
for (const response of [{ status: 1 }, { status: 0 }]) {
  test(`local executor stops progress and batches after in-flight add status ${response.status}`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    f.add(() => wait.promise);
    const pending = f.runImport(tracks(3), 9, { ...f.callbacks, addBatchSize: 1 });
    await flush();
    const count = f.progress.length,
      delays = f.delays.length;
    f.stop();
    wait.resolve(response);
    const result = await pending;
    assert.equal(f.progress.length, count);
    assert.equal(f.adds().length, 1);
    assert.equal(f.delays.length, delays);
    assert.equal(response.status === 1 ? result.success : result.failed, 1);
  });
}
test('stopping from phase-two progress prevents all further work', async (t) => {
  const f = fixture(t);
  const pending = f.runImport(tracks(3), 9, {
    ...f.callbacks,
    onProgress: (...args) => {
      f.progress.push(args);
      if (args[2].status === 'adding') f.stop();
    },
  });
  await pending;
  assert.equal(f.progress.filter((v) => v[2].status === 'adding').length, 1);
  assert.equal(f.adds().length, 0);
});
test('local import preserves reverse submission order and per-chunk delay', async (t) => {
  const f = fixture(t);
  const result = await f.runImport(tracks(5), '9', { ...f.callbacks, addBatchSize: 2 });
  assert.deepEqual(result, { total: 5, success: 5, low: 0, skipped: 0, failed: 0 });
  assert.deepEqual(
    f.adds().map((v) => v.config.params.data.split(',').map((v) => v.split('|')[0])),
    [['Song4', 'Song3'], ['Song2', 'Song1'], ['Song0']],
  );
  assert.ok(f.adds().every((v) => v.config.params.listid === '9'));
  assert.equal(f.delays.filter((v) => v === 400).length, 2);
  assert.deepEqual(f.progress.at(-1).slice(0, 2), [5, 5]);
});
for (const size of [NaN, Infinity, 0, 2.5, 100]) {
  test(`local import enforces integer batch limit for ${String(size)}`, async (t) => {
    const f = fixture(t);
    await f.runImport(tracks(52), 9, { ...f.callbacks, addBatchSize: size });
    const limit = size === 0 ? 1 : size === 2.5 ? 2 : 50;
    assert.ok(f.adds().every((v) => v.config.params.data.split(',').length <= limit));
    assert.equal(f.adds().length, Math.ceil(52 / limit));
  });
}
test('URL size splitting counts the encoded comma and preserves every item', async (t) => {
  const f = fixture(t);
  f.match(async (track) => ({
    song: {
      name: '中'.repeat(219) + 'x'.repeat(12),
      hash: 'h',
      albumId: 1,
      mixSongId: track.title,
    },
    score: 0.95,
    scoreDetails: { title: 1, artist: 1, titleExtraRatio: 0 },
  }));
  await f.runImport(tracks(4), 9, f.callbacks);
  assert.ok(f.adds().every((v) => encodeURIComponent(v.config.params.data).length <= 4000));
  assert.equal(
    f.adds().reduce((sum, v) => sum + v.config.params.data.split(',').length, 0),
    4,
  );
});
test('local import counts accepted, low confidence, skipped and failed items without losing order', async (t) => {
  const f = fixture(t);
  f.match(async (track) =>
    track.title === 'Song0'
      ? null
      : {
          song: { name: track.title, hash: 'h', mixSongId: track.title },
          score: track.title === 'Song1' ? 0.6 : 0.95,
          scoreDetails: { title: 1, artist: 1, titleExtraRatio: 0 },
        },
  );
  f.add(async ({ data }) => (data.includes('Song3') ? { status: 0 } : { status: 1 }));
  const result = await f.runImport(tracks(4), 9, { ...f.callbacks, addBatchSize: 1 });
  assert.deepEqual(result, { total: 4, success: 2, low: 1, skipped: 1, failed: 1 });
  assert.equal(f.progress.findLast((v) => v[2].external.title === 'Song1')[2].status, 'low');
});
test('an active add failure preserves its error and allows later batches', async (t) => {
  const f = fixture(t);
  f.add(async ({ data }) => {
    if (data.includes('Song1')) throw new Error('quota exceeded');
    return { status: 1 };
  });
  const result = await f.runImport(tracks(2), 9, { ...f.callbacks, addBatchSize: 1 });
  assert.equal(result.failed, 1);
  assert.equal(result.success, 1);
  assert.equal(f.progress.find((v) => v[2].status === 'failed')[2].error, 'quota exceeded');
});
test('an empty local import performs no work', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.runImport([], 9, f.callbacks), {
    total: 0,
    success: 0,
    low: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(f.calls.length, 0);
});

function storeFixture(t) {
  const timers = new Map();
  let serial = 0;
  const logger = { info() {}, error() {} };
  const panel = load(
    'src/renderer/plugins/taskPanel.ts',
    { vue, '@/utils/logger': logger },
    {
      setTimeout: (fn) => {
        timers.set(++serial, fn);
        return serial;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const control = load('src/renderer/tasks/taskControl.ts');
  const module = load(
    'src/renderer/stores/importTask.ts',
    {
      pinia,
      vue,
      '@/utils/logger': logger,
      '@/icons': { iconPlaylistAdd: {} },
      '@/plugins/taskPanel': panel,
      '@/tasks/taskControl': control,
    },
    {},
    process.env.ECHOMUSIC_IMPORT_TASK_TEST_SOURCE,
  );
  const store = module.useImportTaskStore(pinia.createPinia());
  t.after(() => {
    store.dismiss();
    timers.clear();
  });
  return { store, panel };
}
test('actual Pinia progress replaces the existing raw-track row through every stage', (t) => {
  const { store } = storeFixture(t);
  const run = store.start('Import', () => {});
  const external = tracks(1)[0];
  for (const status of ['pending', 'matching', 'adding', 'success']) {
    assert.equal(run.updateProgress(1, 1, { external, status }), true);
    assert.equal(store.items.length, 1);
    assert.equal(store.items[0].status, status);
  }
});
test('raw and reactive references to one external track update the same progress row', (t) => {
  const { store } = storeFixture(t);
  const run = store.start('Import', () => {});
  const external = tracks(1)[0];
  run.updateProgress(0, 1, { external: vue.reactive(external), status: 'matching' });
  run.updateProgress(1, 1, { external, status: 'success' });
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].status, 'success');
});
test('distinct occurrences of the same title retain separate rows and selection order', (t) => {
  const { store } = storeFixture(t);
  const run = store.start('Import', () => {});
  const first = { title: 'Same', artist: 'Artist' },
    second = { ...first };
  run.updateProgress(0, 2, { external: first, status: 'matching' });
  run.updateProgress(0, 2, { external: second, status: 'matching' });
  run.updateProgress(1, 2, { external: second, status: 'failed', error: 'not found' });
  run.updateProgress(2, 2, { external: first, status: 'success' });
  assert.equal(store.items.length, 2);
  assert.deepEqual(
    store.items.map((v) => v.status),
    ['success', 'failed'],
  );
  assert.equal(store.items[1].error, 'not found');
});
test('large actual Pinia progress retains exactly one row per source track', (t) => {
  const { store } = storeFixture(t);
  const run = store.start('Import', () => {});
  const external = tracks(1000);
  external.forEach((track) => run.updateProgress(0, 1000, { external: track, status: 'matching' }));
  external.forEach((track, i) =>
    run.updateProgress(i + 1, 1000, { external: track, status: 'success' }),
  );
  assert.equal(store.items.length, 1000);
  assert.ok(store.items.every((v) => v.status === 'success'));
  assert.equal(store.percent, 100);
});
test('replaced runs cannot update, complete or abort the new run', (t) => {
  const { store } = storeFixture(t);
  const old = store.start('old', () => {}),
    external = tracks(1)[0];
  old.updateProgress(1, 1, { external, status: 'success' });
  const next = store.start('new', () => {});
  next.updateProgress(0, 1, { external, status: 'matching' });
  assert.equal(old.updateProgress(1, 1, { external, status: 'failed' }), false);
  assert.equal(old.complete({ total: 1, success: 0, skipped: 0, failed: 1, low: 0 }), false);
  assert.equal(old.abort(), false);
  assert.equal(old.dismiss(), false);
  assert.equal(store.playlistName, 'new');
  assert.deepEqual(
    store.items.map((v) => v.status),
    ['matching'],
  );
});
test('completion retains the actual task result and prevents further updates', (t) => {
  const { store, panel } = storeFixture(t);
  const run = store.start('Import', () => {}),
    external = tracks(1)[0];
  run.updateProgress(1, 1, { external, status: 'success' });
  const summary = { total: 1, success: 1, low: 0, skipped: 0, failed: 0 };
  assert.equal(run.complete(summary), true);
  assert.equal(store.status, 'completed');
  assert.equal(panel.taskPanelState.entries['echo:import'].status, 'completed');
  assert.deepEqual({ ...store.summary }, summary);
  assert.equal(run.updateProgress(1, 1, { external, status: 'failed' }), false);
  assert.equal(store.items[0].status, 'success');
});
test('background and abort controls retain their actual task-panel behavior', (t) => {
  const { store, panel } = storeFixture(t);
  let aborts = 0;
  const run = store.start('Import', () => aborts++);
  assert.equal(
    run.enterBackground('Background', () => aborts++),
    true,
  );
  assert.equal(store.playlistName, 'Background');
  assert.equal(run.abort(), true);
  assert.equal(aborts, 1);
  assert.equal(store.status, 'aborted');
  assert.equal(run.signal.aborted, true);
  assert.equal(panel.taskPanelState.entries['echo:import'].status, 'aborted');
  assert.equal(run.updateProgress(0, 1, { external: tracks(1)[0], status: 'matching' }), false);
});
