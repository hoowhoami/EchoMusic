import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
const require = createRequire(import.meta.url);
const { ref, watch, nextTick, effectScope } = require('vue');
const read = (name) =>
  readFileSync(new URL(`../src/renderer/views/${name}`, import.meta.url), 'utf8');
const run = (source, bindings) => {
  const code = transformSync(source, { loader: 'ts' }).code;
  new Function(...Object.keys(bindings), code)(...Object.values(bindings));
};
const lazyFunction = (source, name) =>
  source.match(new RegExp(`const ${name} = \\(\\) => \\{[\\s\\S]*?^\\};`, 'm'))[0];
const mounted = (source) => source.match(/onMounted\((?:async )?\(\) => \{[\s\S]*?^\}\);/m)[0];

for (const [page, tab, count, fetch] of [
  ['details/ArtistDetail.vue', 'mvs', 'mvFetched', 'fetchMvs'],
  ['details/ArtistDetail.vue', 'albums', 'albumFetched', 'fetchMoreAlbums'],
  ['details/AlbumDetail.vue', 'comments', null, 'fetchComments'],
  ['Favorites.vue', 'videos', 'videosLoaded', 'fetchVideos'],
  ['Favorites.vue', 'singers', 'followedLoaded', 'fetchFollowed'],
]) {
  test(`${page}: mounting a restored ${tab} tab loads its content without a click`, async () => {
    const source = read(page);
    const mounts = [];
    let calls = 0;
    const bindings = {
      activeTab: ref(tab),
      isActive: ref(true),
      isLoggedIn: ref(true),
      currentUserKey: ref('1'),
      mvFetched: ref(false),
      albumFetched: ref(false),
      videosLoaded: ref(false),
      followedLoaded: ref(false),
      comments: ref([]),
      nextTick,
      onMounted: (fn) => mounts.push(fn),
      fetchData: async () => {},
      refreshFavorites: () => {},
      setupLoadMoreObserver: () => {},
      setupCommentObserver: () => {},
      [fetch]: () => {
        calls++;
      },
    };
    run(lazyFunction(source, 'loadActiveTabData') + '\n' + mounted(source), bindings);
    await mounts[0]();
    assert.equal(calls, 1);
    if (count) bindings[count].value = true;
    else bindings.comments.value = [{}];
    await mounts[0]();
    assert.equal(calls, 1);
    bindings.isActive.value = false;
    if (count) bindings[count].value = false;
    else bindings.comments.value = [];
    await mounts[0]();
    assert.equal(calls, 1);
  });
}

test('playlist comments restored by route wait for metadata and load before song pagination finishes', async () => {
  const source = read('details/PlaylistDetail.vue');
  const activeTab = ref('comments');
  const playlist = ref(null);
  const isActive = ref(true);
  let calls = 0;
  const scope = effectScope();
  scope.run(() =>
    run(
      lazyFunction(source, 'loadActiveTabData') +
        '\n' +
        source.match(/watch\(\[activeTab, playlist\], loadActiveTabData\);/)[0],
      {
        watch,
        activeTab,
        playlist,
        isActive,
        comments: ref([]),
        fetchComments: () => {
          calls++;
        },
      },
    ),
  );
  assert.equal(calls, 0);
  playlist.value = { globalCollectionId: 'collection_3_1_2_0' };
  await nextTick();
  assert.equal(calls, 1);
  isActive.value = false;
  playlist.value = { globalCollectionId: 'collection_3_1_3_0' };
  await nextTick();
  assert.equal(calls, 1);
  scope.stop();
});

for (const tab of ['classify', 'hotword']) {
  test(`song comments restore ${tab} content after the base resource finishes loading`, async () => {
    const source = read('details/SongDetail.vue');
    const mounts = [];
    let baseLoaded = false;
    let calls = 0;
    run(lazyFunction(source, 'loadActiveCommentTab') + '\n' + mounted(source), {
      activeCommentTab: ref(tab),
      isActive: ref(true),
      classifyComments: ref([]),
      hotwordComments: ref([]),
      fetchClassifyComments: () => {
        assert.equal(baseLoaded, true);
        calls++;
      },
      fetchHotwordComments: () => {
        assert.equal(baseLoaded, true);
        calls++;
      },
      onMounted: (fn) => mounts.push(fn),
      setupCommentLoadMoreObserver: () => {},
      loadCurrentResource: async () => {
        baseLoaded = true;
      },
      nextTick,
      scrollChipRowToActive: () => {},
      classifyChipRowRef: ref(null),
      hotwordChipRowRef: ref(null),
    });
    await mounts[0]();
    assert.equal(calls, 1);
  });
}

test('favorites revisions invalidate inactive data without fetching, then reload on activation', async () => {
  const source = read('Favorites.vue');
  const scope = effectScope();
  const activations = [];
  const isActive = ref(false);
  const videoCollectionStore = { revision: ref(0) };
  const revisionStore = {
    get revision() {
      return videoCollectionStore.revision.value;
    },
  };
  const videos = ref([{ id: 'stale' }]);
  const videosLoaded = ref(true);
  const requests = [];
  const bindings = {
    watch,
    videoCollectionStore: revisionStore,
    videos,
    videosLoading: ref(false),
    videosLoaded,
    videosPage: ref(2),
    videosHasMore: ref(false),
    isActive,
    isLoggedIn: ref(true),
    currentUserKey: ref('1'),
    activeTab: ref('videos'),
    followedLoaded: ref(true),
    fetchFollowed: () => assert.fail('unexpected singer request'),
    fetchVideos: (reset) => {
      requests.push(reset);
      videosLoaded.value = true;
    },
    onActivated: (callback) => activations.push(callback),
    playlistStore: { favoritesLoaded: true, favoritesLoading: false },
    refreshFavorites: () => assert.fail('unexpected song request'),
  };
  scope.run(() =>
    run(
      [
        'let videosGeneration = 0;',
        lazyFunction(source, 'resetVideos'),
        source.match(/watch\(\n  \(\) => videoCollectionStore.revision,[\s\S]*?^\);/m)[0],
        lazyFunction(source, 'loadActiveTabData'),
        source.match(/onActivated\(\(\) => \{[\s\S]*?^\}\);/m)[0],
      ].join('\n'),
      bindings,
    ),
  );
  try {
    videoCollectionStore.revision.value++;
    await nextTick();
    assert.deepEqual(requests, []);
    assert.equal(videosLoaded.value, false);
    assert.deepEqual(videos.value, []);
    isActive.value = true;
    activations[0]();
    assert.deepEqual(requests, [true]);
    activations[0]();
    assert.deepEqual(requests, [true]);
    videoCollectionStore.revision.value++;
    await nextTick();
    assert.deepEqual(requests, [true, true]);
  } finally {
    scope.stop();
  }
});
