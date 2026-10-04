import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const { descriptor } = parse(
  readFileSync(new URL('../src/renderer/views/DiscoverFlow.vue', import.meta.url), 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'discover-init-test' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const QUEUE_ID = 'queue:home-discover';
const song = (id) => ({ id, hash: id, name: `Song ${id}`, artist: 'Artist' });
const item = (id) => ({ key: id, itemId: id, algPath: '', song: song(id) });
const flush = async () => {
  for (let i = 0; i < 10; i++) await vue.nextTick();
};

function fixture() {
  let initialize;
  let fetchCalls = 0;
  let playbackCalls = 0;
  let appendCalls = 0;
  const initialization = new Promise((resolve) => {
    initialize = resolve;
  });
  const mounted = [];
  const activated = [];
  const deactivated = [];
  const unmounted = [];
  const keys = new Set();
  const player = vue.reactive({
    currentTrackId: null,
    currentSourceQueueId: null,
    isPlaying: false,
    whenInitialized: () => initialization,
    playTrack: async () => {
      playbackCalls++;
    },
  });
  const playlist = vue.reactive({
    defaultList: [],
    queue: null,
    getQueueById: () => playlist.queue,
    isFavoriteSong: () => false,
    replenishDiscoverQueue: async () => {
      appendCalls++;
      return 0;
    },
  });
  const deps = {
    vue: {
      ...vue,
      onMounted: (fn) => mounted.push(fn),
      onActivated: (fn) => activated.push(fn),
      onDeactivated: (fn) => deactivated.push(fn),
      onBeforeUnmount: (fn) => unmounted.push(fn),
    },
    '@/components/ui/Button.vue': {},
    '@/components/ui/Tooltip.vue': {},
    '@/components/ui/RefreshIcon.vue': {},
    '@/components/ui/Cover.vue': {},
    '@/components/music/DetailPageError.vue': {},
    '@/services/discover': {
      fetchDiscoverItems: async () => {
        fetchCalls++;
        return [item('fresh-1'), item('fresh-2')];
      },
    },
    '@/icons': {},
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => playlist, DISCOVER_QUEUE_ID: QUEUE_ID },
    '@/stores/toast': { useToastStore: () => ({ info() {}, loadFailed() {} }) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/utils/playback': {},
    '@/utils/song': { getSongQualityTags: () => [], isPlayableSong: () => true },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
    {
      addEventListener: (name, handler) => keys.add(handler),
      removeEventListener: (name, handler) => keys.delete(handler),
    },
  );
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  const restore = (trackId = 'b') => {
    playlist.queue = {
      id: QUEUE_ID,
      songs: [song('a'), song('b'), song('c')],
      currentTrackId: trackId,
    };
    playlist.defaultList = playlist.queue.songs;
    player.currentSourceQueueId = QUEUE_ID;
    player.currentTrackId = trackId;
    player.isPlaying = true;
  };
  return {
    view,
    player,
    playlist,
    restore,
    initialize,
    keys,
    mount: () => mounted[0](),
    activate: () => activated.forEach((fn) => fn()),
    deactivate: () => deactivated.forEach((fn) => fn()),
    unmount: () => {
      unmounted.forEach((fn) => fn());
      scope.stop();
    },
    counts: () => ({ fetchCalls, playbackCalls, appendCalls }),
  };
}

test('view waits for live-session recovery and reuses the current song without fetching or restarting playback', async () => {
  const f = fixture();
  try {
    const mounting = f.mount();
    await flush();
    assert.equal(f.counts().fetchCalls, 0);
    assert.equal(f.view.loading.value, true);
    f.restore();
    f.initialize();
    await mounting;
    await flush();
    assert.deepEqual(
      f.view.items.value.map((entry) => entry.song.id),
      ['a', 'b', 'c'],
    );
    assert.equal(f.view.currentSong.value.id, 'b');
    assert.equal(f.view.progressLabel.value, '2 / 3');
    assert.equal(f.view.loading.value, false);
    assert.deepEqual(f.counts(), { fetchCalls: 0, playbackCalls: 0, appendCalls: 0 });
    f.player.currentTrackId = 'c';
    await flush();
    assert.equal(f.view.currentSong.value.id, 'c');
    assert.equal(f.counts().playbackCalls, 0);
  } finally {
    f.unmount();
  }
});

test('cold startup requests recommendations once, after initialization is complete', async () => {
  const f = fixture();
  try {
    const mounting = f.mount();
    await flush();
    assert.equal(f.counts().fetchCalls, 0);
    f.initialize();
    await mounting;
    await flush();
    assert.equal(f.counts().fetchCalls, 1);
    assert.equal(f.view.currentSong.value.id, 'fresh-1');
    assert.equal(f.view.loading.value, false);
  } finally {
    f.unmount();
  }
});

test('returning to a restored view does not refresh; an explicit refresh still requests a new batch', async () => {
  const f = fixture();
  try {
    f.restore();
    f.initialize();
    await f.mount();
    await flush();
    f.deactivate();
    f.activate();
    await flush();
    assert.equal(f.counts().fetchCalls, 0);
    assert.equal(f.view.currentSong.value.id, 'b');
    f.view.refreshDiscover();
    await flush();
    assert.equal(f.counts().fetchCalls, 1);
    assert.equal(f.view.currentSong.value.id, 'fresh-1');
    assert.equal(f.player.currentTrackId, 'b');
    assert.equal(f.counts().playbackCalls, 0);
  } finally {
    f.unmount();
  }
});

test('leaving before recovery completes does not issue a late request or reattach listeners', async () => {
  const f = fixture();
  const mounting = f.mount();
  f.unmount();
  f.initialize();
  await mounting;
  await flush();
  assert.equal(f.counts().fetchCalls, 0);
  assert.equal(f.keys.size, 0);
});

test('reusing the recovered batch does not disable end-of-queue replenishment', async () => {
  const f = fixture();
  try {
    f.restore('c');
    f.initialize();
    await f.mount();
    await flush();
    await f.view.goNext();
    assert.equal(f.counts().appendCalls, 1);
    assert.equal(f.counts().fetchCalls, 0);
    assert.equal(f.view.currentSong.value.id, 'c');
  } finally {
    f.unmount();
  }
});
