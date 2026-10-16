import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as offset from '../src/shared/lyricOffset.ts';
import * as opencc from '../src/shared/opencc.ts';

const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const compile = (source, mocks) => {
  const module = { exports: {} };
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in mocks, `Unexpected dependency ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
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
function storeFixture(api = {}) {
  const lyric = compile(read('stores/lyric.ts'), {
    pinia,
    '@/api/music': {
      searchLyric: async () => ({ candidates: [] }),
      getLyric: async () => ({ decodeContent: '[00:01.00]测试歌词' }),
      ...api,
    },
    '@/utils/logger': { warn() {}, error() {} },
    '@/utils/color': { DEFAULT_ACCENT: '#b00000', getNormalizedAccent: (x) => x },
    '@/plugins/lyrics': { resolvePluginLyric: async () => null },
    '@/services/opencc': { convertLyricLinesForDisplay: async (lines) => lines },
    './theme': { useThemeStore: () => ({}) },
    '../../shared/lyricOffset': offset,
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

function dialogFixture(t, overrides = {}) {
  const notices = [],
    unmounts = [];
  const store = vue.reactive({
    candidates: [],
    autoCandidateKey: '',
    candidatePreviewMap: {},
    currentCandidateKey: '',
    manualLyricMap: {},
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
  });
  const props = vue.reactive({
    open: true,
    hash: 'cloud',
    title: '**',
    artist: '**',
    duration: 180,
    albumAudioId: 7,
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
