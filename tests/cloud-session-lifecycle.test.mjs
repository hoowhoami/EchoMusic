import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import { useVModel } from '@vueuse/core';
const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, dependencies) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(read(path), { loader: 'ts', format: 'cjs' }).code,
  )(
    (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const object = load('../src/shared/object.ts', {});
const session = load('../src/renderer/utils/userSession.ts', {});
const extractors = load('../src/renderer/utils/extractors.ts', { '../../shared/object': object });
const control = load('../src/renderer/tasks/taskControl.ts', {});
const scripts = Object.fromEntries(
  [
    ['page', '../src/renderer/views/Cloud.vue'],
    ['upload', '../src/renderer/components/music/CloudUploadDialog.vue'],
  ].map(([kind, path]) => {
    const { descriptor } = parse(read(path));
    return [
      kind,
      transformSync(compileScript(descriptor, { id: `cloud-${kind}` }).content, {
        loader: 'ts',
        format: 'cjs',
      }).code,
    ];
  }),
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await vue.nextTick();
  await new Promise((r) => setImmediate(r));
};
const row = (id) => ({
  id: String(id),
  name: String(id),
  cloudFileId: String(id),
  hash: `hash-${id}`,
});
const page = (ids, total = ids.length) => ({
  status: 1,
  data: { list: ids.map(row), list_count: total, max_size: 100, availble_size: 40 },
});
const userState = () =>
  vue.reactive({ isLoggedIn: true, accountRevision: 0, info: { userid: 7, token: 'one' } });
const changeUser = (user, kind) => {
  if (kind === 'revision') user.accountRevision++;
  if (kind === 'token') user.info.token = 'two';
  if (kind === 'userid') user.info.userid = 8;
  if (kind === 'logout') user.isLoggedIn = false;
};
const log = { warn() {}, debug() {}, info() {}, error() {} };
function render(t, kind, deps, runtime = {}, props = {}) {
  const hooks = Object.fromEntries(
    ['onMounted', 'onActivated', 'onDeactivated', 'onBeforeUnmount'].map((key) => [key, []]),
  );
  const module = { exports: {} };
  const dependencies = {
    ...deps,
    vue: {
      ...vue,
      ...Object.fromEntries(
        Object.entries(hooks).map(([key, list]) => [key, (fn) => list.push(fn)]),
      ),
    },
  };
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    scripts[kind],
  )(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    runtime,
    runtime.requestAnimationFrame,
    runtime.cancelAnimationFrame,
  );
  const scope = vue.effectScope();
  const view = scope.run(() =>
    module.exports.default.setup(props, {
      expose() {},
      emit: (_, value) => {
        props.open = value;
      },
    }),
  );
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    hooks.onBeforeUnmount.forEach((fn) => fn());
    scope.stop();
  };
  t.after(stop);
  return {
    view,
    stop,
    mount: () => hooks.onMounted.forEach((fn) => fn()),
    activate: () => hooks.onActivated.forEach((fn) => fn()),
    deactivate: () => hooks.onDeactivated.forEach((fn) => fn()),
  };
}
function pageFixture(t) {
  const user = userState(),
    notices = [],
    requests = [],
    deletes = [],
    indexCalls = [],
    progress = [];
  let get = async () => page([1]),
    remove = async () => ({ status: 1 });
  const upload = vue.reactive({
    status: 'idle',
    changedRevision: 0,
    openRequested: 0,
    requestAbort: () => {},
    dismiss: () => {},
    consumeOpenRequest: () => false,
    requestOpen: () => {},
  });
  const f = render(t, 'page', {
    '@/api/user': {
      getUserCloud: (...args) => {
        requests.push(args);
        return get(...args);
      },
      deleteCloudSongs: (...args) => {
        deletes.push(args);
        return remove(...args);
      },
    },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/cloudUpload': { useCloudUploadStore: () => upload },
    '@/stores/toast': {
      useToastStore: () =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                notices.push([method, ...args]),
          },
        ),
    },
    ...Object.fromEntries(
      ['playlist', 'player', 'setting', 'theme'].map((key) => [
        `@/stores/${key}`,
        { [`use${key[0].toUpperCase() + key.slice(1)}Store`]: () => ({}) },
      ]),
    ),
    '@/utils/userSession': session,

    '@/utils/cover': { createThemedIconCoverUrl: () => '' },
    '@/utils/mappers': { mapCloudSong: (value) => value },
    '@/utils/playback': { replaceQueueAndPlay: async () => true },
    '@/utils/songList': { sortSongs: (value) => value, filterSongsByQuery: (value) => value },
    '@/composables/useStickyTabsLayout': { useStickyTabsLayout: () => ({}) },
    '@/icons': {},
    '@/services/cloudAudioIndex': {
      clearCloudAudioIndex: () => indexCalls.push('clear'),
      refreshCloudAudioIndex: async () => indexCalls.push('refresh'),
    },
  });
  return {
    ...f,
    user,
    upload,
    notices,
    requests,
    deletes,
    indexCalls,
    progress,
    get: (fn) => {
      get = fn;
    },
    remove: (fn) => {
      remove = fn;
    },
  };
}
function uploadFixture(t) {
  pinia.setActivePinia(pinia.createPinia());
  const user = userState(),
    notices = [],
    picks = [],
    reads = [],
    posts = [],
    matches = [],
    tasks = [];
  let pick = async () => ({ canceled: false, files: [uploadFile()] }),
    match = async () => null,
    readFile = async () => ({ ok: true, data: new ArrayBuffer(3) }),
    post = async () => ({ status: 1, uploadInfo: { upload_id: 'upload' } }),
    search = async () => ({ status: 1, data: { lists: [searchRow()] } }),
    delay = async () => {};
  const plugin = {
    BUILTIN_PLUGIN_ID: 'echo',
    createTaskOwner: () => ({}),
    createTaskLifecycleActions: (value) => value,
    registerTask: () => {
      const controller = new AbortController();
      let active = true;
      const task = {
        get active() {
          return active;
        },
        signal: controller.signal,
        update: () => active,
        finish: () => active,
        cancel: () => {
          controller.abort();
        },
        dismiss: () => {
          active = false;
          controller.abort();
        },
      };
      tasks.push(task);
      return task;
    },
  };
  const { useCloudUploadStore } = load('../src/renderer/stores/cloudUpload.ts', {
    pinia,
    '@/utils/logger': log,
    '@/router': { currentRoute: vue.ref({ name: 'cloud' }) },
    '@/icons': {},
    '@/plugins/taskPanel': plugin,
    '@/tasks/taskControl': control,
  });
  const store = useCloudUploadStore();
  t.after(() => store.dismiss());
  let count = 0,
    clears = 0;
  const timers = new Map(),
    frames = new Map();
  const runtime = {
    setTimeout: (fn) => {
      const id = ++count;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => {
      const id = ++count;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    electron: {
      cloud: {
        pickUploadFiles: (...args) => {
          picks.push(args);
          return pick(...args);
        },
        readUploadFileData: (...args) => {
          reads.push(args);
          return readFile(...args);
        },
        clearUploadFiles: async () => {
          clears++;
        },
      },
    },
  };
  const props = vue.reactive({ open: true });
  const f = render(
    t,
    'upload',
    {
      '@vueuse/core': { useVModel },
      '@iconify/vue': {},
      '@/icons': {},
      '@/stores/user': { useUserStore: () => user },
      '@/stores/cloudUpload': { useCloudUploadStore: () => store },
      '@/stores/setting': {
        useSettingStore: () => ({ cloudUploadBackgroundConfirmDismissed: false }),
      },
      '@/stores/toast': {
        useToastStore: () =>
          new Proxy(
            {},
            {
              get:
                (_, method) =>
                (...args) =>
                  notices.push([method, ...args]),
            },
          ),
      },
      '@/api/search': { search: (...args) => search(...args) },
      '@/api/user': {
        uploadToCloud: (...args) => {
          posts.push(args);
          return post(...args);
        },
      },
      '@/utils/userSession': session,

      '@/utils/extractors': extractors,
      '@/utils/logger': log,
      '@/utils/songMatching': {
        findBestMatch: (...args) => {
          matches.push(args);
          return match(...args);
        },
        matchThinkDelay: () => delay(),
        isCloudUploadMatchAcceptable: () => true,
        explainCloudUploadMatchRejection: () => '',
        normalizePositiveNumericId: (value) =>
          /^\d+$/.test(String(value)) && Number(value) > 0 ? String(value) : undefined,
      },
    },
    runtime,
    props,
  );
  return {
    ...f,
    user,
    props,
    store,
    notices,
    picks,
    reads,
    posts,
    matches,
    tasks,
    timers,
    frames,
    get clears() {
      return clears;
    },
    pick: (fn) => {
      pick = fn;
    },
    match: (fn) => {
      match = fn;
    },
    read: (fn) => {
      readFile = fn;
    },
    post: (fn) => {
      post = fn;
    },
    search: (fn) => {
      search = fn;
    },
    delay: (fn) => {
      delay = fn;
    },
    runTimers: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}
const uploadFile = (name = 'a.mp3') => ({
  name,
  path: `/uploads/${name}`,
  size: 3,
  extension: '.mp3',
  modifiedAt: 1,
});
const searchRow = (title = 'match') => ({
  SongName: title,
  Auditoid: '7',
  MixSongID: '8',
  Duration: 90000,
  Singers: [{ name: 'artist' }],
});

for (const kind of ['revision', 'token', 'userid', 'logout', 'unmount', 'deactivate']) {
  test(`round16: cloud initial page discards results after ${kind}`, async (t) => {
    const f = pageFixture(t),
      old = deferred();
    f.get(() => old.promise);
    const operation = f.view.loadCloud();
    f.get(async () => page([9]));
    if (kind === 'unmount') f.stop();
    else if (kind === 'deactivate') f.deactivate();
    else changeUser(f.user, kind);
    old.resolve(page([1], 2));
    await operation;
    await flush();
    const reloaded = ['revision', 'token', 'userid'].includes(kind);
    assert.deepEqual(
      f.view.songs.value.map((v) => v.id),
      reloaded ? ['9'] : [],
    );
    assert.equal(f.indexCalls.filter((v) => v === 'refresh').length, reloaded ? 1 : 0);
  });
  test(`round16: cloud background paging yields to ${kind} before requesting another page`, async (t) => {
    const f = pageFixture(t),
      old = deferred();
    f.get((pageNumber) => (pageNumber === 1 ? Promise.resolve(page([1], 3)) : old.promise));
    await f.view.loadCloud();
    f.get(async () => page([9]));
    if (kind === 'unmount') f.stop();
    else if (kind === 'deactivate') f.deactivate();
    else changeUser(f.user, kind);
    old.resolve(page([2], 3));
    await flush();
    assert.equal(f.requests.length, ['revision', 'token', 'userid'].includes(kind) ? 3 : 2);
    assert.equal(
      f.view.songs.value.some((v) => v.id === '2'),
      false,
    );
  });
}
test('round16: current successful cloud load deduplicates IDs and fills remaining pages', async (t) => {
  const f = pageFixture(t);
  f.get(async (n) => (n === 1 ? page([1], 3) : page([1, 2], 3)));
  await f.view.loadCloud();
  await flush();
  assert.deepEqual(
    f.view.songs.value.map((v) => v.id),
    ['1', '1_2', '2'],
  );
  assert.equal(f.view.hasMore.value, false);
});
test('round16: stale cloud refresh success or error cannot replace a newer snapshot', async (t) => {
  for (const error of [false, true]) {
    const f = pageFixture(t),
      old = deferred();
    f.get(() => old.promise);
    const first = f.view.loadCloud();
    f.get(async () => page([2]));
    await f.view.loadCloud();
    if (error) old.reject(new Error('old'));
    else old.resolve(page([1]));
    await first;
    assert.deepEqual(
      f.view.songs.value.map((v) => v.id),
      ['2'],
    );
  }
});
test('round16: background failure preserves page and retries the same next page', async (t) => {
  const f = pageFixture(t);
  f.get(async (n) => {
    if (n === 1) return page([1], 2);
    throw new Error('offline');
  });
  await f.view.loadCloud();
  await flush();
  assert.equal(f.view.currentPage.value, 1);
  assert.equal(f.view.hasMore.value, true);
  f.get(async () => page([2], 2));
  assert.equal(typeof f.view.retryCloud, 'function');
  f.view.retryCloud();
  await flush();
  assert.deepEqual(
    f.requests.map((v) => v[0]),
    [1, 2, 2],
  );
  assert.deepEqual(
    f.view.songs.value.map((v) => v.id),
    ['1', '2'],
  );
});
test('round16: an empty later cloud page terminates outdated total without looping', async (t) => {
  const f = pageFixture(t);
  f.get(async (n) => (n === 1 ? page([1], 10) : page([], 10)));
  await f.view.loadCloud();
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.view.hasMore.value, false);
});
test('round16: cloud profile object replacement keeps cache and in-flight work', async (t) => {
  const f = pageFixture(t),
    read = deferred();
  f.get(() => read.promise);
  const operation = f.view.loadCloud();
  f.user.info = { ...f.user.info, nickname: 'profile' };
  read.resolve(page([1]));
  await operation;
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.view.songs.value.length, 1);
});
test('round16: cloud session replacement reloads once and old finally cannot release fresh loading', async (t) => {
  const f = pageFixture(t),
    old = deferred(),
    current = deferred();
  f.get(() => old.promise);
  const operation = f.view.loadCloud();
  f.get(() => current.promise);
  changeUser(f.user, 'revision');
  await flush();
  old.resolve(page([1]));
  await operation;
  assert.equal(f.view.loading.value, true);
  current.resolve(page([2]));
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.view.loading.value, false);
});
for (const kind of ['revision', 'token', 'logout', 'unmount', 'deactivate']) {
  for (const batch of [false, true]) {
    test(`round16: ${batch ? 'batch' : 'single'} cloud deletion cannot update a replaced ${kind} view`, async (t) => {
      const f = pageFixture(t);
      await f.view.loadCloud();
      const read = deferred();
      f.remove(() => read.promise);
      const song = f.view.songs.value[0];
      let operation;
      if (batch)
        operation = f.view.handleBatchDeleteCloudSongs([song], (...args) => f.progress.push(args));
      else {
        f.view.openDeleteCloudSongDialog(song);
        operation = f.view.confirmDeleteCloudSong();
      }
      if (kind === 'unmount') f.stop();
      else if (kind === 'deactivate') f.deactivate();
      else changeUser(f.user, kind);
      read.resolve({ status: 1 });
      await operation;
      assert.deepEqual(f.notices, []);
      assert.equal(f.requests.length, ['revision', 'token'].includes(kind) ? 2 : 1);
      if (batch) assert.equal(f.progress.length, 1);
    });
  }
}
test('round16: cloud single delete uses actual file ID, removes a reactive target and refreshes', async (t) => {
  const f = pageFixture(t);
  await f.view.loadCloud();
  f.view.openDeleteCloudSongDialog(f.view.songs.value[0]);
  f.get(async () => page([]));
  await f.view.confirmDeleteCloudSong();
  await flush();
  assert.equal(f.deletes[0][0][0].cloudFileId, '1');
  assert.equal(f.view.songs.value.length, 0);
  assert.equal(f.notices.length, 1);
  assert.equal(f.view.deletingCloudSong.value, false);
});
test('round16: hash-only and stale retained cloud rows cannot submit deletion', async (t) => {
  const f = pageFixture(t);
  await f.view.loadCloud();
  const old = f.view.songs.value[0];
  assert.equal(f.view.canDeleteCloudSong({ hash: 'old' }), false);
  f.view.songs.value = [row(2)];
  f.view.openDeleteCloudSongDialog(old);
  await f.view.confirmDeleteCloudSong();
  await assert.rejects(f.view.handleBatchDeleteCloudSongs([old]));
  assert.equal(f.deletes.length, 0);
});
for (const manual of [false, true]) {
  for (const kind of ['revision', 'token', 'logout', 'close', 'unmount']) {
    test(`round16: ${manual ? 'manual' : 'automatic'} picker ignores completion after ${kind}`, async (t) => {
      const f = uploadFixture(t),
        read = deferred();
      f.pick(() => read.promise);
      const operation = manual ? f.view.handlePickManual() : f.view.handlePick('file');
      if (kind === 'close') f.props.open = false;
      else if (kind === 'unmount') f.stop();
      else changeUser(f.user, kind);
      read.resolve({ canceled: false, files: [uploadFile()] });
      await operation;
      assert.equal(f.tasks.length, 0);
      assert.equal(f.view.manualFile.value, null);
      assert.deepEqual(f.notices, []);
    });
  }
}
for (const stage of ['matching', 'reading', 'uploading']) {
  for (const kind of ['revision', 'token', 'logout', 'cancel']) {
    test(`round16: ${kind} during ${stage} cannot upload remaining files or report completion`, async (t) => {
      const f = uploadFixture(t),
        read = deferred();
      f.pick(async () => ({ canceled: false, files: [uploadFile('a.mp3'), uploadFile('b.mp3')] }));
      if (stage === 'matching') f.match(() => read.promise);
      if (stage === 'reading') f.read(() => read.promise);
      if (stage === 'uploading') f.post(() => read.promise);
      const operation = f.view.handlePick('file');
      await flush();
      const posts = f.posts.length;
      if (kind === 'cancel') f.view.handleCancel();
      else changeUser(f.user, kind);
      read.resolve(
        stage === 'matching'
          ? null
          : stage === 'reading'
            ? { ok: true, data: new ArrayBuffer(3) }
            : { status: 1, uploadInfo: {} },
      );
      await operation;
      assert.equal(f.posts.length, posts);
      assert.equal(f.store.changedRevision, 0);
      assert.equal(
        f.notices.some(([kind]) => kind === 'success'),
        false,
      );
    });
  }
}
test('round16: closing to background retains upload flow and actual task completion', async (t) => {
  const f = uploadFixture(t),
    read = deferred();
  f.read(() => read.promise);
  const operation = f.view.handlePick('file');
  await flush();
  f.view.handleBackgroundRun();
  await flush();
  f.runTimers();
  read.resolve({ ok: true, data: new ArrayBuffer(3) });
  await operation;
  assert.equal(f.posts.length, 1);
  assert.equal(f.store.status, 'completed');
  assert.equal(f.store.summary.success, 1);
  assert.equal(f.store.changedRevision, 1);
  assert.equal(f.props.open, false);
});
test('round16: an unmounted background runner preserves same-session upload', async (t) => {
  const f = uploadFixture(t),
    read = deferred();
  f.read(() => read.promise);
  const operation = f.view.handlePick('file');
  await flush();
  f.stop();
  read.resolve({ ok: true, data: new ArrayBuffer(3) });
  await operation;
  assert.equal(f.posts.length, 1);
  assert.equal(f.store.status, 'completed');
  assert.equal(f.view.step.value, 'uploading');
});
test('round16: account changes after runner unmount still prevent posting old bytes', async (t) => {
  const f = uploadFixture(t),
    read = deferred();
  f.read(() => read.promise);
  const operation = f.view.handlePick('file');
  await flush();
  f.stop();
  changeUser(f.user, 'revision');
  read.resolve({ ok: true, data: new ArrayBuffer(3) });
  await operation;
  assert.equal(f.posts.length, 0);
  assert.equal(f.store.status, 'idle');
});
test('round16: reopening upload dialog cancels the old delayed reset', async (t) => {
  const f = uploadFixture(t);
  f.props.open = false;
  await flush();
  const callbacks = [...f.timers.values()];
  f.props.open = true;
  await flush();
  await f.view.handlePickManual();
  callbacks.forEach((fn) => fn());
  assert.equal(f.view.step.value, 'manual-search');
  assert.ok(f.view.manualFile.value);
});
test('round16: old picker finally cannot unlock a newer reopened picker', async (t) => {
  const f = uploadFixture(t),
    old = deferred(),
    current = deferred();
  f.pick(() => old.promise);
  const first = f.view.handlePickManual();
  f.props.open = false;
  f.props.open = true;
  f.pick(() => current.promise);
  const second = f.view.handlePickManual();
  old.resolve({ canceled: true, files: [] });
  await first;
  assert.equal(f.view.picking.value, true);
  current.resolve({ canceled: true, files: [] });
  await second;
  assert.equal(f.view.picking.value, false);
});
for (const kind of ['revision', 'close', 'unmount', 'query']) {
  test(`round16: manual search results cannot refill after ${kind}`, async (t) => {
    const f = uploadFixture(t);
    await f.view.handlePickManual();
    const read = deferred();
    f.search(() => read.promise);
    const operation = f.view.handleManualSearch();
    if (kind === 'close') f.props.open = false;
    else if (kind === 'unmount') f.stop();
    else if (kind === 'query') f.view.manualSearchTitle.value = 'new';
    else changeUser(f.user, kind);
    read.resolve({ status: 1, data: { lists: [searchRow()] } });
    await operation;
    assert.deepEqual(f.view.manualResults.value, []);
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.notices, []);
  });
}
test('round16: newer manual search owns results and busy state', async (t) => {
  const f = uploadFixture(t);
  await f.view.handlePickManual();
  const old = deferred(),
    current = deferred();
  f.search(() => old.promise);
  const first = f.view.handleManualSearch();
  f.view.manualSearchTitle.value = 'new';
  f.search(() => current.promise);
  const second = f.view.handleManualSearch();
  old.resolve({ status: 1, data: { lists: [searchRow('old')] } });
  await first;
  assert.equal(f.view.manualSearching.value, true);
  current.resolve({ status: 1, data: { lists: [searchRow('new')] } });
  await second;
  assert.equal(f.view.manualResults.value[0].title, 'new');
});
test('round16: manual result uploads real audio and album IDs once', async (t) => {
  const f = uploadFixture(t);
  await f.view.handlePickManual();
  await f.view.handleManualSearch();
  const result = f.view.manualResults.value[0];
  await f.view.handleSelectManualResult(result);
  await f.view.handleSelectManualResult(result);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0][1].audioId, '7');
  assert.equal(f.posts[0][1].albumAudioId, '8');
  assert.equal(f.store.summary.success, 1);
});
test('round16: manual search request errors are reported as errors and can retry', async (t) => {
  const f = uploadFixture(t);
  await f.view.handlePickManual();
  f.search(async () => {
    throw new Error('network');
  });
  await f.view.handleManualSearch();
  assert.equal(f.view.manualSearchDone.value, false);
  assert.equal(f.notices[0][0], 'danger');
  f.search(async () => ({ status: 1, data: { lists: [searchRow()] } }));
  await f.view.handleManualSearch();
  assert.equal(f.view.manualResults.value.length, 1);
});

