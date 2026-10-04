import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import { useVModel } from '@vueuse/core';
const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const root = new URL('../', import.meta.url);
const load = (path, deps = {}, runtime = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    ...Object.keys(runtime),
    transformSync(readFileSync(new URL(path, root), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  )(
    (id) => {
      assert.ok(id in deps, `unexpected import: ${id}`);
      return deps[id];
    },
    module,
    module.exports,
    ...Object.values(runtime),
  );
  return module.exports;
};
const object = load('src/shared/object.ts');
const sessions = load('src/renderer/utils/userSession.ts');
const control = load('src/renderer/tasks/taskControl.ts');
const descriptor = parse(
  readFileSync(
    process.env.ECHOMUSIC_IMPORT_DIALOG_TEST_SOURCE ||
      new URL('src/renderer/components/music/ImportPlaylistDialog.vue', root),
    'utf8',
  ),
).descriptor;
const script = transformSync(compileScript(descriptor, { id: 'import-dialog-lifecycle' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const flush = async () => {
  await vue.nextTick();
  await new Promise(setImmediate);
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('import dialog operation did not settle')), 400);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const task = (extra = {}) => ({
  id: 11,
  status: 3,
  listid: 21,
  songs_num: 2,
  imported_num: 2,
  missed_num: 0,
  ...extra,
});
const file = (name = 'one.png', size = 12) => ({ name, size, type: 'image/png' });
const track = (name = 'Song') => ({ title: name, artist: 'Artist' });
const change = (user, kind) => {
  if (kind === 'revision') user.accountRevision++;
  if (kind === 'token') user.info.token = 'two';
  if (kind === 'userid') user.info.userid = 8;
  if (kind === 'logout') user.isLoggedIn = false;
};
function fixture(t) {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'one', nickname: 'name' },
  });
  const calls = [],
    notices = [],
    readers = [],
    timers = new Map(),
    mounts = [],
    deferreds = [];
  let serial = 0;
  let reply = async (operation) =>
    operation === 'add_task'
      ? { status: 1, data: { id: 11 } }
      : operation === 'query_task_status'
        ? { status: 1, data: [task()] }
        : { status: 1 };
  let resolvePlaylist = async () => ({
    ok: true,
    playlist: { name: 'Imported', tracks: [track()] },
  });
  let fetch = async () => {};
  let create = async () => 21;
  let match = async (external) => ({
    song: { name: external.title, hash: 'h', mixSongId: 1 },
    score: 0.95,
    scoreDetails: { title: 1, artist: 1, titleExtraRatio: 0 },
  });
  let read = (reader) => queueMicrotask(() => reader.finish());
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
    timers.set(id, { fn, delay });
    return id;
  };
  const logger = { warn() {}, info() {}, error() {} };
  const panel = load(
    'src/renderer/plugins/taskPanel.ts',
    { vue, '@/utils/logger': logger },
    { setTimeout: setTimer, clearTimeout: (id) => timers.delete(id) },
  );
  const taskModule = load('src/renderer/stores/importTask.ts', {
    pinia,
    vue,
    '@/utils/logger': logger,
    '@/icons': { iconPlaylistAdd: {} },
    '@/plugins/taskPanel': panel,
    '@/tasks/taskControl': control,
  });
  const store = taskModule.useImportTaskStore(pinia.createPinia());
  const playlists = vue.reactive({
    userPlaylists: [{ id: '21', listid: 21, name: 'Target', source: 1, listCreateUserid: 7 }],
    fetchUserPlaylists: async () => {
      calls.push(['fetch']);
      return fetch();
    },
    createPlaylistAndReturnId: async (...args) => {
      calls.push(['create', ...args]);
      return create(...args);
    },
  });
  const settings = vue.reactive({ importBackgroundConfirmDismissed: false });
  const api = load('src/renderer/api/importPlaylist.ts', {
    '@/utils/request': {
      post: async (url, body, config) => {
        calls.push([body.operation, body, config]);
        return reply(body.operation, body);
      },
    },
  });
  const native = load(
    'src/renderer/utils/nativeImportPlaylist.ts',
    { '@/api/importPlaylist': api, '../../shared/object': object },
    {
      window: {
        setTimeout: (fn) => {
          queueMicrotask(fn);
          return 0;
        },
      },
    },
  );
  const matching = load(
    'src/renderer/utils/songMatching.ts',
    {
      '@/api/search': { search: async () => ({ data: { lists: [] } }) },
      '@/utils/mappers': { mapSearchSong: (v) => v },
      '@/utils/logger': logger,
    },
    {
      setTimeout: (fn) => {
        queueMicrotask(fn);
        return 0;
      },
    },
  );
  const local = load(
    'src/renderer/utils/importPlaylist.ts',
    {
      '@/api/playlist': {
        addPlaylistTrack: async (...args) => {
          calls.push(['add', ...args]);
          return { status: 1 };
        },
      },
      '@/utils/logger': logger,
      '@/utils/songMatching': {
        ...matching,
        findBestMatch: (external, options) => {
          calls.push(['match', external]);
          return match(external, options);
        },
        matchThinkDelay: async () => {},
      },
    },
    {
      setTimeout: (fn) => {
        queueMicrotask(fn);
        return 0;
      },
    },
  );
  class Reader {
    readyState = 0;
    result = null;
    error = null;
    onload = null;
    onerror = null;
    onabort = null;
    aborts = 0;
    readAsDataURL(selected) {
      this.file = selected;
      this.readyState = 1;
      readers.push(this);
      calls.push(['read', selected.name]);
      read(this);
    }
    finish(value = 'data:image/png;base64,YQ==') {
      this.readyState = 2;
      this.result = value;
      this.onload?.();
    }
    fail(error = new Error('reader failed')) {
      this.error = error;
      this.readyState = 2;
      this.onerror?.();
    }
    abort() {
      this.aborts++;
      this.readyState = 2;
      this.onabort?.();
    }
  }
  const mount = (initialOpen = true) => {
    const props = vue.reactive({ open: initialOpen });
    const hooks = [];
    const module = { exports: {} };
    const deps = {
      vue: { ...vue, onBeforeUnmount: (fn) => hooks.push(fn) },
      '@vueuse/core': { useVModel },
      '@iconify/vue': {},
      '@/icons': {},
      '@/api/importPlaylist': api,
      '@/api/external': {
        resolveExternalPlaylist: async (req) => {
          calls.push(['resolve', req]);
          return resolvePlaylist(req);
        },
      },
      '@/utils/nativeImportPlaylist': native,
      '@/utils/importPlaylist': local,
      '@/stores/playlist': { usePlaylistStore: () => playlists },
      '@/stores/user': { useUserStore: () => user },
      '@/stores/toast': {
        useToastStore: () =>
          Object.fromEntries(
            ['success', 'warning', 'actionFailed'].map((kind) => [
              kind,
              (msg) => notices.push([kind, msg]),
            ]),
          ),
      },
      '@/stores/importTask': { useImportTaskStore: () => store },
      '@/stores/setting': { useSettingStore: () => settings },
      '@/utils/userSession': sessions,
    };
    new Function('require', 'module', 'exports', 'window', 'FileReader', script)(
      (id) => {
        if (id.endsWith('.vue')) return {};
        assert.ok(id in deps, `unexpected component import: ${id}`);
        return deps[id];
      },
      module,
      module.exports,
      { setTimeout: setTimer, clearTimeout: (id) => timers.delete(id) },
      Reader,
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
      hooks.forEach((fn) => fn());
      scope.stop();
    };
    mounts.push(stop);
    return { props, view, stop };
  };
  const initial = mount();
  t.after(async () => {
    mounts.forEach((fn) => fn());
    store.dismiss();
    deferreds.forEach((resolve) => resolve());
    timers.clear();
    await flush();
  });
  const screenshot = (files = [file()]) => {
    initial.view.mode.value = 'screenshot';
    initial.view.existingListId.value = 21;
    initial.view.selectedFiles.value = files;
  };
  const link = () => {
    initial.view.mode.value = 'link';
    initial.view.inputText.value = 'https://example.test/playlist';
  };
  const fallback = () => {
    reply = async (operation) =>
      operation === 'query_task_status'
        ? { status: 1, data: [task({ status: 10, songs_num: 0, imported_num: 0, task_type: 0 })] }
        : { status: 1, data: { id: 11 } };
    link();
  };
  return {
    ...initial,
    user,
    store,
    panel,
    playlists,
    settings,
    calls,
    notices,
    readers,
    timers,
    mount,
    defer,
    screenshot,
    link,
    fallback,
    reply: (fn) => {
      reply = fn;
    },
    fetch: (fn) => {
      fetch = fn;
    },
    create: (fn) => {
      create = fn;
    },
    match: (fn) => {
      match = fn;
    },
    read: (fn) => {
      read = fn;
    },
    resolve: (fn) => {
      resolvePlaylist = fn;
    },
    runTimers: () => {
      const values = [...timers.values()];
      timers.clear();
      values.forEach(({ fn }) => fn());
    },
  };
}
for (const mode of ['link', 'screenshot']) {
  test(`normal ${mode} import completes the actual task and preserves progress`, async (t) => {
    const f = fixture(t);
    if (mode === 'link') f.link();
    else f.screenshot([file('one.png'), file('two.png')]);
    await f.view.startImport();
    await flush();
    assert.equal(f.store.status, 'completed');
    assert.equal(f.view.summary.value.success, 2);
    assert.equal(f.view.isImporting.value, false);
    assert.equal(f.notices.filter(([kind]) => kind === 'success').length, 1);
    if (mode === 'screenshot')
      assert.deepEqual(
        f.calls.filter(([kind]) => kind === 'read').map((v) => v[1]),
        ['one.png', 'two.png'],
      );
  });
}
for (const kind of ['revision', 'token', 'userid', 'logout']) {
  for (const stage of [
    'create-task',
    'read',
    'upload',
    'poll',
    'resolve',
    'create-playlist',
    'match',
  ]) {
    test(`${kind} during ${stage} stops subsequent old-account work`, async (t) => {
      const f = fixture(t),
        wait = f.defer();
      if (['resolve', 'create-playlist', 'match'].includes(stage)) f.fallback();
      else f.link();
      if (['read', 'upload'].includes(stage)) f.screenshot([file('one.png'), file('two.png')]);
      if (stage === 'read') f.read(() => {});
      if (stage === 'resolve') f.resolve(() => wait.promise);
      if (stage === 'create-playlist') f.create(() => wait.promise);
      if (stage === 'match') f.match(() => wait.promise);
      if (['create-task', 'upload', 'poll'].includes(stage))
        f.reply(async (op) =>
          op ===
          { 'create-task': 'add_task', upload: 'submit_img', poll: 'query_task_status' }[stage]
            ? wait.promise
            : op === 'query_task_status'
              ? { status: 1, data: [task()] }
              : { status: 1, data: { id: 11 } },
        );
      const pending = f.view.startImport();
      await flush();
      const before = f.calls.length,
        notices = f.notices.length;
      change(f.user, kind);
      if (stage === 'resolve')
        wait.resolve({ ok: true, playlist: { name: 'Imported', tracks: [track()] } });
      else if (stage === 'create-playlist') wait.resolve(21);
      else if (stage === 'match') wait.resolve(null);
      else if (stage === 'poll') wait.resolve({ status: 1, data: [task()] });
      else wait.resolve({ status: 1, data: { id: 11 } });
      if (stage === 'read') f.readers[0].finish();
      await bounded(pending);
      await flush();
      assert.equal(f.calls.length, before);
      assert.equal(f.notices.length, notices);
      assert.equal(f.store.status, 'idle');
      assert.equal(f.props.open, false);
      assert.equal(f.view.summary.value, null);
    });
  }
}
for (const stage of ['create-task', 'upload', 'poll', 'resolve', 'create-playlist', 'match']) {
  test(`late ${stage} rejection after account change is ignored`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    if (['resolve', 'create-playlist', 'match'].includes(stage)) f.fallback();
    else f.link();
    if (stage === 'upload') f.screenshot();
    if (stage === 'resolve') f.resolve(() => wait.promise);
    if (stage === 'create-playlist') f.create(() => wait.promise);
    if (stage === 'match') f.match(() => wait.promise);
    if (['create-task', 'upload', 'poll'].includes(stage))
      f.reply(async (op) =>
        op === { 'create-task': 'add_task', upload: 'submit_img', poll: 'query_task_status' }[stage]
          ? wait.promise
          : { status: 1, data: { id: 11 } },
      );
    const pending = f.view.startImport();
    await flush();
    const count = f.notices.length;
    change(f.user, 'revision');
    wait.reject(new Error('old request'));
    await assert.doesNotReject(bounded(pending));
    assert.equal(f.notices.length, count);
    assert.equal(f.store.status, 'idle');
  });
}
for (const stage of ['read', 'upload', 'poll', 'match']) {
  test(`unmounted same-session background ${stage} continues to completion`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    if (stage === 'match') f.fallback();
    else f.screenshot([file('one.png'), file('two.png')]);
    if (stage === 'read') f.read(() => {});
    if (stage === 'match') f.match(() => wait.promise);
    if (stage === 'upload' || stage === 'poll')
      f.reply(async (op) =>
        op === (stage === 'upload' ? 'submit_img' : 'query_task_status')
          ? wait.promise
          : op === 'query_task_status'
            ? { status: 1, data: [task()] }
            : { status: 1, data: { id: 11 } },
      );
    const pending = f.view.startImport();
    await flush();
    f.stop();
    if (stage === 'read') {
      f.read(() => queueMicrotask(() => f.readers.at(-1).finish()));
      f.readers[0].finish();
    } else if (stage === 'match') wait.resolve(null);
    else wait.resolve(stage === 'poll' ? { status: 1, data: [task()] } : { status: 1 });
    await bounded(pending);
    await flush();
    assert.equal(f.store.status, 'completed');
    assert.equal(f.notices.filter(([kind]) => kind === 'success').length, 1);
    assert.equal(f.view.summary.value, null);
  });
}
for (const stage of ['read', 'upload', 'poll', 'match']) {
  test(`account change after unmount cancels background ${stage}`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    if (stage === 'match') f.fallback();
    else f.screenshot([file('one.png'), file('two.png')]);
    if (stage === 'read') f.read(() => {});
    if (stage === 'match') f.match(() => wait.promise);
    if (stage === 'upload' || stage === 'poll')
      f.reply(async (op) =>
        op === (stage === 'upload' ? 'submit_img' : 'query_task_status')
          ? wait.promise
          : op === 'query_task_status'
            ? { status: 1, data: [task()] }
            : { status: 1, data: { id: 11 } },
      );
    const pending = f.view.startImport();
    await flush();
    f.stop();
    const before = f.calls.length,
      notices = f.notices.length;
    change(f.user, 'token');
    assert.equal(f.store.status, 'idle');
    if (stage === 'read') f.readers[0].finish();
    else
      wait.resolve(
        stage === 'poll' ? { status: 1, data: [task()] } : stage === 'match' ? null : { status: 1 },
      );
    await bounded(pending);
    assert.equal(f.calls.length, before);
    assert.equal(f.notices.length, notices);
  });
}
test('background close and delayed reset preserve captured screenshot files and target', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.screenshot([file('one.png'), file('two.png')]);
  f.reply(async (op) =>
    op === 'submit_img'
      ? wait.promise
      : op === 'query_task_status'
        ? { status: 1, data: [task()] }
        : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.view.runInBackground();
  await flush();
  f.runTimers();
  f.view.selectedFiles.value = [file('foreign.png')];
  f.view.existingListId.value = 99;
  wait.resolve({ status: 1 });
  await pending;
  await flush();
  assert.deepEqual(
    f.calls.filter(([kind]) => kind === 'read').map((v) => v[1]),
    ['one.png', 'two.png'],
  );
  assert.equal(
    f.calls.find(([kind, body]) => kind === 'add_task' && body.task_type === 1)[1].listid,
    21,
  );
  assert.equal(f.store.status, 'completed');
  assert.equal(f.props.open, false);
  assert.equal(f.view.step.value, 'input');
});
for (const skip of [false, true]) {
  test(`closing progress ${skip ? 'skips' : 'requires'} background confirmation correctly`, async (t) => {
    const f = fixture(t),
      wait = f.defer();
    f.link();
    f.settings.importBackgroundConfirmDismissed = skip;
    f.reply(async (op) =>
      op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
    );
    const pending = f.view.startImport();
    await flush();
    f.props.open = false;
    await flush();
    assert.equal(f.props.open, !skip);
    assert.equal(f.view.showBackgroundConfirm.value, !skip);
    if (!skip) {
      f.view.neverShowBackgroundConfirm.value = true;
      f.view.confirmBackgroundImport();
    }
    wait.resolve({ status: 1, data: [task()] });
    await pending;
    await flush();
    assert.equal(f.store.status, 'completed');
    assert.equal(f.settings.importBackgroundConfirmDismissed, true);
  });
}
test('queued old reset cannot clear a reopened form and unmount clears its timer', async (t) => {
  const f = fixture(t);
  f.props.open = false;
  await flush();
  const old = [...f.timers.values()].filter((v) => v.delay === 200).map((v) => v.fn);
  f.props.open = true;
  await flush();
  f.view.inputText.value = 'new form';
  old.forEach((fn) => fn());
  assert.equal(f.view.inputText.value, 'new form');
  f.props.open = false;
  await flush();
  f.stop();
  assert.equal([...f.timers.values()].filter((v) => v.delay === 200).length, 0);
});
for (const action of ['cancel', 'account', 'unmount']) {
  test(`duplicate-name decision settles without creating a playlist after ${action}`, async (t) => {
    const f = fixture(t);
    f.screenshot();
    f.view.screenshotTarget.value = 'new';
    f.view.newScreenshotPlaylistName.value = 'Target';
    const pending = f.view.startImport();
    await flush();
    assert.equal(f.view.showDuplicateNameConfirm.value, true);
    if (action === 'cancel') f.view.stopMonitoring();
    if (action === 'account') change(f.user, 'revision');
    if (action === 'unmount') f.stop();
    await bounded(pending);
    assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 0);
    assert.equal(f.view.showDuplicateNameConfirm.value, false);
    assert.equal(f.store.status, 'idle');
  });
}
test('duplicate-name confirmation retains explicitly edited name and original userid', async (t) => {
  const f = fixture(t);
  f.screenshot();
  f.view.screenshotTarget.value = 'new';
  f.view.newScreenshotPlaylistName.value = 'Target';
  const pending = f.view.startImport();
  await flush();
  f.view.duplicatePlaylistName.value = 'Renamed';
  f.view.finishDuplicateNameConfirm(true);
  await pending;
  await flush();
  assert.deepEqual(
    f.calls.find(([kind]) => kind === 'create'),
    ['create', 'Renamed', false, 7],
  );
  assert.equal(f.store.status, 'completed');
});
test('duplicate import clicks share one active task', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(() => wait.promise);
  const pending = f.view.startImport();
  await f.view.startImport();
  assert.equal(f.calls.filter(([kind]) => kind === 'add_task').length, 1);
  f.view.stopMonitoring();
  wait.resolve({ status: 1, data: { id: 11 } });
  await pending;
});
test('failed screenshot submission stops remaining files and does not create a task', async (t) => {
  const f = fixture(t);
  f.screenshot([file('one.png'), file('two.png')]);
  f.reply(async () => {
    throw new Error('network');
  });
  await f.view.startImport();
  assert.equal(f.calls.filter(([kind]) => kind === 'submit_img').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'add_task').length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'read').length, 1);
  assert.equal(f.store.status, 'idle');
});
test('more than nine screenshots still validate retained files against 10MB', (t) => {
  const f = fixture(t);
  f.view.handleFiles({
    target: {
      files: Array.from({ length: 10 }, (_, i) =>
        file(`${i}.png`, i === 2 ? 11 * 1024 * 1024 : 12),
      ),
    },
  });
  assert.equal(f.view.selectedFiles.value.length, 0);
  assert.match(f.view.errorMessage.value, /10 MB/);
});
test('valid screenshot selection truncates to nine and keeps its original order', (t) => {
  const f = fixture(t);
  f.view.handleFiles({ target: { files: Array.from({ length: 10 }, (_, i) => file(`${i}.png`)) } });
  assert.deepEqual(
    f.view.selectedFiles.value.map((v) => v.name),
    Array.from({ length: 9 }, (_, i) => `${i}.png`),
  );
  assert.match(f.view.errorMessage.value, /9/);
});
for (const kind of ['invalid-url', 'anonymous', 'foreign-target', 'oversized']) {
  test(`invalid ${kind} cannot submit an import`, async (t) => {
    const f = fixture(t);
    f.link();
    if (kind === 'invalid-url') f.view.inputText.value = 'not a URL';
    if (kind === 'anonymous') f.user.isLoggedIn = false;
    if (kind === 'foreign-target') {
      f.screenshot();
      f.view.existingListId.value = 99;
    }
    if (kind === 'oversized') f.screenshot([file('big.png', 11 * 1024 * 1024)]);
    assert.equal(f.view.canStart.value, false);
    await f.view.startImport();
    assert.equal(
      f.calls.filter(([kind]) => kind === 'add_task' || kind === 'submit_img').length,
      0,
    );
  });
}
for (const outcome of ['error', 'invalid', 'sync-throw', 'cancel', 'abort-throw']) {
  test(`FileReader ${outcome} settles and clears callbacks`, async (t) => {
    const f = fixture(t);
    f.screenshot();
    f.read(() => {
      if (outcome === 'sync-throw') throw new Error('cannot read');
    });
    const pending = f.view.startImport();
    await flush();
    const reader = f.readers[0];
    if (outcome === 'error') reader.fail();
    if (outcome === 'invalid') reader.finish('data:application/pdf;base64,YQ==');
    if (outcome === 'cancel' || outcome === 'abort-throw') {
      if (outcome === 'abort-throw')
        reader.abort = () => {
          throw new Error('reader gone');
        };
      f.view.stopMonitoring();
    }
    await assert.doesNotReject(bounded(pending));
    assert.equal(reader.onload, null);
    assert.equal(reader.onerror, null);
    assert.equal(reader.onabort, null);
    assert.equal(f.calls.filter(([kind]) => kind === 'submit_img').length, 0);
    if (outcome === 'cancel') assert.equal(reader.aborts, 1);
  });
}
test('closing input preparation invalidates its pending native creation', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(() => wait.promise);
  const pending = f.view.startImport();
  f.props.open = false;
  await flush();
  f.props.open = true;
  f.view.inputText.value = 'https://new.test/playlist';
  wait.resolve({ status: 1, data: { id: 11 } });
  await pending;
  assert.equal(f.calls.filter(([kind]) => kind === 'query_task_status').length, 0);
  assert.equal(f.view.inputText.value, 'https://new.test/playlist');
});
test('normal local fallback completes and supplementary refresh failure cannot erase success', async (t) => {
  const f = fixture(t);
  f.fallback();
  let fetches = 0;
  f.fetch(async () => {
    if (++fetches > 1) throw new Error('refresh unavailable');
  });
  await f.view.startImport();
  await flush();
  assert.equal(f.store.status, 'completed');
  assert.equal(f.store.summary.success, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'add').length, 1);
  assert.equal(
    f.notices.some(([kind]) => kind === 'actionFailed'),
    false,
  );
});
test('normal cloud success survives supplementary refresh failure', async (t) => {
  const f = fixture(t);
  f.link();
  f.fetch(async () => {
    throw new Error('refresh unavailable');
  });
  await f.view.startImport();
  await flush();
  assert.equal(f.store.status, 'completed');
  assert.equal(f.store.summary.success, 2);
  assert.equal(
    f.notices.some(([kind]) => kind === 'actionFailed'),
    false,
  );
});
test('ordinary profile changes preserve the in-flight import', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.user.info.nickname = 'new nickname';
  assert.equal(f.store.status, 'running');
  wait.resolve({ status: 1, data: [task()] });
  await pending;
  assert.equal(f.store.status, 'completed');
});
test('a remounted dialog can resume and cancel the existing background task', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.stop();
  const next = f.mount(false);
  next.props.open = true;
  await flush();
  assert.equal(next.view.step.value, 'progress');
  assert.equal(next.view.isImporting.value, true);
  next.view.stopMonitoring();
  wait.resolve({ status: 1, data: [task()] });
  await pending;
  assert.equal(f.store.status, 'idle');
  assert.equal(next.view.isImporting.value, false);
});
test('new task after account change owns loading and results despite an old failure', async (t) => {
  const f = fixture(t),
    old = f.defer(),
    next = f.defer();
  f.link();
  f.reply(() => old.promise);
  const first = f.view.startImport();
  change(f.user, 'revision');
  f.props.open = true;
  await flush();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? next.promise : { status: 1, data: { id: 11 } },
  );
  const second = f.view.startImport();
  await flush();
  old.reject(new Error('old failure'));
  await first;
  assert.equal(f.store.status, 'running');
  assert.equal(f.view.isImporting.value, true);
  next.resolve({ status: 1, data: [task()] });
  await second;
  await flush();
  assert.equal(f.store.status, 'completed');
  assert.equal(f.notices.filter(([kind]) => kind === 'success').length, 1);
});
test('phase reset keeps the actual progress index aligned with new rows', (t) => {
  const f = fixture(t),
    source = track();
  const run = f.store.start('test', () => {}, sessions.captureUserSession(f.user));
  run.updateProgress(0, 1, { external: source, status: 'matching' });
  run.resetProgress(0, 1, [{ external: source, status: 'pending' }]);
  run.updateProgress(1, 1, { external: vue.reactive(source), status: 'success' });
  assert.equal(f.store.items.length, 1);
  assert.equal(f.store.items[0].status, 'success');
});
test('completed account-bound results are cleared after their dialog unmounts', async (t) => {
  const f = fixture(t);
  f.link();
  await f.view.startImport();
  f.stop();
  change(f.user, 'revision');
  assert.equal(f.store.status, 'idle');
  assert.equal(f.store.summary, null);
  assert.equal(f.store.items.length, 0);
});

