import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as decisions from '../src/shared/playbackQueueDecision.ts';

function compile(path, deps = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

const constants = compile('../src/renderer/stores/playlist/constants.ts');
const {
  DEFAULT_PLAYBACK_QUEUE_ID,
  DISCOVER_QUEUE_ID,
  PERSONAL_FM_QUEUE_ID,
  LISTEN_TOGETHER_QUEUE_ID,
} = constants;
const songUtils = compile('../src/renderer/utils/song.ts');
let fetchDiscoverItems = async () => [];
const discoverActions = compile('../src/renderer/stores/playlist/discoverActions.ts', {
  '@/services/discover': { fetchDiscoverItems: () => fetchDiscoverItems() },
  '@/utils/song': songUtils,
  '@/utils/logger': { warn() {} },
  './constants': constants,
});
const helpers = compile('../src/renderer/stores/playlist/helpers.ts', {
  vue,
  '@/utils/song': songUtils,
  './constants': constants,
});
const queueActions = compile('../src/renderer/stores/playlist/queueActions.ts', {
  '@/utils/song': songUtils,
  '../../../shared/playbackQueueDecision': decisions,
  './constants': constants,
  './helpers': helpers,
});
const object = compile('../src/shared/object.ts');
const extractors = compile('../src/renderer/utils/extractors.ts', {
  '../../shared/object': object,
});
const userSession = compile('../src/renderer/utils/userSession.ts');
let fetchPersonalFm = async () => [];
const personalFmActions = compile('../src/renderer/stores/playlist/personalFmActions.ts', {
  '@/api/music': { getPersonalFm: (...args) => fetchPersonalFm(...args) },
  '@/utils/extractors': extractors,

  '@/utils/userSession': userSession,
  '@/stores/user': { useUserStore: () => ({ isLoggedIn: false, accountRevision: 0, info: null }) },
  '@/utils/logger': { default: { warn() {} } },
  '@/utils/song': songUtils,
  '@/utils/mappers': { mapTopSong: (value) => value },
  './constants': constants,
  './helpers': helpers,
});
const { usePlaylistStore } = compile('../src/renderer/stores/playlist/store.ts', {
  pinia,
  vue,
  './constants': constants,
  './helpers': helpers,
  './queueActions': queueActions,
  './personalFmActions': personalFmActions,
  './discoverActions': discoverActions,
  './favoritesActions': { favoritesActions: {} },
  './userActions': { userActions: {} },
});

const song = (id) => ({ id, hash: id, name: id, artist: 'artist' });
function setup(snapshot) {
  pinia.setActivePinia(pinia.createPinia());
  const writes = [];
  globalThis.window = {
    electron: {
      storage: new Proxy(
        {},
        {
          get: (_, method) => async (args) => {
            writes.push({ method, args });
            if (method === 'getPlaybackSnapshot') return snapshot;
          },
        },
      ),
    },
  };
  const store = usePlaylistStore();
  store.playbackStorageReady = true;
  return { store, writes };
}

function startDiscover(store) {
  store.setPlaybackQueueWithOptions([song('normal')], 0, { queueId: DEFAULT_PLAYBACK_QUEUE_ID });
  store.setPlaybackQueueWithOptions([song('discover')], 0, {
    queueId: DISCOVER_QUEUE_ID,
    type: 'home-discover',
    title: '刷歌',
    subtitle: '为你推荐',
    dynamic: true,
  });
}

test('switching active queues removes discover from memory and storage', () => {
  const { store, writes } = setup();
  startDiscover(store);
  assert.equal(store.lastNonFmQueueId, DEFAULT_PLAYBACK_QUEUE_ID);
  store.setActiveQueue(DEFAULT_PLAYBACK_QUEUE_ID);
  assert.equal(store.getQueueById(DISCOVER_QUEUE_ID), null);
  assert.deepEqual(
    store.defaultList.map((s) => s.id),
    ['normal'],
  );
  assert(
    writes.some((w) => w.method === 'removePlaybackQueue' && w.args.queueId === DISCOVER_QUEUE_ID),
  );
});

test('replacing with another queue destroys discover but updating its songs does not', () => {
  const { store } = setup();
  startDiscover(store);
  store.setPlaybackQueueWithOptions([song('next')], 0, { queueId: DISCOVER_QUEUE_ID });
  assert(store.getQueueById(DISCOVER_QUEUE_ID));
  store.setPlaybackQueueWithOptions([song('album')], 0, { queueId: 'queue:album', type: 'album' });
  assert.equal(store.getQueueById(DISCOVER_QUEUE_ID), null);
  assert.equal(store.activeQueueId, 'queue:album');
  assert.deepEqual(
    store.defaultList.map((s) => s.id),
    ['album'],
  );
});

test('background queue edits and synchronization keep the currently playing discover session', () => {
  const { store } = setup();
  startDiscover(store);
  store.setPlaybackQueueWithOptions([song('album')], 0, {
    queueId: 'queue:album',
    activate: false,
  });
  store.syncLegacyPlaybackState();
  assert.equal(store.activeQueueId, DISCOVER_QUEUE_ID);
  assert(store.getQueueById(DISCOVER_QUEUE_ID));
  assert.equal(store.getPreferredManualQueueOptions().queueId, DEFAULT_PLAYBACK_QUEUE_ID);
  store.appendToPlaybackQueue([song('manual')]);
  assert.equal(store.activeQueueId, DISCOVER_QUEUE_ID);
  assert.deepEqual(
    store.getQueueById(DISCOVER_QUEUE_ID).songs.map((s) => s.id),
    ['discover'],
  );
  assert.deepEqual(
    store.getQueueById(DEFAULT_PLAYBACK_QUEUE_ID).songs.map((s) => s.id),
    ['normal', 'manual'],
  );
});

test('explicitly playing appended songs in another queue disposes discover', () => {
  const { store } = setup();
  startDiscover(store);
  store.appendToPlaybackQueue([song('manual')], {
    queueId: DEFAULT_PLAYBACK_QUEUE_ID,
    activate: true,
  });
  assert.equal(store.getQueueById(DISCOVER_QUEUE_ID), null);
  assert.equal(store.activeQueueId, DEFAULT_PLAYBACK_QUEUE_ID);
});

test('FM direct activation and listen-together activation also dispose discover', async () => {
  for (const target of [PERSONAL_FM_QUEUE_ID, LISTEN_TOGETHER_QUEUE_ID]) {
    const { store } = setup();
    startDiscover(store);
    if (target === PERSONAL_FM_QUEUE_ID) {
      store.personalFmBuffer = [song('fm')];
      assert.equal(await store.startPersonalFm(), true);
    } else {
      store.setPlaybackQueueWithOptions([song('together')], 0, { queueId: target });
    }
    assert.equal(store.activeQueueId, target);
    assert.equal(store.getQueueById(DISCOVER_QUEUE_ID), null);
  }
});

test('entering discover still clears the old FM session', async () => {
  const { store } = setup();
  store.personalFmBuffer = [song('fm')];
  await store.startPersonalFm();
  store.setPlaybackQueueWithOptions([song('discover')], 0, { queueId: DISCOVER_QUEUE_ID });
  assert.equal(store.getQueueById(PERSONAL_FM_QUEUE_ID), null);
  assert.equal(store.activeQueueId, DISCOVER_QUEUE_ID);
});

test('startup removes a saved discover session and preserves the normal queue', async () => {
  const normal = helpers.buildPlaybackQueueState({ queueId: DEFAULT_PLAYBACK_QUEUE_ID }, [
    song('normal'),
  ]);
  const discover = helpers.buildPlaybackQueueState(
    { queueId: DISCOVER_QUEUE_ID, type: 'home-discover' },
    [song('discover')],
  );
  const { store, writes } = setup({
    queues: [discover, normal],
    activeQueueId: DISCOVER_QUEUE_ID,
    lastNonFmQueueId: DISCOVER_QUEUE_ID,
  });
  await store.hydratePlaybackStateFromStorage();
  assert.equal(store.getQueueById(DISCOVER_QUEUE_ID), null);
  assert.equal(store.activeQueueId, DEFAULT_PLAYBACK_QUEUE_ID);
  assert.equal(store.lastNonFmQueueId, DEFAULT_PLAYBACK_QUEUE_ID);
  assert(
    writes.some((w) => w.method === 'removePlaybackQueue' && w.args.queueId === DISCOVER_QUEUE_ID),
  );
});

test('discover is excluded from history and transient queue targets', () => {
  const { store } = setup();
  startDiscover(store);
  store.activeQueueId = DEFAULT_PLAYBACK_QUEUE_ID;
  assert(!store.recentPlaybackQueues.some((q) => q.id === DISCOVER_QUEUE_ID));
  assert(!store.historyPlaybackQueues.some((q) => q.id === DISCOVER_QUEUE_ID));
  assert.equal(constants.isTransientPlaybackQueue(DISCOVER_QUEUE_ID), true);
  assert.equal(constants.isTransientPlaybackQueue(DEFAULT_PLAYBACK_QUEUE_ID), false);
});

test('replenishment appends fresh playable tracks without resetting the current selection', async () => {
  const { store } = setup();
  startDiscover(store);
  store.updateQueueCurrentTrack('discover', DISCOVER_QUEUE_ID);
  let calls = 0;
  fetchDiscoverItems = async () => {
    calls++;
    return [{ song: song('discover') }, { song: song('next') }];
  };
  assert.equal(await store.replenishDiscoverQueue('discover'), 1);
  assert.equal(calls, 1);
  assert.deepEqual(
    store.defaultList.map((s) => s.id),
    ['discover', 'next'],
  );
  assert.equal(store.getQueueById(DISCOVER_QUEUE_ID).currentTrackId, 'discover');
});

test('prefetch and end-of-queue share one request, and a destroyed session cannot return', async () => {
  const { store } = setup();
  startDiscover(store);
  let complete;
  let calls = 0;
  fetchDiscoverItems = () => {
    calls++;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const first = store.replenishDiscoverQueue('discover');
  const second = store.replenishDiscoverQueue('discover');
  assert.equal(calls, 1);
  store.setActiveQueue(DEFAULT_PLAYBACK_QUEUE_ID);
  startDiscover(store);
  complete([{ song: song('stale') }]);
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.deepEqual(
    store.defaultList.map((s) => s.id),
    ['discover'],
  );
});

test('a refreshed batch rejects a pending append from the previous batch', async () => {
  const { store } = setup();
  startDiscover(store);
  let complete;
  fetchDiscoverItems = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const pending = store.replenishDiscoverQueue('discover');
  store.setPlaybackQueueWithOptions([song('fresh')], 0, { queueId: DISCOVER_QUEUE_ID });
  complete([{ song: song('stale') }]);
  assert.equal(await pending, 0);
  assert.deepEqual(
    store.defaultList.map((s) => s.id),
    ['fresh'],
  );
});

test('duplicate batches have bounded retries, errors allow a later retry, and ample queues do not fetch', async () => {
  const { store } = setup();
  startDiscover(store);
  let calls = 0;
  fetchDiscoverItems = async () => {
    calls++;
    return [{ song: song('discover') }];
  };
  assert.equal(await store.replenishDiscoverQueue('discover'), 0);
  assert.equal(calls, 3);
  fetchDiscoverItems = async () => {
    throw Error('offline');
  };
  assert.equal(await store.replenishDiscoverQueue('discover'), 0);
  fetchDiscoverItems = async () => ['a', 'b', 'c', 'd'].map((id) => ({ song: song(id) }));
  assert.equal(await store.replenishDiscoverQueue('discover'), 4);
  fetchDiscoverItems = async () => {
    assert.fail('should not prefetch yet');
  };
  assert.equal(await store.replenishDiscoverQueue('discover'), 0);
});

test('round14: actual Pinia cold FM creation shares startup and commits the registered queue', async () => {
  const { store } = setup();
  let resolve;
  const read = new Promise((r) => {
    resolve = r;
  });
  let requests = 0;
  fetchPersonalFm = () => {
    requests++;
    return read;
  };
  try {
    const first = store.startPersonalFm(),
      second = store.startPersonalFm();
    const count = requests;
    resolve([song('new')]);
    const results = await Promise.all([first, second]);
    assert.equal(count, 1);
    assert.deepEqual(results, [true, true]);
    assert.equal(store.activeQueueId, PERSONAL_FM_QUEUE_ID);
    assert.equal(store.personalFmBuffer[0].id, 'new');
  } finally {
    resolve([]);
    fetchPersonalFm = async () => [];
  }
});