test('round16: failed refresh of a partial cloud snapshot retries page one', async (t) => {
  const f = pageFixture(t),
    pending = deferred();
  f.get((number) => (number === 1 ? Promise.resolve(page([1], 3)) : pending.promise));
  await f.view.loadCloud();
  f.get(async () => {
    throw new Error('refresh failed');
  });
  await f.view.loadCloud();
  f.get(async () => page([9]));
  assert.equal(typeof f.view.retryCloud, 'function');
  f.view.retryCloud();
  await flush();
  pending.resolve(page([2, 3], 3));
  await flush();
  assert.deepEqual(
    f.requests.map((v) => v[0]),
    [1, 2, 1, 1],
  );
  assert.deepEqual(
    f.view.songs.value.map((v) => v.id),
    ['9'],
  );
});
test('round16: stale deletion finally cannot release a new session deletion', async (t) => {
  const f = pageFixture(t);
  await f.view.loadCloud();
  const old = deferred(),
    current = deferred();
  f.remove(() => old.promise);
  f.view.openDeleteCloudSongDialog(f.view.songs.value[0]);
  const first = f.view.confirmDeleteCloudSong();
  changeUser(f.user, 'revision');
  await flush();
  f.remove(() => current.promise);
  f.view.openDeleteCloudSongDialog(f.view.songs.value[0]);
  const second = f.view.confirmDeleteCloudSong();
  old.reject(new Error('old'));
  await first;
  assert.equal(f.view.deletingCloudSong.value, true);
  current.reject(new Error('current'));
  await second;
  assert.equal(f.view.deletingCloudSong.value, false);
  assert.deepEqual(f.notices, [['warning', 'current']]);
});
test('round16: delayed manual scroll is canceled on close and cannot move reopened results', async (t) => {
  const f = uploadFixture(t);
  await f.view.handlePickManual();
  await f.view.handleManualSearch();
  const old = [...f.frames.values()];
  let moves = 0;
  f.props.open = false;
  f.props.open = true;
  f.view.manualSearchResultList.value = { scrollTo: () => moves++ };
  old.forEach((fn) => fn());
  assert.equal(moves, 0);
  assert.equal(f.frames.size, 0);
});
function apiFixture() {
  const calls = [];
  let reply = async () => ({ status: 1 });
  const request = {
    get: (...args) => {
      calls.push(['get', ...args]);
      return reply(...args);
    },
    post: (...args) => {
      calls.push(['post', ...args]);
      return reply(...args);
    },
  };
  const api = load('../src/renderer/api/user.ts', {
    '@/utils/request': request,
  });
  return {
    api,
    calls,
    reply: (fn) => {
      reply = fn;
    },
  };
}
test('round16: cloud deletion API sends only supported file IDs and aligns album IDs', async () => {
  const f = apiFixture();
  await f.api.deleteCloudSongs([
    { cloudFileId: '12', albumAudioId: '22' },
    { hash: 'unsupported' },
    { cloudFileId: 13 },
    { cloudFileId: '00' },
  ]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], [
    'get',
    '/user/cloud/del',
    { params: { fileids: ['12', '13'], album_audio_ids: ['22', 0] } },
  ]);
});
test('round16: hash-only cloud deletion fails before sending a request', async () => {
  const f = apiFixture();
  await assert.rejects(f.api.deleteCloudSongs([{ hash: 'unsupported' }]), /文件标识/);
  assert.equal(f.calls.length, 0);
});
test('round16: cloud API errors retain upstream readable messages', async () => {
  const f = apiFixture();
  f.reply(async () => ({ status: 0, msg: 'quota reached' }));
  await assert.rejects(f.api.deleteCloudSongs([{ cloudFileId: '1' }]), /quota reached/);
  await assert.rejects(
    f.api.uploadToCloud(new ArrayBuffer(3), { name: 'song.mp3' }),
    /quota reached/,
  );
});
test('round16: valid cloud upload preserves author numeric IDs and server upload info', async () => {
  const f = apiFixture();
  f.reply(async () => ({ status: 1, uploadInfo: { upload_id: 'id' } }));
  const body = new ArrayBuffer(3);
  const result = await f.api.uploadToCloud(body, {
    name: 'song.mp3',
    authorName: 'artist',
    audioId: '5',
    albumAudioId: '6',
  });
  assert.equal(result.uploadInfo.upload_id, 'id');
  assert.equal(f.calls[0][2], body);
  assert.deepEqual(f.calls[0][3].params, {
    extendname: 'mp3',
    name: 'song',
    author_name: 'artist',
    audio_id: '5',
    album_audio_id: '6',
  });
});
function indexFixture() {
  const user = userState(),
    calls = [];
  let reply = async () => ({ status: 1, data: { list: [], list_count: 0 } });
  const api = load('../src/renderer/services/cloudAudioIndex.ts', {
    '@/api/user': {
      getUserCloud: (...args) => {
        calls.push(args);
        return reply(...args);
      },
    },
    '@/stores/user': { useUserStore: () => user },

    '@/utils/mappers': { mapCloudSong: (value) => value },
    '@/utils/logger': log,
  });
  const body = (hash, total = 1) => ({
    status: 1,
    data: { list: [{ cloudAudioSource: { hash } }], list_count: total },
  });
  return {
    user,
    api,
    calls,
    body,
    reply: (fn) => {
      reply = fn;
    },
  };
}
test('round16: a failed later index page does not replace the old complete index', async () => {
  const f = indexFixture();
  f.reply(async () => f.body('old'));
  await f.api.refreshCloudAudioIndex();
  f.reply(async (page) =>
    page === 1 ? f.body('partial', 2) : Promise.reject(new Error('network')),
  );
  await f.api.refreshCloudAudioIndex(true);
  assert.equal((await f.api.getCloudAudioSourceForSong({ hash: 'old' }))?.hash, 'old');
  assert.equal(await f.api.getCloudAudioSourceForSong({ hash: 'partial' }), null);
});
for (const stage of ['success', 'failure', 'delay', 'before']) {
  test(`round16: automatic matching stops stale keyword searches after ${stage}`, async () => {
    const pending = deferred();
    let current = stage !== 'before';
    const calls = [],
      timers = [];
    const module = { exports: {} };
    const code = transformSync(read('../src/renderer/utils/songMatching.ts'), {
      loader: 'ts',
      format: 'cjs',
    }).code;
    const deps = {
      '@/api/search': {
        search: async (...args) => {
          calls.push(args);
          if (stage === 'delay') return { data: { lists: [] } };
          return pending.promise;
        },
      },
      '@/utils/mappers': { mapSearchSong: (value) => value },
      '@/utils/logger': log,
    };
    new Function('require', 'module', 'exports', 'setTimeout', code)(
      (name) => {
        assert.ok(name in deps, name);
        return deps[name];
      },
      module,
      module.exports,
      (fn) => {
        timers.push(fn);
        return 1;
      },
    );
    const operation = module.exports.findBestMatch(
      { title: 'Song', artist: 'Artist', duration: 60 },
      { isCurrent: () => current, delayBetweenSearches: true },
    );
    await flush();
    current = false;
    if (stage === 'failure') pending.reject(new Error('old'));
    else pending.resolve({ data: { lists: [] } });
    for (let i = 0; i < 12; i++) {
      await flush();
      timers.splice(0).forEach((fn) => fn());
    }
    assert.equal(await operation, null);
    assert.equal(calls.length, stage === 'before' ? 0 : 1);
  });
}