test('a dialog remounted already open restores active background progress', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.stop();
  const next = f.mount(true);
  assert.equal(next.view.step.value, 'progress');
  assert.equal(next.view.isImporting.value, true);
  wait.resolve({ status: 1, data: [task()] });
  await pending;
  await flush();
  assert.equal(next.view.summary.value.success, 2);
});
test('background preparation failure remains reviewable in the task panel', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.screenshot();
  f.reply(async () => wait.promise);
  const pending = f.view.startImport();
  await flush();
  f.view.runInBackground();
  await flush();
  wait.reject(new Error('submission failed'));
  await pending;
  assert.equal(f.store.status, 'completed');
  assert.equal(f.store.summary.failed, 1);
  assert.equal(f.store.items[0].error, 'submission failed');
  assert.equal(f.props.open, false);
});
test('an unmounted fallback requiring a name decision settles without creating a duplicate', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.fallback();
  f.resolve(() => wait.promise);
  const pending = f.view.startImport();
  await flush();
  f.stop();
  wait.resolve({ ok: true, playlist: { name: 'Target', tracks: [track()] } });
  await bounded(pending);
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 0);
  assert.equal(f.store.status, 'completed');
  assert.equal(f.store.summary.failed, 1);
  assert.equal(f.view.showDuplicateNameConfirm.value, false);
});
test('task-panel abort cancels the actual FileReader and preserves abort feedback', async (t) => {
  const f = fixture(t);
  f.screenshot();
  f.read(() => {});
  const pending = f.view.startImport();
  await flush();
  const action = f.panel.taskPanelState.entries['echo:import'].actions.find(
    (v) => v.id === 'abort',
  );
  assert.ok(action);
  action.onClick();
  await bounded(pending);
  await flush();
  assert.equal(f.readers[0].aborts, 1);
  assert.equal(f.store.status, 'aborted');
  assert.equal(f.view.isStarting.value, false);
  assert.equal(f.view.isImporting.value, false);
});
test('completion detail request restores the current result without starting another import', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.view.runInBackground();
  await flush();
  f.runTimers();
  wait.resolve({ status: 1, data: [task()] });
  await pending;
  f.store.requestOpen();
  f.props.open = true;
  await flush();
  assert.equal(f.view.summary.value.success, 2);
  assert.equal(f.view.step.value, 'progress');
  assert.equal(f.calls.filter(([kind]) => kind === 'add_task').length, 1);
});
test('dismissed old session subscriptions cannot clear a new run', (t) => {
  const f = fixture(t);
  const oldUser = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 1, token: 'old' },
  });
  const old = f.store.start('old', () => {}, sessions.captureUserSession(oldUser));
  old.dismiss();
  const next = f.store.start('new', () => {}, sessions.captureUserSession(f.user));
  oldUser.info.token = 'changed';
  assert.equal(next.active, true);
  assert.equal(f.store.status, 'running');
  assert.equal(f.store.playlistName, 'new');
  assert.equal(old.resetProgress(1, 1, [{ external: track(), status: 'failed' }]), false);
  assert.equal(old.setPhase('local'), false);
});
test('an already-invalid account scope cannot start an active task', (t) => {
  const f = fixture(t);
  const run = f.store.start(
    'obsolete',
    () => {},
    () => false,
  );
  assert.equal(run.active, false);
  assert.equal(run.signal.aborted, true);
  assert.equal(f.store.status, 'idle');
});
test('FileReader completion callbacks already queued before cancellation cannot submit bytes', async (t) => {
  const f = fixture(t);
  f.screenshot();
  f.read(() => {});
  const pending = f.view.startImport();
  await flush();
  const reader = f.readers[0],
    queued = reader.onload;
  f.view.stopMonitoring();
  reader.result = 'data:image/png;base64,YQ==';
  queued();
  await bounded(pending);
  assert.equal(f.calls.filter(([kind]) => kind === 'submit_img').length, 0);
  assert.equal(
    f.notices.some(([kind]) => kind === 'actionFailed'),
    false,
  );
});

test('completion dismisses an obsolete background confirmation', async (t) => {
  const f = fixture(t),
    wait = f.defer();
  f.link();
  f.reply(async (op) =>
    op === 'query_task_status' ? wait.promise : { status: 1, data: { id: 11 } },
  );
  const pending = f.view.startImport();
  await flush();
  f.props.open = false;
  await flush();
  assert.equal(f.view.showBackgroundConfirm.value, true);
  wait.resolve({ status: 1, data: [task()] });
  await pending;
  await flush();
  assert.equal(f.view.showBackgroundConfirm.value, false);
  assert.equal(f.view.summary.value.success, 2);
});
