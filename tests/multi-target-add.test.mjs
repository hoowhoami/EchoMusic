import { userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { createRequire } from 'node:module';

const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');

const source = transformSync(
  readFileSync(
    new URL('../src/renderer/composables/useMultiTargetAdd.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
).code;
const session = transformSync(
  readFileSync(new URL('../src/renderer/utils/userSession.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const sessionModule = { exports: {} };
new Function('module', 'exports', session)(sessionModule, sessionModule.exports);
const track = (id) => ({ id: String(id), name: `Song ${id}`, hash: `hash-${id}` });
const key = (kind, id) => `${kind}:${id}`;
const deferred = (t) => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  t.after(() => resolve({ successCount: 0, failedCount: 0 }));
  return { promise, resolve };
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Submission timed out')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

function fixture(t, overrides = {}) {
  const open = vue.ref(true);
  const inputSongs = vue.ref([track(1), track(2)]);
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'a' },
  });
  const lists = vue.ref([
    { id: 'same', name: 'List' },
    { id: 'other', name: 'Other' },
  ]);
  const queues = vue.ref([
    { id: 'same', songs: [], songCount: 2 },
    { id: 'old:queue', songs: [], songCount: 2 },
  ]);
  const calls = [];
  const notifications = [];
  let completed = 0;
  const playlist = {
    userCollectionsGeneration: 0,
    addSongsToPlaylist: async (id, songs, progress, options) => {
      calls.push(['playlist', id, songs.map((song) => song.id)]);
      options.onBatchResult(songs, 'added');
      progress(songs.length, songs.length);
      return { successCount: songs.length, failedCount: 0 };
    },
    ensurePlaybackQueueSongsLoaded: async (id) => {
      calls.push(['loadQueue', id]);
      return { id, songs: [], songCount: 0 };
    },
    appendToPlaybackQueue: (songs, options) => {
      calls.push(['queue', options, songs.map((song) => song.id)]);
      return songs.length;
    },
    ...overrides,
  };
  const dependencies = {
    vue,
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/toast': {
      useToastStore: () => ({
        warning: (message) => notifications.push(['warning', message]),
        actionCompleted: (message) => notifications.push(['success', message]),
      }),
    },
    '@/utils/watchUserSession': userSessionWatch,
    '@/utils/userSession': sessionModule.exports,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const state = scope.run(() =>
    module.exports.useMultiTargetAdd({
      open,
      songs: () => inputSongs.value,
      playlists: () => lists.value,
      playbackQueues: () => queues.value,
      reversePlaylistSongs: () => true,
      disabled: () => false,
      onComplete: () => {
        completed++;
        open.value = false;
      },
    }),
  );
  return {
    state,
    user,
    open,
    inputSongs,
    lists,
    queues,
    playlist,
    calls,
    notifications,
    scope,
    dependencies,
    multiModule: module.exports,
    completed: () => completed,
  };
}

test('default mode sends no request; entering and cancelling multiselect only changes selection', async (t) => {
  const f = fixture(t);
  assert.equal(f.state.multiple.value, false);
  await f.state.submit();
  assert.deepEqual(f.calls, []);
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'same');
  f.state.toggleTarget('queue', 'same');
  assert.equal(f.state.selectedIds.value.size, 2);
  f.state.toggleMode();
  assert.equal(f.state.multiple.value, false);
  assert.equal(f.state.selectedIds.value.size, 0);
  assert.deepEqual(f.calls, []);
});

test('mixed targets with identical IDs remain distinct; only playlist order reverses, queues stay inactive', async (t) => {
  const f = fixture(t);
  f.state.toggleMode();
  f.state.toggleTarget('queue', 'same');
  f.state.toggleTarget('playlist', 'same');
  f.state.toggleTarget('queue', 'old:queue');
  f.inputSongs.value = [track(99)];
  await bounded(f.state.submit());
  assert.deepEqual(f.calls, [
    ['loadQueue', 'same'],
    ['queue', { queueId: 'same', activate: false }, ['1', '2']],
    ['playlist', 'same', ['2', '1']],
    ['loadQueue', 'old:queue'],
    ['queue', { queueId: 'old:queue', activate: false }, ['1', '2']],
  ]);
  assert.equal(f.completed(), 1);
  assert.equal(f.open.value, false);
});

test('partial failures preserve results and retry only failed songs and targets in their original order', async (t) => {
  let first = true;
  const writes = [];
  const f = fixture(t, {
    addSongsToPlaylist: async (id, songs, progress, options) => {
      writes.push([id, songs.map((song) => song.id)]);
      if (id === 'same' && first) {
        first = false;
        options.onBatchResult([songs[0]], 'added');
        options.onBatchResult([songs[1]], 'failed');
        return { successCount: 1, failedCount: 1 };
      }
      options.onBatchResult(songs, 'added');
      progress(songs.length, songs.length);
      return { successCount: songs.length, failedCount: 0 };
    },
  });
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'same');
  f.state.toggleTarget('playlist', 'other');
  await bounded(f.state.submit());
  assert.deepEqual(writes, [
    ['same', ['2', '1']],
    ['other', ['2', '1']],
  ]);
  assert.equal(f.open.value, true);
  assert.deepEqual(f.state.failedIds.value, [key('playlist', 'same')]);
  assert.equal(f.state.results.value[key('playlist', 'same')].addedCount, 1);
  f.state.toggleTarget('queue', 'same');
  assert.equal(f.state.selectedIds.value.size, 2);
  await bounded(f.state.submit(true));
  assert.deepEqual(writes.at(-1), ['same', ['1']]);
  assert.equal(writes.length, 3);
  assert.equal(f.completed(), 1);
});

test('already present is a successful skip and closes the dialog', async (t) => {
  const f = fixture(t, { addSongsToPlaylist: async () => ({ successCount: 0, failedCount: 0 }) });
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'same');
  await bounded(f.state.submit());
  assert.equal(f.completed(), 1);
  assert.match(f.notifications[0][1], /已包含/);
});

