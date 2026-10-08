import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';

const bundle = (path) => {
  const source = buildSync({
    entryPoints: [path],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  return mod.exports;
};
const mappers = bundle('src/renderer/utils/mappers/playlist.ts');
const extractors = bundle('src/renderer/utils/extractors.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const fixture = (t, name, api) => {
  const source = readFileSync(`src/renderer/views/${name}.vue`, 'utf8');
  const code = transformSync(compileScript(parse(source).descriptor, { id: name }).content, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const messages = [];
  const deps = {
    vue: { ...vue, onMounted() {} },
    '@/api/playlist': api,
    '@/api/music': api,
    '@/utils/mappers': { ...mappers, mapRankSong: (row) => row, mapTopSong: (row) => row },
    '@/utils/extractors': extractors,
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/player': { usePlayerStore: () => ({}) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/stores/theme': { useThemeStore: () => ({ sourceColor: '#cc6644' }) },
    '@/stores/toast': { useToastStore: () => ({ loadFailed: (label) => messages.push(label) }) },
    '@/utils/cover': { createThemedIconCoverUrl: () => '' },
    '@/utils/themedCover': { createThemedDateCoverUrl: (_, day) => String(day) },
    '@/composables/useStickyTabsLayout': { useStickyTabsLayout: () => ({}) },
    '@/utils/songList': { filterSongsByQuery: (rows) => rows, sortSongs: (rows) => rows },
    '@/utils/playback': {},
    '@/icons': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, `missing dependency: ${name}`);
      return deps[name];
    },
    mod,
    mod.exports,
  );
  const scope = vue.effectScope();
  const view = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  t.after(() => scope.stop());
  return { view, messages };
};

test('rank metadata reads actual catalog fields and preserves legacy frequency aliases', () => {
  const rank = mappers.mapRankMeta({
    rankid: 49223,
    rankname: '90后热歌榜',
    update_frequency: '每天',
    rank_id_publish_date: '2026-10-08 09:50:00',
    intro: '排序方式：按年龄段的喜爱热度高低排序\r\n更新频率：每天',
  });
  assert.equal(rank.updateFrequency, '每天');
  assert.equal(rank.publishTime, '2026-10-08 09:50:00');
  assert.ok(rank.description.includes('\r\n'));
  assert.equal(mappers.mapRankMeta({ updatefrequency: '每周' }).updateFrequency, '每周');
  assert.equal(mappers.mapRankMeta({}).publishTime, undefined);
});

test('daily recommendation uses response date for metadata and cover, without inventing a date', async (t) => {
  let response = {
    data: {
      creation_date: '20261008',
      song_list_size: 2,
      sub_title: '',
      song_list: [{ id: 1 }, { id: 2 }],
    },
  };
  const { view } = fixture(t, 'RecommendSongs', { getEverydayRecommend: async () => response });
  await view.fetchRecommendSongs();
  assert.equal(view.recommendDate.value, '2026-10-08');
  assert.equal(view.recommendCoverUrl.value, '8');
  assert.equal(view.songs.value.length, 2);
  response = { data: { song_list: [], sub_title: '今日发现' } };
  await view.fetchRecommendSongs();
  assert.equal(view.recommendDate.value, '');
  assert.equal(view.recommendSubtitle.value, '今日发现');
});

test('rank catalog supplements matching recommended ranks without changing their order', async (t) => {
  const { view } = fixture(t, 'Ranking', {
    getRankTop: async () => ({
      data: { list: [{ rankid: 49223, rankname: '90后热歌榜', update_frequency: '每天' }] },
    }),
    getRanks: async () => ({
      data: {
        info: [
          { rankid: 8888, rankname: 'TOP500' },
          {
            rankid: 49223,
            rankname: '90后热歌榜',
            rank_id_publish_date: '2026-10-08 09:50:00',
            intro: '榜单说明\r\n更新频率：每天',
          },
        ],
      },
    }),
    getRankSongs: async () => ({ data: { total: 500, songlist: [{ id: 1 }] } }),
  });
  await view.loadRanks();
  assert.deepEqual(
    view.ranks.value.map((r) => r.id),
    [49223],
  );
  assert.equal(view.selectedRank.value.publishTime, '2026-10-08 09:50:00');
  assert.equal(view.selectedRank.value.updateFrequency, '每天');
  assert.equal(view.rankDescription.value, '榜单说明');
  assert.equal(view.rankSongTotal.value, 500);
  assert.equal(view.songs.value.length, 1);
});

test('recommended ranks remain usable when supplemental catalog request fails', async (t) => {
  const { view, messages } = fixture(t, 'Ranking', {
    getRankTop: async () => ({
      data: { list: [{ rankid: 49223, rankname: '90后热歌榜', update_frequency: '每天' }] },
    }),
    getRanks: async () => {
      throw new Error('catalog unavailable');
    },
    getRankSongs: async () => ({ data: { total: 0, songlist: [] } }),
  });
  await view.loadRanks();
  assert.equal(view.selectedRank.value.name, '90后热歌榜');
  assert.equal(view.rankSongTotal.value, 0);
  assert.deepEqual(messages, []);
});

for (const fails of [false, true])
  test(`late old rank ${fails ? 'failure' : 'response'} cannot replace current count or loading state`, async (t) => {
    const old = deferred(),
      current = deferred();
    const { view, messages } = fixture(t, 'Ranking', {
      getRankSongs: (id) => (id === 1 ? old.promise : current.promise),
    });
    const first = view.loadRankSongs(1),
      second = view.loadRankSongs(2);
    if (fails) old.reject(new Error('old failure'));
    else old.resolve({ data: { total: 500, songlist: [{ id: 'old' }] } });
    await first;
    assert.equal(view.loadingSongs.value, true);
    assert.equal(view.rankSongTotal.value, null);
    assert.deepEqual(view.songs.value, []);
    current.resolve({ data: { total: 100, songlist: [{ id: 'current' }] } });
    await second;
    assert.equal(view.selectedRankId.value, 2);
    assert.equal(view.rankSongTotal.value, 100);
    assert.equal(view.songs.value[0].id, 'current');
    assert.equal(view.loadingSongs.value, false);
    assert.deepEqual(messages, []);
  });
