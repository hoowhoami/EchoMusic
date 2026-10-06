import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compileScript, parse } from 'vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

function setup(t, file, props = {}, dependencies = {}) {
  const descriptor = parse(
    readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8'),
  ).descriptor;
  const script = transformSync(compileScript(descriptor, { id: 'tab-consumer' }).content, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', script)(
    (id) =>
      dependencies[id] ??
      (id === 'vue' ? { ...vue, onMounted() {}, useModel: () => vue.ref(false) } : {}),
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  return scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }));
}
const flush = async () => {
  await vue.nextTick();
  await new Promise(setImmediate);
};

test('Home category tabs reload the selected API category and ignore an obsolete response', async (t) => {
  const requests = [];
  const view = setup(
    t,
    'views/Home.vue',
    {},
    {
      'vue-router': { useRouter: () => ({ push() {} }) },
      '@/stores/user': { useUserStore: () => ({ isLoggedIn: false }) },
      '@/stores/setting': { useSettingStore: () => ({}) },
      '@/stores/playlist': { usePlaylistStore: () => ({}) },
      '@/stores/player': { usePlayerStore: () => ({}) },
      '@/stores/toast': { useToastStore: () => ({}) },
      '@/api/playlist': {
        getPlaylistByCategory: (id) => new Promise((resolve) => requests.push({ id, resolve })),
      },
      '@/utils/extractors': { extractList: (value) => value },
      '@/utils/mappers': { mapPlaylistMeta: (value) => value },
    },
  );
  view.selectRecommendCategoryTab(1);
  assert.equal(requests[0].id, '11292');
  view.selectRecommendCategoryTab(0);
  assert.equal(requests[1].id, '0');
  requests[1].resolve([{ id: 'current' }]);
  await flush();
  requests[0].resolve([{ id: 'obsolete' }]);
  await flush();
  assert.equal(view.activeRecommendCategoryId.value, '0');
  assert.deepEqual(view.recommendedPlaylists.value, [{ id: 'current' }]);
  view.selectRecommendCategoryTab(9);
  assert.equal(requests.length, 2);
  view.styleGroups.value = [
    { name: '语种', child: [] },
    { name: '风格', child: [] },
  ];
  view.selectStyleGroupTab(1);
  assert.equal(view.activeStyleGroupName.value, '风格');
  view.styleGroups.value.reverse();
  view.selectStyleGroupTab(1);
  assert.equal(view.activeStyleGroupName.value, '语种');
});

test('Effect plaza category/sort tabs keep stable API values and invoke the existing selection actions', (t) => {
  const calls = [];
  const plaza = vue.reactive({
    category: 'artist',
    marketSort: 2,
    currentPage: {},
    pageKey: '',
    selectCategory(value) {
      calls.push(['category', value]);
      this.category = value;
    },
    selectSort(value) {
      calls.push(['sort', value]);
      this.marketSort = value;
    },
  });
  const view = setup(t, 'components/player/EffectPlaza.vue', { plaza });
  view.selectCategoryTab(2);
  view.selectSortTab(1);
  assert.deepEqual(calls, [
    ['category', 'market'],
    ['sort', 3],
  ]);
  assert.equal(view.description.value, '发现创作者的调音作品，收藏不同的听感');
  view.selectCategoryTab(-1);
  view.selectSortTab(9);
  assert.equal(calls.length, 2);
});

test('Barrage single-value tabs persist to the correct lyric/video configuration', (t) => {
  const settings = vue.reactive({
    lyricBarrageConfig: { density: 2, area: 50 },
    mvBarrageConfig: { density: 2, area: 50 },
  });
  const dependencies = {
    '@/stores/setting': { useSettingStore: () => settings },
    '@/utils/kugouVerification': { kugouVerificationState: vue.reactive({ open: false }) },
    '@/composables/useCommentSubmission': { useCommentSubmission: () => ({ submitComment() {} }) },
  };
  const lyric = setup(
    t,
    'components/music/BarrageControls.vue',
    { variant: 'lyric', resource: {} },
    dependencies,
  );
  const video = setup(t, 'components/music/BarrageControls.vue', { resource: {} }, dependencies);
  lyric.selectDensity(2);
  lyric.selectArea(0);
  video.selectDensity(0);
  video.selectArea(2);
  assert.deepEqual(settings.lyricBarrageConfig, { density: 3, area: 25 });
  assert.deepEqual(settings.mvBarrageConfig, { density: 1, area: 100 });
  lyric.selectArea(9);
  video.selectDensity(-1);
  assert.equal(settings.lyricBarrageConfig.area, 25);
  assert.equal(settings.mvBarrageConfig.density, 1);
});