for (const boundary of ['close', 'account', 'dispose']) {
  test(`${boundary} stops remaining targets and stale notifications`, async (t) => {
    const pending = deferred(t);
    let writes = 0;
    const f = fixture(t, {
      addSongsToPlaylist: () => {
        writes++;
        return pending.promise;
      },
    });
    f.state.toggleMode();
    f.state.toggleTarget('playlist', 'same');
    f.state.toggleTarget('queue', 'same');
    const operation = f.state.submit();
    if (boundary === 'close') f.open.value = false;
    if (boundary === 'account') f.user.accountRevision++;
    if (boundary === 'dispose') f.scope.stop();
    pending.resolve({ successCount: 2, failedCount: 0 });
    await bounded(operation);
    assert.equal(writes, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.notifications, []);
    assert.equal(f.completed(), 0);
  });
}

test('double submission performs one operation and old completion cannot release a reopened operation', async (t) => {
  const old = deferred(t);
  const next = deferred(t);
  let writes = 0;
  const f = fixture(t, { addSongsToPlaylist: () => (++writes === 1 ? old.promise : next.promise) });
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'same');
  const first = f.state.submit();
  await f.state.submit();
  assert.equal(writes, 1);
  f.open.value = false;
  await vue.nextTick();
  f.open.value = true;
  await vue.nextTick();
  assert.equal(f.state.multiple.value, false);
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'other');
  const second = f.state.submit();
  old.resolve({ successCount: 2, failedCount: 0 });
  await bounded(first);
  assert.equal(f.state.busy.value, true);
  assert.deepEqual(f.notifications, []);
  next.resolve({ successCount: 2, failedCount: 0 });
  await bounded(second);
  assert.equal(f.completed(), 1);
});

test('account switch while loading a persisted queue prevents any append', async (t) => {
  const pending = deferred(t);
  const f = fixture(t, { ensurePlaybackQueueSongsLoaded: () => pending.promise });
  f.state.toggleMode();
  f.state.toggleTarget('queue', 'same');
  const operation = f.state.submit();
  f.user.info.token = 'new';
  pending.resolve();
  await bounded(operation);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notifications, []);
});

