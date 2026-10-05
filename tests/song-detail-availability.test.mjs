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
    getSongRanking: async () => ({ status: 1, data: { info: [] } }),
    getSongRankingFilter: async () => ({ status: 1, data: { list: [] } }),
  };
  const dependencies = {
    vue: { ...vue, onMounted() {}, onBeforeUnmount: (fn) => unmounts.push(fn) },
    'vue-router': { useRoute: () => route, useRouter: () => ({ push() {} }) },
    '@/api/comment': {},
    '@/api/music': api,
    '@/utils/mappers': {},
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
  return { view, api, unmount: () => unmounts.forEach((fn) => fn()) };
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
