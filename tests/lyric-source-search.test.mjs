import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as offset from '../src/shared/lyricOffset.ts';
import * as persistence from '../src/shared/storePersistence.ts';
import * as opencc from '../src/shared/opencc.ts';
import { createEmbeddedMetadataCompleter } from '../src/renderer/stores/player/embeddedMetadata.ts';

const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const compile = (source, mocks, runtimeWindow) => {
  const module = { exports: {} };
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in mocks, `Unexpected dependency ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    runtimeWindow,
  );
  return module.exports;
};
const read = (path) => readFileSync(new URL(`../src/renderer/${path}`, import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((done) => setImmediate(done));
const candidate = (id) => ({
  id,
  accesskey: `access-${id}`,
  song: '真实歌名',
  singer: '真实歌手',
  score: 80,
});
function storeFixture(api = {}, resolvePluginLyric = async () => null) {
  const lyric = compile(read('stores/lyric.ts'), {
    pinia,
    '@/api/music': {
      searchLyric: async () => ({ candidates: [] }),
      getLyric: async () => ({ decodeContent: '[00:01.00]测试歌词' }),
      ...api,
    },
    '@/utils/logger': { warn() {}, error() {} },
    '@/utils/color': { DEFAULT_ACCENT: '#b00000', getNormalizedAccent: (x) => x },
    '@/plugins/lyrics': { resolvePluginLyric },
    '@/services/opencc': { convertLyricLinesForDisplay: async (lines) => lines },
    './theme': { useThemeStore: () => ({}) },
    '../../shared/lyricOffset': offset,
    '../../shared/embeddedMetadata': embeddedTags,
    '../../shared/opencc': opencc,
  });
  return { store: lyric.useLyricStore(pinia.createPinia()), ...lyric };
}

test('renderer and server forward keywords without hash or album id; hash lookup retains metadata', async () => {
  const calls = [];
  const api = compile(read('api/music.ts'), {
    '@/utils/request': {
      get: async (url, config) => {
        calls.push({ url, ...config });
        return config;
      },
    },
    './user': {},
    '@/stores/user': {},
    '@/utils/userSession': {},
    '@/utils/serverInterceptors': {},
  });
  await api.searchLyric({ keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'yes' });
  assert.deepEqual(calls[0], {
    url: '/search/lyric',
    params: { keywords: '真实歌手 - 真实歌名', man: 'yes', duration: 180000 },
  });
  await api.searchLyric({ hash: 'cloud-hash', albumAudioId: 42, duration: 180000 });
  assert.deepEqual(calls[1].params, {
    hash: 'cloud-hash',
    album_audio_id: 42,
    duration: 180000,
    man: 'no',
  });
  const server = { exports: {} };
  new Function('require', 'module', readFileSync('server/module/search_lyric.js', 'utf8'))(
    () => ({ appid: 1, clientver: 1 }),
    server,
  );
  const request = server.exports(calls[0].params, (config) => config);
  assert.equal(request.params.keyword, '真实歌手 - 真实歌名');
  assert.equal(request.params.hash, '');
  assert.equal(request.params.album_audio_id, 0);
});

test('keyword search handles title-only/artist-only, trims input, and preserves automatic candidates', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (query) => {
      calls.push(query);
      return { data: { candidates: [candidate('custom')] } };
    },
  });
  store.candidateHash = 'cloud';
  store.candidates = [candidate('auto')];
  store.autoCandidateKey = 'auto:access-auto';
  assert.equal(
    (
      await store.searchLyricCandidates({
        title: '  真实歌名 ',
        artist: ' 真实歌手 ',
        duration: 180000,
      })
    )[0].id,
    'custom',
  );
  await store.searchLyricCandidates({ title: '歌名', artist: '' });
  await store.searchLyricCandidates({ title: '', artist: '歌手' });
  assert.deepEqual(await store.searchLyricCandidates({ title: ' ', artist: '\n' }), []);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'yes' });
  assert.deepEqual(
    calls.slice(1).map((q) => q.keywords),
    ['歌名', '歌手'],
  );
  assert.equal(store.candidateHash, 'cloud');
  assert.equal(store.candidates[0].id, 'auto');
  assert.equal(store.autoCandidateKey, 'auto:access-auto');
  assert.deepEqual(store.manualLyricMap, {});
});

test('custom results preview, apply and persist against the original cloud hash', async () => {
  const { store } = storeFixture();
  const selected = candidate('custom-apply');
  assert.equal((await store.previewCandidate(selected)).lines[0].text, '测试歌词');
  assert.equal(
    await store.applyCandidate('original-cloud-hash', selected, { remember: true }),
    true,
  );
  assert.equal(store.loadedHash, 'original-cloud-hash');
  assert.equal(store.lines[0].text, '测试歌词');
  assert.equal(store.manualLyricMap['original-cloud-hash'].id, selected.id);
  assert.equal(store.currentCandidateKey, 'custom-apply:access-custom-apply');
  assert.deepEqual(Object.keys(store.manualLyricMap), ['original-cloud-hash']);
});

test('late apply cannot replace lyrics or remember a selection after switching tracks', async () => {
  const pending = deferred();
  const { store } = storeFixture({ getLyric: () => pending.promise });
  const applying = store.applyCandidate('old-song', candidate('late'), { remember: true });
  store.clear('new-song');
  pending.resolve({ decodeContent: '[00:01.00]旧歌词' });
  assert.equal(await applying, false);
  assert.equal(store.loadedHash, 'new-song');
  assert.deepEqual(store.manualLyricMap, {});
});

test('overlapping automatic searches keep the latest song cache and return ordered results', async () => {
  const old = deferred();
  const { store } = storeFixture({
    searchLyric: async (q) => {
      if (q.hash === 'old' && q.man === 'yes') return old.promise;
      return {
        candidates:
          q.man === 'yes'
            ? [candidate(`${q.hash}-other`), candidate(`${q.hash}-best`)]
            : [candidate(`${q.hash}-best`)],
      };
    },
  });
  const first = store.fetchLyricCandidates('old');
  const result = await store.fetchLyricCandidates('new');
  assert.equal(result[0].id, 'new-best');
  old.resolve({ candidates: [candidate('old-best')] });
  await first;
  assert.equal(store.candidateHash, 'new');
  assert.equal(store.candidates[0].id, 'new-best');
});

function dialogFixture(t, overrides = {}, propOverrides = {}) {
  const notices = [],
    unmounts = [];
  const store = vue.reactive({
    candidates: [],
    autoCandidateKey: '',
    candidatePreviewMap: {},
    currentCandidateKey: '',
    manualLyricMap: {},
    embeddedLyricSelectionMap: {},
    previewEmbeddedLyric: (content) => ({ lines: [], rawLyric: content, hasTranslation: false, hasRomanization: false }),
    fetchLyricCandidates: async () => [candidate('auto')],
    searchLyricCandidates: async () => [candidate('custom')],
    previewCandidate: async () => ({
      lines: [],
      rawLyric: '预览',
      hasTranslation: false,
      hasRomanization: false,
    }),
    ...overrides,
  });
  const { descriptor } = parse(read('views/lyric/LyricSourceDialog.vue'));
  const component = compile(compileScript(descriptor, { id: 'lyric-source-search' }).content, {
    vue: { ...vue, useId: () => 'search', onBeforeUnmount: (fn) => unmounts.push(fn) },
    '@vueuse/core': { useVModel: (props, key) => vue.toRef(props, key) },
    '@/components/ui/tooltip': { vTooltip: {} },
    '@/stores/lyric': {
      useLyricStore: () => store,
      getLyricCandidateKey: (c) => `${c.id}:${c.accesskey}`,
    },
    '@/stores/player': { usePlayerStore: () => ({ currentTime: 0 }) },
    '@/stores/toast': {
      useToastStore: () => ({
        loadFailed: (x) => notices.push(x),
        actionFailed: (x) => notices.push(x),
        success: (x) => notices.push(x),
      }),
    },
    '@/icons': {},
    '../../../shared/embeddedMetadata': embeddedTags,
  });
  const props = vue.reactive({
    open: true,
    hash: 'cloud',
    title: '**',
    artist: '**',
    duration: 180,
    albumAudioId: 7,
    ...propOverrides,
  });
  const scope = vue.effectScope();
  const view = scope.run(() => component.default.setup(props, { expose() {}, emit() {} }));
  t.after(() => {
    unmounts.forEach((fn) => fn());
    scope.stop();
  });
  return { view, store, props, notices };
}

test('dialog defaults censored metadata, submits edits and resets to hash matching', async (t) => {
  const calls = [];
  const f = dialogFixture(t, {
    searchLyricCandidates: async (q) => {
      calls.push(q);
      return [candidate('custom')];
    },
  });
  await flush();
  assert.equal(f.view.searchTitle.value, '**');
  assert.equal(f.view.searchArtist.value, '**');
  f.view.searchTitle.value = '真实歌名';
  f.view.searchArtist.value = '真实歌手';
  await f.view.loadCandidates('keywords');
  await flush();
  assert.deepEqual(calls, [{ title: '真实歌名', artist: '真实歌手', duration: 180000 }]);
  assert.equal(f.view.selectedCandidate.value.id, 'custom');
  assert.equal(f.view.autoCandidateKey.value, '');
  f.view.resetSearch();
  await flush();
  assert.equal(f.view.searchTitle.value, '**');
  assert.equal(f.view.selectedCandidate.value.id, 'auto');
});

test('latest search wins and stale automatic response cannot replace keyword results', async (t) => {
  const auto = deferred(),
    first = deferred(),
    second = deferred();
  let n = 0;
  const f = dialogFixture(t, {
    fetchLyricCandidates: () => auto.promise,
    searchLyricCandidates: () => (++n === 1 ? first : second).promise,
  });
  const a = f.view.loadCandidates('keywords'),
    b = f.view.loadCandidates('keywords');
  second.resolve([candidate('second')]);
  await b;
  first.resolve([candidate('first')]);
  await a;
  auto.resolve([candidate('auto')]);
  await flush();
  assert.equal(f.view.selectedCandidate.value.id, 'second');
  assert.equal(f.view.isLoading.value, false);
});

test('starting a new search invalidates an outstanding lyric preview, even with no results', async (t) => {
  const preview = deferred();
  const f = dialogFixture(t, {
    previewCandidate: () => preview.promise,
    searchLyricCandidates: async () => [],
  });
  await flush();
  assert.equal(f.view.previewLoading.value, true);
  await f.view.loadCandidates('keywords');
  await flush();
  preview.resolve({ lines: [], rawLyric: '不应显示旧歌词' });
  await flush();
  assert.deepEqual(f.view.previewStaticLines.value, []);
  assert.equal(f.view.previewLoading.value, false);
  assert.equal(f.view.selectedCandidate.value, null);
});

test('failed/empty searches clear old candidates and allow retry; close and track changes invalidate requests', async (t) => {
  const pending = deferred();
  const f = dialogFixture(t);
  await flush();
  f.store.searchLyricCandidates = async () => {
    throw Error('offline');
  };
  await f.view.loadCandidates('keywords');
  assert.match(f.view.searchError.value, /搜索失败/);
  assert.equal(f.view.selectedCandidate.value, null);
  f.store.searchLyricCandidates = () => pending.promise;
  const searching = f.view.loadCandidates('keywords');
  f.props.open = false;
  await flush();
  pending.resolve([candidate('closed')]);
  await searching;
  assert.equal(f.view.candidates.value.length, 0);
  f.props.hash = 'new';
  f.props.title = '新歌';
  f.props.open = true;
  await flush();
  assert.equal(f.view.searchTitle.value, '新歌');
  assert.equal(f.view.selectedCandidate.value.id, 'auto');
});

test('reopening includes an applied custom version missing from hash results', async (t) => {
  const f = dialogFixture(t, { manualLyricMap: { cloud: candidate('remembered') } });
  await flush();
  assert.equal(f.view.selectedCandidate.value.id, 'remembered');
});

const matchOptions = { title: '真实歌名', artist: '真实歌手', duration: 180000, albumAudioId: 42 };

test('automatic lookup stops at a usable hash match', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return { candidates: [candidate('hash-match')] };
    },
  });
  assert.equal((await store.resolveDefaultLyricTarget('hit', matchOptions)).id, 'hash-match');
  assert.deepEqual(calls, [{ hash: 'hit', duration: 180000, albumAudioId: 42, man: 'no' }]);
});

test('automatic lookup falls back only after no usable hash match, without hash or album metadata', async () => {
  for (const candidates of [[], [{ id: 'missing-key' }]]) {
    const calls = [];
    const { store } = storeFixture({
      searchLyric: async (q) => {
        calls.push(q);
        return q.keywords ? { data: { info: [candidate('keywords-match')] } } : { candidates };
      },
    });
    assert.equal(
      (await store.resolveDefaultLyricTarget('miss', matchOptions)).id,
      'keywords-match',
    );
    assert.deepEqual(calls, [
      { hash: 'miss', duration: 180000, albumAudioId: 42, man: 'no' },
      { keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'no' },
    ]);
  }
});

test('automatic lookup supports title alone, skips absent titles, and stops when keywords also miss', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return { candidates: [] };
    },
  });
  assert.equal(await store.resolveDefaultLyricTarget('no-results', { title: ' 歌名 ' }), null);
  assert.deepEqual(
    calls.map((q) => q.keywords ?? q.hash),
    ['no-results', '歌名'],
  );
  for (const title of [undefined, '', '  ']) {
    calls.length = 0;
    assert.equal(
      await store.resolveDefaultLyricTarget('no-title', { title, artist: '歌手' }),
      null,
    );
    assert.deepEqual(
      calls.map((q) => q.keywords ?? q.hash),
      ['no-title'],
    );
  }
});

test('network failure does not trigger an automatic keyword request', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      throw Error('offline');
    },
  });
  await assert.rejects(store.resolveDefaultLyricTarget('network-error', matchOptions), /offline/);
  assert.equal(calls.length, 1);
});

test('playback uses track metadata for fallback, caches automatic lyrics under original hash, and keeps manual preferences empty', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return { candidates: q.keywords ? [candidate('playback-fallback')] : [] };
    },
  });
  const options = {
    track: { title: '真实歌名', artist: '真实歌手', source: 'cloud', albumAudioId: 42 },
    duration: 180000,
  };
  await store.fetchLyrics('playback-fallback-original', options);
  assert.deepEqual(calls, [
    { hash: 'playback-fallback-original', albumAudioId: 42, duration: 180000, man: 'no' },
    { keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'no' },
  ]);
  assert.equal(store.loadedHash, 'playback-fallback-original');
  assert.equal(store.currentCandidateKey, 'playback-fallback:access-playback-fallback');
  assert.equal(store.lines[0].text, '测试歌词');
  assert.deepEqual(store.manualLyricMap, {});
  store.clear();
  await store.fetchLyrics('playback-fallback-original', options);
  assert.equal(calls.length, 2, 'cached auto result should avoid another lookup');
  assert.equal(store.lines[0].text, '测试歌词');
});

test('remembered lyrics take priority over automatic matching, and restoring automatic mode also supports fallback', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return { candidates: q.keywords ? [candidate('restored-auto')] : [] };
    },
  });
  store.manualLyricMap['restore-fallback'] = candidate('remembered-priority');
  await store.fetchLyrics('restore-fallback', { ...matchOptions, force: true });
  assert.equal(calls.length, 0);
  assert.equal(store.currentCandidateKey, 'remembered-priority:access-remembered-priority');
  await store.restoreAutoLyric('restore-fallback', matchOptions);
  assert.deepEqual(
    calls.map((q) => q.keywords ?? q.hash),
    ['restore-fallback', '真实歌手 - 真实歌名'],
  );
  assert.equal(store.currentCandidateKey, 'restored-auto:access-restored-auto');
  assert.deepEqual(store.manualLyricMap, {});
});

test('candidate fallback recommends from the keyword query and does not repeat a missed hash request', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return {
        candidates: q.hash
          ? []
          : q.man === 'yes'
            ? [candidate('other'), candidate('best')]
            : [candidate('best')],
      };
    },
  });
  const result = await store.fetchLyricCandidates('candidate-fallback', matchOptions);
  assert.deepEqual(
    result.map((c) => c.id),
    ['best', 'other'],
  );
  assert.deepEqual(calls, [
    { hash: 'candidate-fallback', duration: 180000, albumAudioId: 42, man: 'yes' },
    { keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'yes' },
    { keywords: '真实歌手 - 真实歌名', duration: 180000, man: 'no' },
  ]);
  assert.equal(store.candidateHash, 'candidate-fallback');
  assert.equal(store.autoCandidateKey, 'best:access-best');
  assert.deepEqual(store.manualLyricMap, {});
  await store.fetchLyricCandidates('candidate-fallback', matchOptions);
  assert.equal(calls.length, 3);
});

test('empty keyword candidates stop without a redundant default lookup', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return { candidates: [] };
    },
  });
  assert.deepEqual(await store.fetchLyricCandidates('empty-fallback', matchOptions), []);
  assert.equal(calls.length, 2);
  assert.equal(store.autoCandidateKey, '');
});

for (const stage of ['hash', 'keywords']) {
  test(`obsolete ${stage} response cannot start more searches or overwrite a new playback`, async () => {
    const wait = deferred(),
      calls = [];
    const { store } = storeFixture({
      searchLyric: async (q) => {
        calls.push(q);
        return (stage === 'hash' ? q.hash : q.keywords) ? wait.promise : { candidates: [] };
      },
    });
    const loading = store.fetchLyrics(`stale-${stage}`, { ...matchOptions, force: true });
    await flush();
    store.clear('new-track');
    wait.resolve({ candidates: stage === 'hash' ? [] : [candidate('obsolete')] });
    await loading;
    assert.equal(store.loadedHash, 'new-track');
    assert.deepEqual(store.lines, []);
    assert.equal(calls.length, stage === 'hash' ? 1 : 2);
  });
}

test('obsolete candidate hash response cannot start keyword fallback or replace current candidates', async () => {
  const wait = deferred(),
    calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return q.hash === 'old-candidates'
        ? wait.promise
        : { candidates: [candidate('new-candidate')] };
    },
  });
  const loading = store.fetchLyricCandidates('old-candidates', matchOptions);
  await store.fetchLyricCandidates('new-candidates', matchOptions);
  wait.resolve({ candidates: [] });
  await loading;
  assert.equal(
    calls.some((q) => q.keywords),
    false,
  );
  assert.equal(store.candidateHash, 'new-candidates');
});

test('dialog passes original song metadata to automatic matching and restoring recommendations', async (t) => {
  const calls = [];
  const f = dialogFixture(t, {
    fetchLyricCandidates: async (hash, options) => {
      calls.push(['auto', hash, options]);
      return [candidate('auto')];
    },
    restoreAutoLyric: async (hash, options) => calls.push(['restore', hash, options]),
  });
  await flush();
  f.view.searchTitle.value = '仅供手动搜索';
  f.view.searchArtist.value = '不应改变原曲信息';
  await f.view.restoreAuto();
  assert.deepEqual(calls, [
    [
      'auto',
      'cloud',
      { title: '**', artist: '**', duration: 180000, albumAudioId: 7, force: false },
    ],
    ['restore', 'cloud', { title: '**', artist: '**', duration: 180000, albumAudioId: 7 }],
  ]);
});

for (const source of ['plugin:test', 'cloud']) {
  test(`${source} keeps existing plugin lyric priority around automatic fallback`, async () => {
    const calls = [];
    const { store } = storeFixture(
      {
        searchLyric: async (q) => {
          calls.push(q);
          return { candidates: [] };
        },
      },
      async () => ({ pluginId: 'test', resolverId: 'lyrics', decodeContent: '[00:01.00]插件歌词' }),
    );
    await store.fetchLyrics(`plugin-priority-${source}`, {
      track: { title: '歌名', artist: '歌手', source },
    });
    assert.equal(store.lines[0].text, '插件歌词');
    assert.equal(store.currentCandidateKey, 'plugin:test:lyrics');
    assert.equal(calls.length, source === 'cloud' ? 2 : 0);
  });
}

test('late keyword candidate results cannot replace a newer hash match or request its recommendation', async () => {
  const pending = deferred(),
    calls = [];
  const { store } = storeFixture({
    searchLyric: async (q) => {
      calls.push(q);
      return q.keywords
        ? pending.promise
        : { candidates: q.hash === 'old-keywords' ? [] : [candidate('new-hash')] };
    },
  });
  const old = store.fetchLyricCandidates('old-keywords', matchOptions);
  await flush();
  assert.equal(calls.length, 2);
  await store.fetchLyricCandidates('new-hash', matchOptions);
  pending.resolve({ candidates: [candidate('old-keywords')] });
  await old;
  assert.equal(store.candidateHash, 'new-hash');
  assert.equal(store.candidates[0].id, 'new-hash');
  assert.equal(calls.filter((q) => q.keywords).length, 1);
});

test('plain embedded lyrics allow hash and catalog lookup before authoritative tag lookup', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (query) => {
      calls.push(query);
      return { candidates: query.keywords === '李易峰 - 剑伤' ? [candidate('embedded-title')] : [] };
    },
    getLyric: async () => ({ decodeContent: '[00:01.00]在线时间轴歌词' }),
  });
  store.setLyric('世间多纷扰 生死困顿寂寥', 'file-plain');
  assert.equal(store.lines.length, 0);
  await store.fetchLyrics('file-plain', {
    duration: 190000,
    track: {
      title: 'Li Yi-Feng - 劍傷.m4a',
      artist: 'Li Yi-Feng',
      source: 'local',
      embeddedMetadata: { title: '剑伤', artist: '李易峰' },
    },
  });
  assert.deepEqual(calls, [
    { hash: 'file-plain', duration: 190000, albumAudioId: undefined, man: 'no' },
    { keywords: 'Li Yi-Feng - Li Yi-Feng - 劍傷.m4a', duration: 190000, man: 'no' },
    { keywords: '李易峰 - 剑伤', duration: 190000, man: 'no' },
  ]);
  assert.equal(store.lines[0].text, '在线时间轴歌词');
  assert.equal(store.loadedHash, 'file-plain');
});

test('native completion drives the real lyric search/detail/parser path using tag identity and playback duration', async () => {
  const searches = [],
    details = [];
  const { store } = storeFixture({
    searchLyric: async (query) => {
      searches.push(query);
      return { candidates: query.keywords === '李易峰 - 剑伤' ? [candidate('native-online')] : [] };
    },
    getLyric: async (query) => {
      details.push(query);
      return { decodeContent: '[00:01.00]第一行\n[00:02.00]第二行' };
    },
  });
  const state = {
    seq: 123,
    requestSeq: 3,
    duration: 189.5,
    song: {
      id: 'native-file',
      hash: 'native-private-hash',
      title: 'Li Yi-Feng - 劍傷.m4a',
      artist: 'Li Yi-Feng',
      coverUrl: 'Cover',
      album: 'Album',
      duration: 180,
      source: 'local',
    },
  };
  const complete = createEmbeddedMetadataCompleter({
    current: () => state,
    captureSession: () => () => true,
    read: async () => ({ title: '剑伤', artist: '李易峰', lyric: '世间多纷扰 生死困顿寂寥' }),
    lyrics: store,
    commit: (_previous, next) => {
      state.song = next;
    },
    onError: (error) => {
      throw error;
    },
  });
  await complete();
  assert.deepEqual(searches, [
    { hash: 'native-private-hash', duration: 189500, albumAudioId: undefined, man: 'no' },
    { keywords: 'Li Yi-Feng - Li Yi-Feng - 劍傷.m4a', duration: 189500, man: 'no' },
    { keywords: '李易峰 - 剑伤', duration: 189500, man: 'no' },
  ]);
  assert.equal(details.length, 1);
  assert.equal(store.lines.length, 2);
  assert.equal(store.lines[1].text, '第二行');
  assert.equal(store.lines[1].time, 2);
  assert.equal(store.loadedHash, 'native-private-hash');
  assert.equal(state.song.hash, 'native-private-hash');
  assert.equal(state.song.lyric, undefined);
  assert.equal(state.song.embeddedMetadata.lyric, '世间多纷扰 生死困顿寂寥');
});

test('late embedded tags join the pending hash request and supply the final name lookup', async () => {
  const old = deferred(), fresh = deferred(), calls = [];
  const { store } = storeFixture({ searchLyric: (query) => {
    calls.push(query);
    if (query.hash) return old.promise;
    return query.keywords === '李易峰 - 剑伤' ? fresh.promise : { candidates: [] };
  } });
  const track = { title: 'Filename', artist: 'Guessed singer', source: 'cloud' };
  const first = store.fetchLyrics('same-file-pending', { track });
  const tagged = { ...track, embeddedMetadata: { title: '剑伤', artist: '李易峰' } };
  await store.fetchLyrics('same-file-pending', { track: tagged });
  assert.equal(calls.length, 1);
  old.resolve({ candidates: [] });
  await flush();
  assert.deepEqual(calls.map(q => q.hash || q.keywords), [
    'same-file-pending', 'Guessed singer - Filename', '李易峰 - 剑伤',
  ]);
  await store.fetchLyrics('same-file-pending', { track: tagged });
  assert.equal(calls.length, 3);
  fresh.resolve({ candidates: [candidate('new-match')] });
  await first;
  assert.equal(store.currentCandidateKey, 'new-match:access-new-match');
});

test('successful hash lyrics stay cached when embedded tags arrive later', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: [candidate('old-hash')] };
  } });
  await store.fetchLyrics('same-file-cache', { track: { title: 'Filename', source: 'cloud' } });
  store.clear();
  await store.fetchLyrics('same-file-cache', {
    track: { title: 'Filename', source: 'cloud', embeddedMetadata: { title: '剑伤', artist: '李易峰' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(store.currentCandidateKey, 'old-hash:access-old-hash');
});

test('tagged lyric response is rejected when its playback/account context expires', async () => {
  const pending = deferred();
  let current = true;
  const { store } = storeFixture({ searchLyric: () => pending.promise });
  const fetching = store.fetchLyrics('native-stale-context', {
    track: { embeddedMetadata: { title: '剑伤', artist: '李易峰' } },
    isCurrent: () => current,
  });
  current = false;
  pending.resolve({ candidates: [candidate('stale-tagged')] });
  await fetching;
  assert.equal(store.lines.length, 0);
});

test('remembered manual lyrics still win over file-tag matching', async () => {
  const calls = [];
  const { store } = storeFixture({
    searchLyric: async (query) => {
      calls.push(query);
      return { candidates: [] };
    },
  });
  store.manualLyricMap['native-manual'] = candidate('remembered-native');
  await store.fetchLyrics('native-manual', {
    track: { embeddedMetadata: { title: '剑伤', artist: '李易峰' } },
  });
  assert.equal(calls.length, 0);
  assert.equal(store.currentCandidateKey, 'remembered-native:access-remembered-native');
});

test('automatic candidate list uses hash, catalog identity, embedded identity, then recommends within the matched query', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: query.keywords === '李易峰 - 剑伤' ? [candidate('tagged-auto')] : [] };
  } });
  await store.fetchLyricCandidates('native-candidates', {
    title: 'Filename', artist: 'Guessed singer', embeddedTitle: '剑伤', embeddedArtist: '李易峰', duration: 190000,
  });
  assert.deepEqual(calls, [
    { hash: 'native-candidates', duration: 190000, albumAudioId: undefined, man: 'yes' },
    { keywords: 'Guessed singer - Filename', duration: 190000, man: 'yes' },
    { keywords: '李易峰 - 剑伤', duration: 190000, man: 'yes' },
    { keywords: '李易峰 - 剑伤', duration: 190000, man: 'no' },
  ]);
});

test('open lyric dialog forwards late native identity separately from the catalog search fields', async (t) => {
  const calls = [];
  const f = dialogFixture(t, { fetchLyricCandidates: async (_hash, query) => {
    calls.push(query);
    return [candidate('auto')];
  } });
  await flush();
  f.props.embeddedTitle = '剑伤';
  f.props.embeddedArtist = '李易峰';
  await flush();
  assert.equal(f.view.searchTitle.value, '剑伤');
  assert.equal(f.view.searchArtist.value, '李易峰');
  assert.deepEqual(calls.at(-1), {
    title: '**', artist: '**', duration: 180000, albumAudioId: 7,
    embeddedTitle: '剑伤', embeddedArtist: '李易峰', force: false,
  });
});

for (const lyric of ['内嵌第一行\n内嵌第二行', '[00:01.00]内嵌第一行\n[00:02.00]内嵌第二行']) {
  test(`embedded ${lyric.startsWith('[') ? 'timed' : 'plain'} lyrics wait for online lookup and remain a retryable fallback`, async () => {
    const online = deferred();
    let searches = 0;
    const { store } = storeFixture({
      searchLyric: async () => {
        searches++;
        return online.promise;
      },
    });
    const options = { track: { embeddedMetadata: { title: '劍傷', artist: 'Li Yi-Feng', lyric } } };
    const pending = store.fetchLyrics(`fallback-${lyric.startsWith('[')}`, options);
    assert.equal(store.isLoading, true);
    assert.equal(store.rawLyric, '');
    online.resolve({ candidates: [] });
    await pending;
    assert.equal(store.rawLyric, lyric);
    assert.equal(store.currentCandidateKey, 'embedded');
    assert.equal(store.detailResolved, false);
    assert.equal(store.lines.length, lyric.startsWith('[') ? 2 : 0);
    await store.fetchLyrics(`fallback-${lyric.startsWith('[')}`, options);
    assert.equal(searches, 4, 'fallback must not be cached as a successful online match');
  });
}

for (const outcome of ['empty', 'invalid-detail', 'error']) {
  test(`online-first mode still uses embedded fallback after ${outcome}`, async () => {
    const { store } = storeFixture({
      searchLyric: async () => {
        if (outcome === 'error') throw new Error('offline');
        return { candidates: outcome === 'empty' ? [] : [candidate('bad-detail')] };
      },
      getLyric: async () => ({ decodeContent: '' }),
    });
    await store.fetchLyrics(`fallback-${outcome}`, {
      track: { embeddedMetadata: { title: 'File', lyric: '[00:01.00]内嵌歌词' } },
    });
    assert.equal(store.currentCandidateKey, 'embedded');
    assert.equal(store.lines.length, 1);
  });
}

test('manually selected embedded lyrics avoid automatic online lookup while online candidates remain searchable', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: [candidate('online-option')] };
  } });
  store.applyEmbeddedLyric('preferred-native', '内嵌文本');
  await store.fetchLyrics('preferred-native', { track: { embeddedMetadata: { lyric: '内嵌文本' } } });
  assert.equal(calls.length, 0);
  assert.equal(store.currentCandidateKey, 'embedded');
  const results = await store.fetchLyricCandidates('preferred-native', { title: 'Song' });
  assert.equal(results[0].id, 'online-option');
  assert.equal(calls.length, 2);
  assert.equal(store.currentCandidateKey, 'embedded');
});

test('manual online choice replaces an embedded choice and survives subsequent automatic fetches', async () => {
  const { store } = storeFixture();
  const track = { hash: 'manual-over-native', embeddedMetadata: { lyric: '内嵌文本' } };
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  await store.fetchLyrics(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'embedded');
  assert.equal(await store.applyCandidate(track.hash, candidate('manual-online'), { remember: true }), true);
  await store.fetchLyrics(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'manual-online:access-manual-online');
  store.clear();
  await store.fetchLyrics(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'manual-online:access-manual-online');
});

test('switching manual source choices reuses cached online lyrics', async () => {
  let searches = 0;
  const { store } = storeFixture({ searchLyric: async () => {
    searches++;
    return { candidates: [candidate('cached-online')] };
  } });
  const track = { hash: 'preference-toggle', embeddedMetadata: { lyric: '内嵌文本' } };
  await store.fetchLyrics(track.hash, { track });
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  assert.equal(store.currentCandidateKey, 'embedded');
  await store.applyCandidate(track.hash, candidate('cached-online'), { remember: true });
  assert.equal(store.currentCandidateKey, 'cached-online:access-cached-online');
  assert.equal(searches, 1);
});

test('late online response cannot override an explicit embedded choice', async () => {
  const online = deferred();
  const { store } = storeFixture({ searchLyric: () => online.promise });
  const track = { hash: 'toggle-pending', embeddedMetadata: { lyric: '内嵌文本' } };
  const pending = store.fetchLyrics(track.hash, { track });
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  online.resolve({ candidates: [candidate('late-online')] });
  await pending;
  assert.equal(store.currentCandidateKey, 'embedded');
  assert.equal(store.isLoading, false);
});

test('failed forced refresh preserves already resolved online lyrics ahead of embedded fallback', async () => {
  let fail = false;
  const { store } = storeFixture({ searchLyric: async () => {
    if (fail) throw new Error('offline');
    return { candidates: [candidate('preserved-online')] };
  } });
  const options = { track: { embeddedMetadata: { title: 'File', lyric: '内嵌文本' } } };
  await store.fetchLyrics('preserve-online', options);
  fail = true;
  await store.fetchLyrics('preserve-online', { ...options, force: true, preserveCurrent: true });
  assert.equal(store.currentCandidateKey, 'preserved-online:access-preserved-online');
  assert.equal(store.detailResolved, true);
  assert.equal(store.rawLyric, '[00:01.00]测试歌词');
  assert.equal(store.isLoading, false);
});

test('catalog hash lyrics remain available when embedded artist aliases have no keyword results', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (q) => {
    calls.push(q);
    return { candidates: q.hash ? [candidate('sunshine-hash')] : [] };
  } });
  const track = {
    title: 'Sunshine in the Rain', artist: 'Bodies Without Organs', albumAudioId: 28409299,
    embeddedMetadata: { title: 'Sunshine In The Rain', artist: 'B.W.O' },
  };
  await store.fetchLyrics('sunshine-regression', { track, duration: 241587 });
  assert.deepEqual(calls, [{ hash: 'sunshine-regression', duration: 241587, albumAudioId: 28409299, man: 'no' }]);
  assert.equal(store.currentCandidateKey, 'sunshine-hash:access-sunshine-hash');
  assert.equal(store.lines.length, 1);
});

test('metadata arriving during a successful hash lookup neither duplicates it nor discards its lyrics', async () => {
  const gate = deferred(), calls = [];
  const { store } = storeFixture({ searchLyric: async (q) => {
    calls.push(q);
    return q.hash ? gate.promise : { candidates: [] };
  } });
  const track = { title: 'Sunshine in the Rain', artist: 'Bodies Without Organs' };
  const first = store.fetchLyrics('native-hash-pending', { track });
  await store.fetchLyrics('native-hash-pending', { track: { ...track, embeddedMetadata: { title: 'Sunshine In The Rain', artist: 'B.W.O' } } });
  assert.equal(calls.length, 1);
  gate.resolve({ candidates: [candidate('pending-hash-wins')] });
  await first;
  assert.equal(store.lines.length, 1);
  assert.equal(store.currentCandidateKey, 'pending-hash-wins:access-pending-hash-wins');
});

for (const hit of ['hash', 'catalog', 'embedded', 'none']) {
  test(`ordered automatic matching stops at ${hit}`, async () => {
    const calls = [];
    const { store } = storeFixture({ searchLyric: async (query) => {
      const stage = query.hash ? 'hash' : query.keywords === 'Catalog artist - Catalog title' ? 'catalog' : 'embedded';
      calls.push(stage);
      return { candidates: stage === hit ? [candidate(`${hit}-winner`)] : [] };
    } });
    await store.fetchLyrics(`ordered-${hit}`, {
      track: {
        title: 'Catalog title', artist: 'Catalog artist',
        embeddedMetadata: { title: 'Tag title', artist: 'Tag artist', lyric: '内嵌兜底' },
      },
    });
    assert.deepEqual(calls, ['hash', 'catalog', 'embedded'].slice(0, hit === 'hash' ? 1 : hit === 'catalog' ? 2 : 3));
    assert.equal(store.currentCandidateKey, hit === 'none' ? 'embedded' : `${hit}-winner:access-${hit}-winner`);
    assert.equal(store.rawLyric, hit === 'none' ? '内嵌兜底' : '[00:01.00]测试歌词');
  });
}

test('equivalent catalog and embedded names issue only one keyword lookup', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: [] };
  } });
  await store.fetchLyrics('same-name-dedupe', {
    track: {
      title: 'Song title', artist: 'Artist',
      embeddedMetadata: { title: '  SONG  TITLE ', artist: 'ARTIST ', lyric: '内嵌兜底' },
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hash, 'same-name-dedupe');
  assert.equal(calls[1].keywords, 'Artist - Song title');
  assert.equal(store.rawLyric, '内嵌兜底');
});

test('late tags during the catalog lookup supply the embedded lookup without restarting earlier stages', async () => {
  const catalog = deferred(), calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    if (query.hash) return { candidates: [] };
    return query.keywords === 'Catalog artist - Catalog title' ? catalog.promise : { candidates: [candidate('late-native')] };
  } });
  const track = { title: 'Catalog title', artist: 'Catalog artist' };
  const first = store.fetchLyrics('late-native-order', { track });
  await flush();
  await store.fetchLyrics('late-native-order', {
    track: { ...track, embeddedMetadata: { title: 'Tag title', artist: 'Tag artist' } },
  });
  assert.equal(calls.length, 2);
  catalog.resolve({ candidates: [] });
  await first;
  assert.deepEqual(calls.map(q => q.hash || q.keywords), [
    'late-native-order', 'Catalog artist - Catalog title', 'Tag artist - Tag title',
  ]);
  assert.equal(store.currentCandidateKey, 'late-native:access-late-native');
});

for (const content of ['第一行\n第二行', '[00:01.00]第一行\n[00:02.00]第二行']) {
  test(`embedded preview parses ${content.startsWith('[') ? 'timed' : 'plain'} lyrics without changing playback`, () => {
    const { store } = storeFixture();
    store.setLyric('[00:01.00]当前歌词', 'current');
    const preview = store.previewEmbeddedLyric(content);
    assert.equal(preview.lines.length, content.startsWith('[') ? 2 : 0);
    assert.equal(preview.rawLyric, content);
    assert.equal(store.loadedHash, 'current');
    assert.equal(store.rawLyric, '[00:01.00]当前歌词');
  });
}

test('explicit embedded choice survives replay and yields to a later manual online choice', async () => {
  const { store } = storeFixture({ searchLyric: async () => ({ candidates: [candidate('online-again')] }) });
  const track = { hash: 'manual-embedded', embeddedMetadata: { lyric: '内嵌文本' } };
  assert.equal(store.applyEmbeddedLyric(track.hash, '内嵌文本'), true);
  assert.equal(store.embeddedLyricSelectionMap[track.hash], true);
  store.clear();
  await store.fetchLyrics(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'embedded');
  await store.applyCandidate(track.hash, candidate('online-again'), { remember: true });
  assert.equal(store.embeddedLyricSelectionMap[track.hash], undefined);
  await store.fetchLyrics(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'online-again:access-online-again');
});

test('restoring automatic mode removes explicit embedded choice and uses online first', async () => {
  const { store } = storeFixture({ searchLyric: async () => ({ candidates: [candidate('restored-online')] }) });
  const track = { hash: 'restore-native-choice', embeddedMetadata: { lyric: '内嵌文本' } };
  store.applyEmbeddedLyric(track.hash, '内嵌文本');
  await store.restoreAutoLyric(track.hash, { track });
  assert.equal(store.embeddedLyricSelectionMap[track.hash], undefined);
  assert.equal(store.currentCandidateKey, 'restored-online:access-restored-online');
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  await store.restoreAutoLyric(track.hash, { track });
  assert.equal(store.currentCandidateKey, 'restored-online:access-restored-online');
});

test('native completion cannot interrupt a pending manual online selection', async () => {
  const pending = deferred();
  const { store } = storeFixture({ getLyric: () => pending.promise });
  store.applyEmbeddedLyric('manual-pending', '内嵌文本');
  const selecting = store.applyCandidate('manual-pending', candidate('chosen'), { remember: true });
  await store.fetchLyrics('manual-pending', { track: { embeddedMetadata: { lyric: '内嵌文本' } } });
  pending.resolve({ decodeContent: '[00:01.00]手选在线歌词' });
  assert.equal(await selecting, true);
  assert.equal(store.currentCandidateKey, 'chosen:access-chosen');
});

test('a remembered embedded choice falls through to online when the file has no embedded lyrics', async () => {
  const { store } = storeFixture({ searchLyric: async () => ({ candidates: [candidate('no-native')] }) });
  store.embeddedLyricSelectionMap['no-native-file'] = true;
  await store.fetchLyrics('no-native-file', { track: { embeddedMetadata: { title: 'Song' } } });
  assert.equal(store.currentCandidateKey, 'no-native:access-no-native');
});

test('dialog previews explicitly selected embedded lyrics while online lookup is pending', async (t) => {
  const pending = deferred(), result = [candidate('online-panel')];
  const f = dialogFixture(t, { fetchLyricCandidates: () => pending.promise }, { embeddedLyric: '第一行\n第二行' });
  f.view.selectCandidate(f.view.embeddedCandidate.value);
  await flush();
  assert.equal(f.view.isLoading.value, true);
  assert.equal(f.view.candidates.value.length, 1);
  assert.equal(f.view.candidateKey(f.view.candidates.value[0]), 'embedded');
  assert.deepEqual(f.view.previewStaticLines.value, ['第一行', '第二行']);
  pending.resolve(result);
  await flush();
  assert.equal(f.view.candidates.value.length, 2);
  assert.equal(result.length, 1, 'local candidates must not enter online cache arrays');
  f.view.selectedKey.value = 'online-panel:access-online-panel';
  await flush();
  assert.equal(f.view.previewStaticLines.value[0], '预览');
});

test('failed online search leaves embedded lyrics selectable and applicable in the dialog', async (t) => {
  const applies = [];
  const f = dialogFixture(t, {
    fetchLyricCandidates: async () => { throw new Error('offline'); },
    applyEmbeddedLyric: (hash, content) => { applies.push([hash, content]); return true; },
  }, { embeddedLyric: '内嵌预览' });
  await flush();
  assert.equal(f.view.candidates.value.length, 1);
  assert.equal(f.view.searchError.value, '在线歌词搜索失败，请重试');
  assert.equal(f.view.previewStaticLines.value[0], '内嵌预览');
  await f.view.applySelected();
  assert.deepEqual(applies, [['cloud', '内嵌预览']]);
});

test('dialog allows replacing a remembered embedded choice with an online candidate', async (t) => {
  const applies = [];
  const f = dialogFixture(t, {
    embeddedLyricSelectionMap: { cloud: true },
    currentCandidateKey: 'embedded',
    applyCandidate: async (hash, value, options) => { applies.push([hash, value.id, options]); return true; },
  }, { embeddedLyric: '内嵌预览' });
  await flush();
  assert.equal(f.view.candidates.value.length, 2);
  f.view.selectedKey.value = 'auto:access-auto';
  await flush();
  await f.view.applySelected();
  assert.deepEqual(applies, [['cloud', 'auto', { remember: true }]]);
});

test('reselecting embedded lyrics cancels a pending online restore even when native text is unchanged', async () => {
  const pending = deferred();
  const { store } = storeFixture({ searchLyric: () => pending.promise });
  const track = { hash: 'native-toggle-race', embeddedMetadata: { lyric: '内嵌文本' } };
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  await store.fetchLyrics(track.hash, { track });
  const switching = store.restoreAutoLyric(track.hash, { track });
  assert.equal(store.isLoading, true);
  store.applyEmbeddedLyric(track.hash, track.embeddedMetadata.lyric);
  pending.resolve({ candidates: [candidate('obsolete-online')] });
  await switching;
  assert.equal(store.currentCandidateKey, 'embedded');
  assert.equal(store.isLoading, false);
});

for (const [value, embedded, expected] of [
  ['***', '李易峰', '李易峰'],
  [' ** ', ' 剑伤 ', '剑伤'],
  ['A*Teens', 'Other', 'A*Teens'],
  ['Song *', 'Other', 'Song *'],
  ['***', '', '***'],
  ['***', '***', '***'],
  ['', 'Native', ''],
]) {
  test(`masked name resolution ${JSON.stringify(value)} -> ${JSON.stringify(expected)}`, () => {
    assert.equal(embeddedTags.resolveMaskedMetadata(value, embedded), expected);
  });
}

test('automatic name fallback replaces fully masked fields and deduplicates the embedded query', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: [] };
  } });
  await store.fetchLyrics('masked-song', {
    track: { title: '**', artist: '***', embeddedMetadata: { title: '剑伤', artist: '李易峰' } },
  });
  assert.deepEqual(calls.map(q => q.hash || q.keywords), ['masked-song', '李易峰 - 剑伤']);
});

test('masked names do not change successful hash matching', async () => {
  const calls = [];
  const { store } = storeFixture({ searchLyric: async (query) => {
    calls.push(query);
    return { candidates: [{ ...candidate('hash-hit'), singer: '***' }] };
  } });
  await store.fetchLyrics('keep-hash-first', {
    track: { title: '剑伤', artist: '***', embeddedMetadata: { title: '剑伤', artist: '李易峰' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hash, 'keep-hash-first');
  assert.equal(store.currentCandidateKey, 'hash-hit:access-hash-hit');
});

test('dialog replaces masked defaults and explicitly submitted masked edits with embedded names', async (t) => {
  const calls = [];
  const f = dialogFixture(t, { searchLyricCandidates: async (query) => { calls.push(query); return []; } }, {
    title: '剑伤', artist: '***', embeddedTitle: '剑伤', embeddedArtist: '李易峰',
  });
  await flush();
  assert.equal(f.view.searchTitle.value, '剑伤');
  assert.equal(f.view.searchArtist.value, '李易峰');
  f.view.searchTitle.value = '***';
  f.view.searchArtist.value = '**';
  await f.view.loadCandidates('keywords');
  assert.deepEqual(calls, [{ title: '剑伤', artist: '李易峰', duration: 180000 }]);
  assert.equal(f.view.searchArtist.value, '李易峰');
});

test('closing the source dialog releases its embedded candidate and parsed preview caches', async (t) => {
  const f = dialogFixture(t, {}, { embeddedLyric: 'Native lyrics' });
  await flush();
  assert.ok(f.view.embeddedPreview.value);
  assert.ok(f.view.embeddedCandidate.value);
  f.props.open = false;
  await flush();
  assert.equal(f.view.embeddedPreview.value, null);
  assert.equal(f.view.embeddedCandidate.value, null);
  assert.deepEqual(f.view.candidates.value, []);
  assert.deepEqual(f.view.previewStaticLines.value, []);
});

test('late embedded data preserves edited query, manual results, selection and online preview', async (t) => {
  let searches = 0;
  let previews = 0;
  const f = dialogFixture(t, {
    fetchLyricCandidates: async () => { searches++; return [candidate('auto')]; },
    searchLyricCandidates: async () => { searches++; return [candidate('custom-one'), candidate('custom-two')]; },
    previewCandidate: async (entry) => { previews++; return { lines: [], rawLyric: entry.id, hasTranslation: false, hasRomanization: false }; },
  });
  await flush();
  f.view.searchTitle.value = '手动歌名';
  f.view.searchArtist.value = '手动歌手';
  await f.view.loadCandidates('keywords');
  f.view.selectedKey.value = 'custom-two:access-custom-two';
  await flush();
  const beforeSearches = searches;
  const beforePreviews = previews;
  f.props.embeddedTitle = '内嵌歌名';
  f.props.embeddedArtist = '内嵌歌手';
  f.props.embeddedLyric = '晚到的内嵌歌词';
  f.props.title = '更新后的展示歌名';
  await flush();
  assert.equal(f.view.searchTitle.value, '手动歌名');
  assert.equal(f.view.searchArtist.value, '手动歌手');
  assert.equal(f.view.selectedKey.value, 'custom-two:access-custom-two');
  assert.deepEqual(f.view.candidates.value.map(entry => f.view.candidateKey(entry)), ['embedded', 'custom-one:access-custom-one', 'custom-two:access-custom-two']);
  assert.deepEqual(f.view.previewStaticLines.value, ['custom-two']);
  assert.equal(searches, beforeSearches);
  assert.equal(previews, beforePreviews, 'a new embedded candidate must not reload an unrelated online preview');
});

test('late embedded lyrics do not cancel an in-flight manual keyword search', async (t) => {
  const pending = deferred();
  const f = dialogFixture(t, { searchLyricCandidates: () => pending.promise });
  await flush();
  f.view.searchTitle.value = '手动查询';
  const searching = f.view.loadCandidates('keywords');
  f.props.embeddedTitle = '内嵌歌名';
  f.props.embeddedArtist = '内嵌歌手';
  f.props.embeddedLyric = '晚到的内嵌歌词';
  await flush();
  assert.equal(f.view.isLoading.value, true);
  assert.equal(f.view.searchTitle.value, '手动查询');
  pending.resolve([candidate('manual-result')]);
  await searching;
  await flush();
  assert.deepEqual(f.view.candidates.value.map(entry => f.view.candidateKey(entry)), ['embedded', 'manual-result:access-manual-result']);
  assert.equal(f.view.isLoading.value, false);
});

test('a lyric-only update adds the local candidate without resetting an untouched automatic result', async (t) => {
  let searches = 0;
  const f = dialogFixture(t, { fetchLyricCandidates: async () => { searches++; return [candidate('auto')]; } });
  await flush();
  f.props.embeddedLyric = '第一份内嵌歌词';
  await flush();
  assert.equal(searches, 1);
  assert.equal(f.view.selectedKey.value, 'auto:access-auto');
  f.view.selectedKey.value = 'embedded';
  await flush();
  assert.deepEqual(f.view.previewStaticLines.value, ['第一份内嵌歌词']);
  f.props.embeddedLyric = '更新的内嵌歌词';
  await flush();
  assert.equal(f.view.selectedKey.value, 'embedded');
  assert.deepEqual(f.view.previewStaticLines.value, ['更新的内嵌歌词']);
});

test('unsent edits survive native enrichment while automatic search is pending', async (t) => {
  const pending = deferred();
  let searches = 0;
  const f = dialogFixture(t, { fetchLyricCandidates: () => { searches++; return pending.promise; } });
  f.view.searchArtist.value = '尚未提交的歌手';
  f.props.embeddedTitle = '内嵌歌名';
  f.props.embeddedArtist = '内嵌歌手';
  f.props.embeddedLyric = '内嵌歌词';
  await flush();
  assert.equal(f.view.searchArtist.value, '尚未提交的歌手');
  assert.equal(searches, 1);
  pending.resolve([candidate('auto-pending')]);
  await flush();
  assert.equal(f.view.searchArtist.value, '尚未提交的歌手');
  assert.deepEqual(f.view.candidates.value.map(entry => f.view.candidateKey(entry)), ['embedded', 'auto-pending:access-auto-pending']);
});

test('an explicit candidate selection survives late identity without requiring keyword edits', async (t) => {
  let searches = 0;
  const f = dialogFixture(t, { fetchLyricCandidates: async () => { searches++; return [candidate('first'), candidate('chosen')]; } });
  await flush();
  f.view.selectCandidate(f.view.candidates.value[1]);
  await flush();
  f.props.embeddedTitle = '权威歌名';
  f.props.embeddedArtist = '权威歌手';
  f.props.embeddedLyric = '晚到内嵌歌词';
  await flush();
  assert.equal(searches, 1);
  assert.equal(f.view.selectedKey.value, 'chosen:access-chosen');
  assert.equal(f.view.searchTitle.value, '**');
  f.view.resetSearch();
  await flush();
  assert.equal(searches, 2, 'explicit rematch must still reset the query');
  assert.equal(f.view.searchTitle.value, '权威歌名');
});

test('removing an embedded candidate preserves online results and switching tracks resets manual inputs', async (t) => {
  const f = dialogFixture(t, {}, { embeddedLyric: '内嵌歌词' });
  await flush();
  f.view.searchTitle.value = '手动搜索';
  await f.view.loadCandidates('keywords');
  f.view.selectedKey.value = 'embedded';
  await flush();
  f.props.embeddedLyric = '';
  await flush();
  assert.equal(f.view.selectedCandidate.value.id, 'custom');
  assert.equal(f.view.searchTitle.value, '手动搜索');
  assert.equal(f.view.candidates.value.length, 1);
  f.props.hash = 'different-song';
  f.props.title = '新的歌曲';
  f.props.embeddedTitle = undefined;
  f.props.embeddedArtist = undefined;
  await flush();
  assert.equal(f.view.searchTitle.value, '新的歌曲');
  assert.equal(f.view.selectedCandidate.value.id, 'auto');
});


test('manual embedded selection survives persisted restart without changing another song default', async (t) => {
  const saved = new Map();
  const timers = new Map();
  let timerId = 0;
  const runtimeWindow = {
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    electron: { storage: {
      getKv: async (key) => saved.has(key) ? structuredClone(saved.get(key)) : null,
      setKv: async (key, value) => { saved.set(key, structuredClone(value)); },
      deleteKv: async (key) => saved.delete(key),
    } },
  };
  const persist = compile(read('stores/sqlitePersist.ts'), {
    '../../shared/storePersistence': persistence,
    '@/utils/logger': { warn() {} },
  }, runtimeWindow);
  let searches = 0;
  const createStore = () => {
    // A fresh module and Pinia instance simulate a restart, including empty runtime caches.
    const { useLyricStore } = storeFixture({ searchLyric: async () => {
      searches++;
      return { candidates: [candidate('default-online')] };
    } });
    const instance = pinia.createPinia();
    instance.use(persist.sqlitePersistPlugin);
    vue.createApp({}).use(instance);
    t.after(() => pinia.disposePinia(instance));
    return useLyricStore(instance);
  };
  const first = createStore();
  await persist.waitForSqlitePersistHydration();
  assert.equal(first.applyEmbeddedLyric('remember-native', '内嵌文本'), true);
  await vue.nextTick();
  for (const fn of timers.values()) fn();
  timers.clear();
  await flush();
  const persisted = [...saved.values()][0];
  assert.deepEqual(persisted.embeddedLyricSelectionMap, { 'remember-native': true });
  assert.equal(JSON.stringify(persisted).includes('内嵌文本'), false, 'persist the choice, not the lyric payload');
  const restarted = createStore();
  await persist.waitForSqlitePersistHydration();
  assert.equal(restarted.rawLyric, '');
  assert.equal(restarted.embeddedLyricSelectionMap['remember-native'], true);
  await restarted.fetchLyrics('remember-native', { track: { embeddedMetadata: { lyric: '本次从文件读取的新歌词' } } });
  assert.equal(restarted.currentCandidateKey, 'embedded');
  assert.equal(restarted.rawLyric, '本次从文件读取的新歌词');
  assert.equal(searches, 0);
  await restarted.fetchLyrics('never-selected', { track: { embeddedMetadata: { lyric: '另一首内嵌歌词' } } });
  assert.equal(searches, 1);
  assert.equal(restarted.currentCandidateKey, 'default-online:access-default-online');
});

test('dialog selects the playing online lyric by id when list accesskey differs', async (t) => {
  const playing = { ...candidate('same-id'), accesskey: 'playback-key' };
  const listed = { ...candidate('same-id'), accesskey: 'list-key' };
  const f = dialogFixture(t, {
    currentCandidateKey: 'same-id:playback-key',
    autoCandidateKey: 'same-id:list-key',
    fetchLyricCandidates: async () => [listed],
  }, { embeddedLyric: '内嵌候选' });
  assert.notEqual(f.view.selectedKey.value, 'embedded', 'do not check native while waiting for the playing online candidate');
  await flush();
  assert.equal(f.view.selectedKey.value, 'same-id:list-key');
  assert.equal(f.view.selectedCandidate.value.id, playing.id);
  assert.equal(f.store.currentCandidateKey, 'same-id:playback-key', 'opening the panel must not apply anything');
});

for (const current of ['', 'not-in-results:old-key']) {
  test(`dialog falls through to online recommendation when current key is ${JSON.stringify(current)}`, async (t) => {
    const f = dialogFixture(t, {
      currentCandidateKey: current,
      autoCandidateKey: 'recommended:access-recommended',
      fetchLyricCandidates: async () => [candidate('other'), candidate('recommended')],
    }, { embeddedLyric: '内嵌候选' });
    await flush();
    assert.equal(f.view.selectedKey.value, 'recommended:access-recommended');
  });
}

test('dialog defaults to an online candidate before embedded when no recommendation is available', async (t) => {
  const f = dialogFixture(t, {}, { embeddedLyric: '内嵌候选' });
  await flush();
  assert.equal(f.view.selectedKey.value, 'auto:access-auto');
});

test('a pending result does not replace the candidate explicitly clicked in the dialog', async (t) => {
  const pending = deferred();
  const f = dialogFixture(t, {
    currentCandidateKey: 'playing:access-playing',
    fetchLyricCandidates: () => pending.promise,
  }, { embeddedLyric: '内嵌候选' });
  f.view.selectCandidate(f.view.embeddedCandidate.value);
  pending.resolve([candidate('playing')]);
  await flush();
  assert.equal(f.view.selectedKey.value, 'embedded');
  assert.equal(f.store.currentCandidateKey, 'playing:access-playing');
});

test('late playing lyric identity aligns the dialog until the user explicitly selects another candidate', async (t) => {
  const f = dialogFixture(t, { fetchLyricCandidates: async () => [candidate('first'), candidate('playing')] }, { embeddedLyric: '内嵌候选' });
  await flush();
  f.store.currentCandidateKey = 'playing:different-key';
  await flush();
  assert.equal(f.view.selectedKey.value, 'playing:access-playing');
  f.view.selectCandidate(f.view.embeddedCandidate.value);
  f.store.currentCandidateKey = 'first:access-first';
  await flush();
  assert.equal(f.view.selectedKey.value, 'embedded');
});

test('a currently used embedded lyric remains selected when online results arrive', async (t) => {
  const f = dialogFixture(t, { currentCandidateKey: 'embedded' }, { embeddedLyric: '正在使用的内嵌歌词' });
  await flush();
  assert.equal(f.view.selectedKey.value, 'embedded');
});