test('removed targets fail without creating a queue or writing a playlist', async (t) => {
  const f = fixture(t);
  f.state.toggleMode();
  f.state.toggleTarget('playlist', 'same');
  f.state.toggleTarget('queue', 'same');
  f.lists.value = [];
  f.queues.value = [];
  await bounded(f.state.submit());
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.failedIds.value.length, 2);
  assert.equal(f.open.value, true);
});

function dialogFixture(t, addPlaylist = async () => {}) {
  const f = fixture(t);
  const emitted = [];
  const props = vue.reactive({
    open: true,
    songs: f.inputSongs.value,
    playlists: f.lists.value,
    playbackQueues: f.queues.value,
    disabled: false,
    loading: false,
    showPlaybackQueues: true,
    reversePlaylistSongs: true,
    contentClass: '',
    addPlaylist,
  });
  f.playlist.getKnownPlaylistSongs = () => {
    throw new Error('The dialog must not inspect playlist song caches');
  };
  const dependencies = {
    ...f.dependencies,
    '@vueuse/core': {
      useVModel: (input, property, emit) =>
        vue.computed({
          get: () => input[property],
          set: (value) => emit(`update:${property}`, value),
        }),
    },
    '@/icons': {},
    '@/utils/playlistOrder': { orderByPlaylistPosition: (items) => items },
    '@/stores/playlist/helpers': { includesPlaylistIdentity: () => false },
    '@/utils/playbackQueuePresentation': {
      getPlaybackQueuePresentation: (queue) => ({ title: queue.id }),
    },
    '@/composables/useMultiTargetAdd': f.multiModule,
    '@/composables/useCachedOverlayOpen': { useCachedOverlayOpen: (model) => model },
  };
  const { descriptor } = parse(
    readFileSync(
      new URL('../src/renderer/components/music/AddToPlaylistDialog.vue', import.meta.url),
      'utf8',
    ),
  );
  const code = transformSync(compileScript(descriptor, { id: 'multi-dialog-test' }).content, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  const view = f.scope.run(() =>
    module.exports.default.setup(props, {
      expose() {},
      emit: (event, ...args) => {
        emitted.push([event, ...args]);
        if (event === 'update:open') props.open = args[0];
      },
    }),
  );
  return { ...f, view, props, emitted };
}

test('shared dialog default playlist and queue clicks remain immediate, with no confirmation step', async (t) => {
  const writes = [];
  const f = dialogFixture(t, async (id) => writes.push(id));
  await f.view.selectPlaylist(f.props.playlists[0]);
  assert.deepEqual(writes, ['same']);
  assert.equal(f.view.multiple.value, false);
  assert.equal(f.view.selectedIds.value.size, 0);
  f.view.selectQueue('same');
  assert.deepEqual(f.emitted.at(-1), ['selectQueue', 'same']);
});

test('shared dialog mixed selection submits once, and closes on completion', async (t) => {
  const writes = [];
  const f = dialogFixture(t, async (id) => writes.push(id));
  f.view.toggleMode();
  await f.view.selectPlaylist(f.props.playlists[0]);
  f.view.selectQueue('same');
  assert.deepEqual(writes, []);
  assert.equal(f.view.selectedIds.value.size, 2);
  await bounded(f.view.submit());
  assert.equal(f.props.open, false);
  assert.ok(f.emitted.some(([event]) => event === 'added'));
  assert.equal(f.calls.filter(([kind]) => kind === 'playlist').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'queue').length, 1);
});

