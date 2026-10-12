import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { reactive } from 'vue';

const require = createRequire(import.meta.url);
const source = transformSync(
  readFileSync(
    new URL('../src/renderer/composables/usePlayerControls.ts', import.meta.url),
    'utf8',
  ),
  {
    loader: 'ts',
    format: 'cjs',
  },
).code;

function makeControls(player, playlist = {}, router = {}) {
  const mocks = {
    vue: require('vue'),
    'vue-router': {
      ...require('vue-router'),
      useRouter: () => router,
      useRoute: () => ({ fullPath: '/main/history' }),
    },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({}) },
    '@/stores/user': { useUserStore: () => ({ isLoggedIn: true }) },
    '@/stores/toast': {
      useToastStore: () => ({ actionCompleted() {}, warning() {}, actionFailed() {} }),
    },
    '@/stores/songQualityAccess': { useSongQualityAccessStore: () => ({}) },
    '@/utils/songQualityAccess': {},
    '@/utils/song': {},
    '@/utils/share': {},
    '@/services/cloudAudioIndex': {},
    '@/icons': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id) => {
      assert.ok(id in mocks, `Unexpected dependency: ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
  );
  return module.exports.usePlayerControls();
}

test('add-to-playlist and add-to-queue keep the song selected when the panel opened', async () => {
  const calls = [];
  const player = reactive({ currentTrackId: 'a', currentTrackSnapshot: { id: 'a', name: 'A' } });
  const playlist = {
    userPlaylists: [{}],
    playbackQueueList: [],
    addToPlaylist: async (id, song) => {
      calls.push(['playlist', id, song.id]);
      return 'added';
    },
    appendToPlaybackQueue: (songs, options) => {
      calls.push(['queue', options.queueId, songs[0].id]);
      return 1;
    },
  };
  const controls = makeControls(player, playlist);
  await controls.handleOpenAddToPlaylist();
  player.currentTrackId = 'b';
  player.currentTrackSnapshot = { id: 'b', name: 'B' };
  await controls.handleSelectPlaylist('saved');
  assert.deepEqual(calls.at(-1), ['playlist', 'saved', 'a']);
  await controls.handleOpenAddToPlaylist();
  player.currentTrackId = 'c';
  player.currentTrackSnapshot = { id: 'c', name: 'C' };
  controls.handleAddToQueue('queue');
  assert.deepEqual(calls.at(-1), ['queue', 'queue', 'b']);
  assert.equal(controls.showAddToPlaylistDialog.value, false);
});

test('MV navigation pauses audio and closes the playback page after successful navigation', async () => {
  const calls = [];
  let resolve;
  const player = reactive({
    currentTrackId: '1',
    currentTrackSnapshot: { id: '1', albumAudioId: 456, name: 'Song', mvHash: 'mv' },
    isPlaying: true,
    togglePlay: async () => calls.push('pause'),
    toggleLyricView: (open) => calls.push(['lyric', open]),
  });
  const controls = makeControls(
    player,
    {},
    {
      push: (route) => {
        calls.push(route);
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
  );
  const pending = controls.goToMv();
  await Promise.resolve();
  assert.equal(calls[0], 'pause');
  assert.equal(calls[1].name, 'mv-detail');
  assert.equal(calls[1].params.id, '456');
  assert.equal(calls[1].query.from, '/main/history');
  assert.equal(calls.length, 2);
  resolve(undefined);
  await pending;
  assert.deepEqual(calls.at(-1), ['lyric', false]);
});

test('opening MV with paused audio only navigates and closes the playback page', async () => {
  const calls = [];
  const controls = makeControls(
    {
      currentTrackId: '12',
      currentTrackSnapshot: { id: '12' },
      isPlaying: false,
      togglePlay: () => {
        throw new Error('must not resume playback');
      },
      toggleLyricView: (open) => calls.push(open),
    },
    {},
    { push: async () => undefined },
  );
  await controls.goToMv();
  assert.deepEqual(calls, [false]);
});

test('failed MV navigation retains the playback page', async () => {
  let closes = 0;
  const controls = makeControls(
    {
      currentTrackId: '12',
      currentTrackSnapshot: { id: '12' },
      toggleLyricView: () => {
        closes++;
      },
    },
    {},
    { push: async () => new Error('navigation aborted') },
  );
  await controls.goToMv();
  assert.equal(closes, 0);
});

test('opening the already-current MV still closes the playback page', async () => {
  const { createMemoryHistory, createRouter } = require('vue-router');
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/mv/:id', name: 'mv-detail', component: {} }],
  });
  let closes = 0;
  const controls = makeControls(
    {
      currentTrackId: '12',
      currentTrackSnapshot: { id: '12' },
      toggleLyricView: () => {
        closes++;
      },
    },
    {},
    router,
  );
  await controls.goToMv();
  await controls.goToMv();
  assert.equal(closes, 2);
});

test('MV without a valid song identity keeps the page and does not navigate', async () => {
  const controls = makeControls(
    {
      toggleLyricView: () => {
        throw new Error('must not close');
      },
    },
    {},
    {
      push: () => {
        throw new Error('must not navigate');
      },
    },
  );
  await controls.goToMv();
});
