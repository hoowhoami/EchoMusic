import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { renderToString } from '@vue/server-renderer';

const require = createRequire(import.meta.url);
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const evaluate = (source, dependencies = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )(
    (id) => {
      assert.ok(id in dependencies, `Unexpected dependency ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const descriptor = parse(read('src/renderer/views/details/SongDetail.vue')).descriptor;
const script = compileScript(descriptor, { id: 'song-availability' }).content;
const render = evaluate(
  compileTemplate({
    source: descriptor.template.content,
    filename: 'SongDetail.vue',
    id: 'song-availability',
  }).code,
  { vue },
).render;
const Button = vue.defineComponent({
  setup(_, { attrs, slots }) {
    return () => vue.h('button', attrs, slots.default?.());
  },
});
const errorDescriptor = parse(read('src/renderer/components/music/DetailPageError.vue')).descriptor;
const errorComponent = evaluate(
  compileScript(errorDescriptor, {
    id: 'song-availability-error',
    inlineTemplate: true,
  }).content,
  {
    vue,
    '@/components/ui/Button.vue': Button,
    '@iconify/vue': { Icon: { render: () => null } },
    '@/icons': {},
  },
).default;
const songUtils = evaluate(read('src/renderer/utils/song.ts'));
const cover = evaluate(read('src/renderer/utils/cover.ts'), {
  '@/plugins/coverFallback': {},
  './themedCover': {},
});
const shared = evaluate(read('src/renderer/utils/mappers/shared.ts'), {
  '../cover': cover,
  '../../../shared/object': evaluate(read('src/shared/object.ts')),
});
const metadataMapping = evaluate(read('src/renderer/utils/mappers/songMetadata.ts'), {
  './shared': shared,
});
const { createSongMetadataCompleter } = evaluate(read('src/renderer/services/songMetadata.ts'), {
  '@/api/music': {},
  '@/utils/mappers/songMetadata': metadataMapping,
  '@/utils/mappers/shared': shared,
  '@/utils/logger': { warn() {} },
});
const shareUtils = evaluate(read('src/renderer/utils/share.ts'), {
  '@/stores/user': {},
  '@/utils/mappers/shared': shared,
  '../../shared/share': evaluate(read('src/shared/share.ts')),
});
const hash = 'A'.repeat(32);
const songRecord = { base: { album_audio_id: 123, songname: '真实歌曲' }, hash };

function fixture(t, query = {}, id = '123') {
  const scope = vue.effectScope();
  const unmounts = [];
  t.after(() => {
    unmounts.forEach((fn) => fn());
    scope.stop();
  });
  const route = { params: { id }, query: { type: 'music', hash, ...query } };
  const api = {
    getSongPrivilegeLite: async () => ({ status: 1, data: [{}] }),
    getSongMetadata: async () => ({ status: 1, data: [] }),
    getSongRanking: async () => ({ status: 1, data: { info: [] } }),
    getSongRankingFilter: async () => ({ status: 1, data: { list: [] } }),
  };
  const pushes = [];
  const completeSongMetadata = createSongMetadataCompleter({
    fetch: (ids) => api.getSongMetadata(ids),
    now: Date.now,
  });
  const dependencies = {
    vue: { ...vue, onMounted() {}, onBeforeUnmount: (fn) => unmounts.push(fn) },
    'vue-router': {
      useRoute: () => route,
      useRouter: () => ({ push: (value) => pushes.push(value) }),
    },
    '@/api/comment': {},
    '@/api/music': api,
    '@/utils/mappers': {},
    '@/utils/mappers/shared': shared,
    '@/utils/mappers/songMetadata': metadataMapping,
    '@/services/songMetadata': { completeSongMetadata },
    '@/utils/commentVipCache': {},
    '@/utils/song': songUtils,
    '@/utils/playback': {},
    '@/utils/share': { isSongHashId: (id) => /^[a-f\d]{32}$/i.test(id) },
    '@/icons': {},
    '@/composables/usePageScroll': { useScrollContainer: () => vue.ref(null) },
    '@/composables/useStickyTabsLayout': {
      useStickyTabsLayout: () => ({ tabsTop: vue.ref(0), tabsMinHeight: vue.ref(0) }),
    },
    '@/composables/useRouteTabs': {
      useRouteTabs: () => ({
        state: { tab: vue.ref('detail'), commentTab: vue.ref('all') },
        select() {},
        isActive: vue.ref(true),
      }),
    },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/stores/toast': { useToastStore: () => ({}) },
    '@/stores/playlist': {
      usePlaylistStore: () => ({ playbackQueueList: [], getCreatedPlaylists: () => [] }),
      isTransientPlaybackQueue: () => false,
    },
    '@/stores/player': { usePlayerStore: () => ({}) },
    '@/stores/user': { useUserStore: () => ({}) },
  };
  for (const name of script.matchAll(/from ['"]([^'"]+\.vue)['"]/g)) dependencies[name[1]] = {};
  const component = evaluate(script, dependencies).default;
  const view = scope.run(() => component.setup({}, { expose() {} }));
  return { view, api, pushes, unmount: () => unmounts.forEach((fn) => fn()) };
}

async function renderView(view) {
  const wrapper = vue.defineComponent({
    setup(_, { slots }) {
      return () => vue.h('div', slots.default?.());
    },
  });
  const header = vue.defineComponent({
    props: ['title'],
    setup(props, { slots }) {
      return () =>
        vue.h('header', { 'data-song-header': '' }, [
          props.title,
          slots.details?.(),
          slots.actions?.(),
        ]);
    },
  });
  const actions = { render: () => vue.h('div', { 'data-song-actions': '' }, '播放 添加到 分享') };
  const app = vue.createSSRApp({ setup: () => ({ ...view }), render });
  const visit = (node) => {
    if (node.type === 1 && /^[A-Z]/.test(node.tag))
      app.component(
        node.tag,
        node.tag === 'DetailPageError'
          ? errorComponent
          : node.tag === 'SliverHeader'
            ? header
            : node.tag === 'ActionRow'
              ? actions
              : node.tag === 'Button'
                ? Button
                : wrapper,
      );
    node.children?.forEach(visit);
  };
  visit(descriptor.template.ast);
  return renderToString(app);
}

for (const data of [undefined, null, [], {}, [{}], [{ privilege: 8 }]]) {
  test(`empty song detail ${JSON.stringify(data)} shows retry without a fabricated song`, async (t) => {
    const f = fixture(t);
    f.api.getSongPrivilegeLite = async () => ({ status: 1, data });
    await f.view.fetchDetailData();
    assert.equal(f.view.detailLoading.value, false);
    assert.equal(f.view.detailSong.value, null);
    assert.equal(f.view.actionSong.value, null);
    const html = await renderView(f.view);
    assert.ok(html.includes('暂时无法加载歌曲'));
    assert.ok(html.includes('重新加载'));
    assert.ok(!html.includes('data-song-header'));
    assert.ok(!html.includes('data-song-actions'));
    assert.ok(!html.includes('未知歌曲'));
  });
}

test('retry recovers real base.songname metadata without requiring quality or ranking data', async (t) => {
  const f = fixture(t);
  await f.view.fetchDetailData();
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [songRecord] });
  await f.view.fetchDetailData();
  assert.equal(f.view.detailSong.value.name, '真实歌曲');
  assert.equal(f.view.canUseSongActions.value, true);
  assert.equal(f.view.hasDetailContent.value, false);
  const html = await renderView(f.view);
  assert.ok(html.includes('data-song-header'));
  assert.ok(html.includes('data-song-actions'));
  assert.ok(!html.includes('暂时无法加载歌曲'));
});

for (const response of [
  { status: 1, data: [{}] },
  { status: 1, data: [{ privilege: 8 }] },
]) {
  test(`an empty refresh preserves loaded song metadata: ${JSON.stringify(response)}`, async (t) => {
    const f = fixture(t);
    f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [songRecord] });
    await f.view.fetchDetailData();
    const previous = f.view.detailSong.value;
    f.api.getSongPrivilegeLite = async () => response;
    await f.view.fetchDetailData();
    assert.equal(f.view.detailSong.value, previous);
    const html = await renderView(f.view);
    assert.ok(html.includes('真实歌曲'));
    assert.ok(html.includes('data-song-actions'));
    assert.ok(html.includes('暂时无法加载部分歌曲详情'));
  });
}

test('known route metadata remains available when supplemental detail is empty', async (t) => {
  const f = fixture(t, { title: '已知歌曲', artist: '歌手' });
  await f.view.fetchDetailData();
  assert.equal(f.view.canUseSongActions.value, true);
  const html = await renderView(f.view);
  assert.ok(html.includes('已知歌曲'));
  assert.ok(html.includes('data-song-header'));
  assert.ok(html.includes('暂时无法加载部分歌曲详情'));
});

test('numeric-ID-only navigation does not render an empty header after empty rankings', async (t) => {
  const f = fixture(t, { hash: undefined });
  await f.view.fetchDetailData();
  const html = await renderView(f.view);
  assert.ok(html.includes('暂时无法加载歌曲'));
  assert.ok(!html.includes('data-song-header'));
});

test('initial loading hides the empty header until metadata is available', async (t) => {
  const f = fixture(t);
  assert.equal(f.view.detailLoading.value, true);
  const html = await renderView(f.view);
  assert.ok(!html.includes('data-song-header'));
  assert.ok(!html.includes('重新加载'));
});

test('a failed optional ranking request preserves a valid song and offers partial retry', async (t) => {
  const f = fixture(t);
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [songRecord] });
  f.api.getSongRanking = async () => {
    throw new Error('offline');
  };
  await f.view.fetchDetailData();
  const html = await renderView(f.view);
  assert.ok(html.includes('真实歌曲'));
  assert.ok(html.includes('data-song-actions'));
  assert.ok(html.includes('暂时无法加载部分歌曲详情'));
});

test('whitespace titles do not make a song available', async (t) => {
  const f = fixture(t, { title: '   ' });
  await f.view.fetchDetailData();
  assert.equal(f.view.actionSong.value, null);
  assert.ok((await renderView(f.view)).includes('暂时无法加载歌曲'));
});

test('a blank route title does not hide a real name returned by the detail API', async (t) => {
  const f = fixture(t, { title: '  ' });
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [songRecord] });
  await f.view.fetchDetailData();
  assert.equal(f.view.hasSongContent.value, true);
  assert.ok((await renderView(f.view)).includes('真实歌曲'));
});

test('unmount prevents an old response from replacing the unavailable state', async (t) => {
  const f = fixture(t);
  let resolve;
  f.api.getSongPrivilegeLite = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = f.view.fetchDetailData();
  f.unmount();
  const ranking = t.mock.method(f.api, 'getSongRanking');
  resolve({ status: 1, data: [songRecord] });
  await pending;
  assert.equal(f.view.detailSong.value, null);
  assert.equal(ranking.mock.callCount(), 0);
});

test('album and playlist comment routes retain their existing header', async (t) => {
  for (const type of ['album', 'playlist']) {
    const f = fixture(t, { type, title: '评论资源' });
    assert.ok((await renderView(f.view)).includes('data-song-header'));
  }
});

// Selected fields from live /privilege/lite and /krm/audio responses, 2026-10-12.
const sharedSongRecord = {
  album_id: '0',
  album_audio_id: 573072668,
  hash: '550E95D9C5F2D96B9E12B837CD331ECD',
  name: '王新阳 - 每个人都有精神寄托',
  singername: '王新阳',
  albumname: '也许太久没有看过桃花',
  info: {
    duration: 361639,
    image: 'http://imge.kugou.com/stdmusic/{size}/20231124/20231124171001758251.jpg',
  },
};
const sharedSongMetadata = {
  __status: 1,
  base: { album_audio_id: 573072668, album_id: 80678641 },
  album_info: { album_id: 80678641, album_name: '也许太久没有看过桃花' },
  authors: [{ base: { author_id: 10002646, author_name: '王新阳' } }],
};

test('a hash-only share resolves real artist and album links through album_audio_id', async (t) => {
  const f = fixture(
    t,
    { hash: sharedSongRecord.hash, artistId: '0', albumId: '0', cover: '' },
    sharedSongRecord.hash,
  );
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [sharedSongRecord] });
  const requests = [];
  f.api.getSongMetadata = async (ids) => {
    requests.push(ids);
    return { status: 1, data: [sharedSongMetadata] };
  };
  await f.view.fetchDetailData();
  assert.deepEqual(requests, [['573072668']]);
  assert.equal(f.view.songArtistId.value, 10002646);
  assert.equal(f.view.songAlbumId.value, '80678641');
  assert.equal(f.view.canOpenArtist.value, true);
  assert.equal(f.view.canOpenAlbum.value, true);
  assert.equal(f.view.actionSong.value.albumAudioId, '573072668');
  assert.equal(f.view.actionSong.value.duration, 361);
  assert.ok(f.view.resourceCover.value.includes('/400/'));
  f.view.openArtistDetail();
  f.view.openAlbumDetail();
  assert.deepEqual(f.pushes, [
    { name: 'artist-detail', params: { id: '10002646' } },
    { name: 'album-detail', params: { id: '80678641' } },
  ]);
});

test('metadata supplies all authors even when privilege only has a combined singer name', async (t) => {
  const f = fixture(t, { hash: sharedSongRecord.hash }, sharedSongRecord.hash);
  f.api.getSongPrivilegeLite = async () => ({
    status: 1,
    data: [{ ...sharedSongRecord, singername: '歌手甲、歌手乙' }],
  });
  f.api.getSongMetadata = async () => ({
    status: 1,
    data: [
      {
        ...sharedSongMetadata,
        authors: [
          { base: { author_id: 111, author_name: '歌手甲' } },
          { base: { author_id: 222, author_name: '歌手乙' } },
        ],
      },
    ],
  });
  await f.view.fetchDetailData();
  assert.deepEqual(
    f.view.detailSong.value.artists.map(({ id, name }) => ({ id, name })),
    [
      { id: '111', name: '歌手甲' },
      { id: '222', name: '歌手乙' },
    ],
  );
  assert.equal(f.view.songArtistId.value, 111);
});

test('a missing metadata response preserves names, playback identity and known artists', async (t) => {
  const f = fixture(t, { hash: sharedSongRecord.hash }, sharedSongRecord.hash);
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [sharedSongRecord] });
  f.api.getSongMetadata = async () => {
    throw new Error('offline');
  };
  await f.view.fetchDetailData();
  assert.equal(f.view.canUseSongActions.value, true);
  assert.equal(f.view.detailSong.value.hash, sharedSongRecord.hash);
  assert.equal(f.view.detailSong.value.mixSongId, '573072668');
  assert.equal(f.view.detailSong.value.artists[0].name, '王新阳');
  assert.equal(f.view.canOpenArtist.value, false);
  assert.equal(f.view.canOpenAlbum.value, false);
});

test('ordinary audio_id is never used to join song metadata', async (t) => {
  const f = fixture(t);
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [{ name: '歌曲', audio_id: 987 }] });
  const metadata = t.mock.method(f.api, 'getSongMetadata');
  await f.view.fetchDetailData();
  assert.equal(metadata.mock.callCount(), 0);
});

test('unmount rejects a late metadata completion', async (t) => {
  const f = fixture(t, { hash: sharedSongRecord.hash }, sharedSongRecord.hash);
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [sharedSongRecord] });
  let resolve;
  f.api.getSongMetadata = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.view.fetchDetailData();
  while (!resolve) await Promise.resolve();
  const original = f.view.detailSong.value;
  f.unmount();
  resolve({ status: 1, data: [sharedSongMetadata] });
  await pending;
  assert.equal(f.view.detailSong.value, original);
  assert.equal(f.view.canOpenArtist.value, false);
  assert.equal(f.view.canOpenAlbum.value, false);
});

test('new song shares preserve album context and discard zero IDs', () => {
  const song = {
    hash,
    name: '歌曲',
    albumId: 80678641,
    albumAudioId: 573072668,
    mixSongId: 573072668,
  };
  const target = shareUtils.createSongShareTarget(song);
  assert.deepEqual(target.query, { albumId: '80678641', albumAudioId: '573072668' });
  const route = shareUtils.buildShareResolveRoute(target);
  assert.deepEqual(shareUtils.readShareDetailQuery(route.query), target.query);
  assert.equal(
    shareUtils.createSongShareTarget({ ...song, albumId: '0', albumAudioId: 0, mixSongId: 0 })
      .query,
    undefined,
  );
});

test('share resolution carries album_audio_id but never treats album_id zero as a real album', async (t) => {
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const descriptor = parse(read('src/renderer/views/ShareResolve.vue')).descriptor;
  const source = compileScript(descriptor, { id: 'shared-song-metadata' }).content;
  const replacements = [];
  const component = evaluate(source, {
    vue: { ...vue, onMounted() {}, onBeforeUnmount() {} },
    'vue-router': {
      useRoute: () => ({ query: { type: 'song', id: sharedSongRecord.hash } }),
      useRouter: () => ({ replace: (route) => replacements.push(route) }),
    },
    '@/api/album': {},
    '@/api/artist': {},
    '@/api/listenTogether': {},
    '@/api/playlist': {},
    '@/api/music': { getSongPrivilegeLite: async () => ({ status: 1, data: [sharedSongRecord] }) },
    '@/components/ui/Button.vue': {},
    '@/icons': {},
    '@/utils/extractors': {},
    '@/utils/mappers': {},
    '@/utils/mappers/shared': shared,
    '@/utils/share': shareUtils,
    '@/utils/listenTogether': {},
    '@/utils/logger': {},
    '../../shared/share': evaluate(read('src/shared/share.ts')),
    '../../shared/object': evaluate(read('src/shared/object.ts')),
  }).default;
  const view = scope.run(() => component.setup({}, { expose() {} }));
  assert.equal(await view.resolveSong(sharedSongRecord.hash), true);
  assert.equal(replacements[0].query.albumAudioId, '573072668');
  assert.equal(replacements[0].query.albumId, '');
  assert.equal(replacements[0].query.artistId, '');
  const f = fixture(t, replacements[0].query, replacements[0].params.id);
  f.api.getSongPrivilegeLite = async () => ({ status: 1, data: [sharedSongRecord] });
  f.api.getSongMetadata = async () => ({ status: 1, data: [sharedSongMetadata] });
  await f.view.fetchDetailData();
  assert.equal(f.view.songArtistId.value, 10002646);
  assert.equal(f.view.songAlbumId.value, '80678641');
  assert.equal(f.view.songTitle.value, '每个人都有精神寄托');
});
