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
  const mocks = {
    vue: require('vue'),
    'vue-router': { useRouter: () => ({}), useRoute: () => ({}) },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({}) },
    '@/stores/user': { useUserStore: () => ({ isLoggedIn: true }) },
    '@/stores/toast': {
      useToastStore: () => ({ actionCompleted() {}, warning() {}, actionFailed() {} }),
    },
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
  const controls = module.exports.usePlayerControls();
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