test('select-all counts all shown queues and playlists without inspecting song caches', async (t) => {
  const f = dialogFixture(t);
  f.view.toggleMode();
  assert.equal(f.view.selectableTargetKeys.value.length, 4);
  assert.equal(f.view.selectedTargetCount.value, 0);
  assert.equal(f.view.selectAllState.value, false);
  f.view.selectQueue('same');
  assert.equal(f.view.selectedTargetCount.value, 1);
  assert.equal(f.view.selectAllState.value, 'indeterminate');
  f.view.setSelectAll(true);
  assert.deepEqual(
    [...f.view.selectedIds.value],
    ['queue:same', 'queue:old:queue', 'playlist:same', 'playlist:other'],
  );
  assert.equal(f.view.selectedTargetCount.value, 4);
  assert.equal(f.view.selectAllState.value, true);
  f.view.setSelectAll(false);
  assert.equal(f.view.selectedTargetCount.value, 0);
  assert.equal(f.view.selectAllState.value, false);
  assert.deepEqual(f.calls, []);
});

test('hidden queues do not count; no playlists leave select-all disabled at 0/0', (t) => {
  const f = dialogFixture(t);
  f.props.showPlaybackQueues = false;
  f.view.toggleMode();
  assert.equal(f.view.selectableTargetKeys.value.length, 2);
  f.props.playlists = [];
  assert.equal(f.view.selectableTargetKeys.value.length, 0);
  assert.equal(f.view.selectedTargetCount.value, 0);
  assert.equal(f.view.selectAllState.value, false);
  assert.equal(f.view.canSelectAll.value, false);
  f.view.setSelectAll(true);
  assert.equal(f.view.selectedIds.value.size, 0);
});

test('select-all cannot change targets while loading or submitting', async (t) => {
  const pending = deferred(t);
  const f = dialogFixture(t);
  f.props.showPlaybackQueues = false;
  f.playlist.addSongsToPlaylist = () => pending.promise;
  f.view.toggleMode();
  f.props.loading = true;
  f.view.setSelectAll(true);
  assert.equal(f.view.selectedIds.value.size, 0);
  f.props.loading = false;
  f.view.setSelectAll(true);
  assert.equal(f.view.selectedIds.value.size, 2);
  const operation = f.view.submit();
  f.view.setSelectAll(false);
  assert.equal(f.view.selectedIds.value.size, 2);
  pending.resolve({ successCount: 2, failedCount: 0 });
  await bounded(operation);
});

test('a pending single addition blocks extra clicks and entering multiselect', async (t) => {
  const pending = deferred(t);
  let writes = 0;
  const f = dialogFixture(t, () => {
    writes++;
    return pending.promise;
  });
  const first = f.view.selectPlaylist(f.props.playlists[0]);
  await f.view.selectPlaylist(f.props.playlists[1]);
  f.view.selectQueue('same');
  f.view.toggleMode();
  assert.equal(writes, 1);
  assert.equal(f.view.multiple.value, false);
  assert.deepEqual(f.emitted, []);
  pending.resolve();
  await bounded(first);
  assert.equal(f.view.isBusy.value, false);
  f.view.toggleMode();
  assert.equal(f.view.multiple.value, true);
});

test('Dialog checks changing footer slots without caching a non-reactive slot object', () => {
  const slots = {};
  const { descriptor } = parse(
    readFileSync(new URL('../src/renderer/components/ui/Dialog.vue', import.meta.url), 'utf8'),
  );
  const code = transformSync(compileScript(descriptor, { id: 'dynamic-footer-test' }).content, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  const dependencies = {
    vue: { ...vue, useSlots: () => slots },
    '@/components/ui/dialogStack': { useDialogStack: () => ({}) },
    '@vueuse/core': { useVModel: () => vue.ref(false) },
    '@/composables/useCachedOverlayOpen': { useCachedOverlayOpen: (model) => model },
    '@/icons': {},
    'reka-ui': {},
  };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  const view = module.exports.default.setup({}, { expose() {}, emit() {} });
  const hasFooter = () =>
    typeof view.hasFooter === 'function' ? view.hasFooter() : vue.unref(view.hasFooter);
  assert.equal(hasFooter(), false);
  slots.footer = () => [];
  assert.equal(hasFooter(), true);
  delete slots.footer;
  assert.equal(hasFooter(), false);
});