test('round16: old reset callback cannot lose the timer of a newer close', async (t) => {
  const f = uploadFixture(t);
  f.props.open = false;
  await flush();
  const old = [...f.timers.values()];
  f.props.open = true;
  await flush();
  f.props.open = false;
  await flush();
  old.forEach((fn) => fn());
  f.props.open = true;
  await flush();
  assert.equal(f.timers.size, 0);
});
test('round16: an old frame callback cannot release a newer manual scroll frame', async (t) => {
  const f = uploadFixture(t);
  await f.view.handlePickManual();
  await f.view.handleManualSearch();
  const old = [...f.frames.values()];
  f.props.open = false;
  f.props.open = true;
  await f.view.handlePickManual();
  await f.view.handleManualSearch();
  old.forEach((fn) => fn());
  f.props.open = false;
  assert.equal(f.frames.size, 0);
});

for (const cancel of ['panel', 'dialog']) {
  test(`round16${cancel === 'panel' ? ' control' : ''}: partial ${cancel} cancellation refreshes previously uploaded files`, async (t) => {
    const f = uploadFixture(t),
      second = deferred();
    f.pick(async () => ({ canceled: false, files: [uploadFile('a.mp3'), uploadFile('b.mp3')] }));
    let reads = 0;
    f.read(async () => (++reads === 1 ? { ok: true, data: new ArrayBuffer(3) } : second.promise));
    const operation = f.view.handlePick('file');
    await flush();
    assert.equal(f.posts.length, 1);
    if (cancel === 'panel') f.store.requestAbort();
    else f.view.handleCancel();
    second.resolve({ ok: true, data: new ArrayBuffer(3) });
    await operation;
    assert.equal(f.posts.length, 1);
    assert.equal(f.store.changedRevision, 1);
    if (cancel === 'panel') assert.deepEqual(f.notices, [['info', '已取消上传']]);
    else assert.deepEqual(f.notices, []);
  });
}
test('round16: partial upload cancellation cannot refresh the next account', async (t) => {
  const f = uploadFixture(t),
    second = deferred();
  f.pick(async () => ({ canceled: false, files: [uploadFile('a.mp3'), uploadFile('b.mp3')] }));
  let reads = 0;
  f.read(async () => (++reads === 1 ? { ok: true, data: new ArrayBuffer(3) } : second.promise));
  const operation = f.view.handlePick('file');
  await flush();
  changeUser(f.user, 'revision');
  second.resolve({ ok: true, data: new ArrayBuffer(3) });
  await operation;
  assert.equal(f.posts.length, 1);
  assert.equal(f.store.changedRevision, 0);
});
