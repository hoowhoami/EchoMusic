import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const { reactive } = require('vue');
const { createPinia, setActivePinia } = require('pinia');
const load = (path, mocks = {}) => {
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => mocks[name] ?? require(name),
    mod,
    mod.exports,
  );
  return mod.exports;
};
const object = load('../src/shared/object.ts');
const helpers = load('../src/renderer/utils/videoCollection.ts', { '../../shared/object': object });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const page = (ids, total = ids.length) => ({
  status: 1,
  data: { info: ids.map((video_id) => ({ video_id })), ctotal: total },
});
const setup = (get, set = async () => {}) => {
  setActivePinia(createPinia());
  const user = reactive({ isLoggedIn: true, info: { userid: 1 } });
  const { useVideoCollectionStore } = load('../src/renderer/stores/videoCollection.ts', {
    '@/api/user': { getUserVideoCollect: get },
    '@/api/video': { setVideoCollected: set },
    '@/stores/user': { useUserStore: () => user },
    '@/utils/videoCollection': helpers,
    '../../shared/object': object,
  });
  return { store: useVideoCollectionStore(), user };
};

test('MV IDs reject hashes, zero, unsafe numbers and missing IDs', () => {
  for (const id of ['', undefined, 'abcdef1234', 0, -1, 1.5, '1e3', '9007199254740992']) {
    assert.equal(helpers.normalizeVideoId(id), '');
  }
  assert.equal(helpers.normalizeVideoId('00123'), '123');
});

test('collection endpoints pass video ID into upstream ctype=2 payloads', async () => {
  const urls = [];
  const api = load('../src/renderer/api/video.ts', {
    '@/utils/videoCollection': helpers,
    '@/utils/request': {
      get: async (url, { params }) => {
        urls.push(url);
        const upstream = load(
          `../server/module/${url === '/mv/collect' ? 'mv_collect' : 'mv_collect_del'}.js`,
          {
            '../util': {
              playlistAesEncrypt: (data) => {
                assert.deepEqual(data, { ctype: 2, data: [{ obj_id: 123 }] });
                return { key: 'test', str: 'e30=' };
              },
              playlistAesDecrypt: () => ({ status: 1, error_code: 0 }),
              rsaEncrypt2: () => 'abc',
              signParamsKey: () => 'key',
              clientver: 1,
              appid: 1,
            },
          },
        );
        const result = await upstream({ ...params, cookie: {} }, async (config) => {
          assert.equal(config.url, url === '/mv/collect' ? '/v1/collect' : '/v1/cancel_collect');
          return { status: 200, body: Buffer.from('{}') };
        });
        return result.body;
      },
    },
  });
  await api.setVideoCollected(123, true);
  await api.setVideoCollected('123', false);
  await assert.rejects(api.setVideoCollected('hash', true));
  assert.deepEqual(urls, ['/mv/collect', '/mv/collect/del']);
});

test('HTTP-success business failures and malformed responses are rejected', async () => {
  for (const body of [null, {}, { status: 0 }, { status: 1, error_code: 9 }, { errcode: 7 }]) {
    const api = load('../src/renderer/api/video.ts', {
      '@/utils/videoCollection': helpers,
      '@/utils/request': { get: async () => body },
    });
    await assert.rejects(api.setVideoCollected(123, true));
  }
  helpers.assertVideoCollectionSuccess({ status: 1, error_code: 0 });
});

test('state reads all collection pages and shares concurrent loads', async () => {
  const calls = [];
  const first = deferred();
  const { store } = setup(async (p) => {
    calls.push(p);
    return p === 1 ? first.promise : page([31], 31);
  });
  const a = store.ensureLoaded();
  const b = store.ensureLoaded();
  first.resolve(
    page(
      Array.from({ length: 30 }, (_, i) => i + 1),
      31,
    ),
  );
  await Promise.all([a, b]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.isCollected(31), true);
  assert.equal(store.isCollected(32), false);
});

test('mutations deduplicate and change collection/revision only after success', async () => {
  const pending = deferred();
  const calls = [];
  const { store } = setup(
    async () => page([123]),
    async (...args) => {
      calls.push(args);
      await pending.promise;
    },
  );
  await store.ensureLoaded();
  const first = store.toggle(123);
  await store.toggle(123);
  assert.equal(store.isPending(123), true);
  assert.equal(store.isCollected(123), true);
  assert.equal(store.revision, 0);
  pending.resolve();
  assert.equal(await first, false);
  assert.deepEqual(calls, [['123', false]]);
  assert.equal(store.isCollected(123), false);
  assert.equal(store.revision, 1);
  assert.equal(await store.toggle(123), true);
  assert.equal(store.isCollected(123), true);
});

test('failed mutations preserve state and can be retried', async () => {
  let fail = true;
  const { store } = setup(
    async () => page([123]),
    async () => {
      if (fail) throw new Error('network');
    },
  );
  await assert.rejects(store.toggle(123), /network/);
  assert.equal(store.isCollected(123), true);
  assert.equal(store.isPending(123), false);
  assert.equal(store.revision, 0);
  fail = false;
  assert.equal(await store.toggle(123), false);
});

test('failed status reads are retryable and never mark an empty collection as loaded', async () => {
  let fail = true;
  const { store } = setup(async () => (fail ? { status: 0 } : page([123])));
  await assert.rejects(store.ensureLoaded());
  assert.equal(store.loaded, false);
  assert.equal(store.loading, false);
  fail = false;
  await store.ensureLoaded();
  assert.equal(store.isCollected(123), true);
});

test('account switches discard old reads and old mutation completions', async () => {
  const oldRead = deferred();
  const oldWrite = deferred();
  let count = 0;
  const { store, user } = setup(
    async () => (++count === 1 ? oldRead.promise : page([456])),
    () => oldWrite.promise,
  );
  const read = store.ensureLoaded();
  user.info.userid = 2;
  await store.ensureLoaded();
  oldRead.resolve(page([123]));
  await read;
  assert.equal(store.isCollected(123), false);
  assert.equal(store.isCollected(456), true);
  const write = store.toggle(456);
  await Promise.resolve();
  user.info.userid = 3;
  oldWrite.resolve();
  assert.equal(await write, undefined);
  assert.equal(store.loaded, false);
  assert.equal(store.revision, 0);
  assert.equal(store.isPending(456), false);
  user.isLoggedIn = false;
  await assert.rejects(store.toggle(456), /登录/);
});

const videoMapper = load('../src/renderer/utils/mappers/video.ts', {
  '@/utils/videoCollection': helpers,
  '@/utils/cover': { normalizeCoverUrl: (value) => value },
  '../../../shared/object': object,
});
const setupDetail = ({ route, api = {}, collection = {} }) => {
  const vue = require('vue');
  const user = reactive({ isLoggedIn: true, info: { userid: 1 } });
  const notices = [];
  const mocks = {
    vue: { ...vue, onMounted: () => {}, onBeforeUnmount: () => {}, watch: () => {} },
    'vue-router': { useRoute: () => route },
    '@/api/video': api,
    '@/utils/mappers/video': videoMapper,
    '@/utils/videoCollection': helpers,
    '@/stores/user': { useUserStore: () => user },
    '@/stores/player': { usePlayerStore: () => ({ isPlaying: false }) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/stores/toast': {
      useToastStore: () => ({
        loginRequired: () => notices.push('login'),
        actionSucceeded: () => notices.push('success'),
        actionFailed: () => notices.push('failure'),
        loadFailed: () => notices.push('load-failed'),
      }),
    },
    '@/stores/videoCollection': {
      useVideoCollectionStore: () => ({
        loaded: true,
        isCollected: () => false,
        isPending: () => false,
        ...collection,
      }),
    },
  };
  const sfc = readFileSync(
    new URL('../src/renderer/views/details/MvDetail.vue', import.meta.url),
    'utf8',
  );
  const script = sfc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code = transformSync(
    script +
      '\nexport { meta, collectionId, buildInitialMeta, mergeMeta, fetchMvMeta, switchVersion, toggleCollection };',
    { loader: 'ts', format: 'cjs' },
  ).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'defineOptions', code)(
    (name) => mocks[name] ?? {},
    mod,
    mod.exports,
    () => {},
  );
  return { ...mod.exports, notices, user };
};

test('detail preserves collection ID through hash-only privilege metadata and rejects song fallback', () => {
  const detail = setupDetail({
    route: { params: { id: 'hash' }, query: { hash: 'hash', videoId: '123' } },
  });
  detail.meta.value = detail.buildInitialMeta();
  detail.mergeMeta(videoMapper.mapVideoMeta({ data: [{ hash: 'hash' }] }));
  assert.equal(detail.collectionId.value, '123');
  const song = setupDetail({ route: { params: { id: '789' }, query: { albumAudioId: '789' } } });
  song.meta.value = song.buildInitialMeta();
  assert.equal(song.collectionId.value, '');
});

test('detail targets the requested MV version and changing quality does not change its collection ID', async () => {
  const detail = setupDetail({
    route: { params: { id: 'hash2' }, query: { hash: 'hash2', videoId: '2', albumAudioId: '789' } },
    api: {
      getSongMv: async () => ({
        data: [
          [
            { video_id: 1, hash: 'hash1', mv_name: 'first' },
            { video_id: 2, hash: 'hash2', mv_name: 'selected', h264: { hd_hash: 'quality2' } },
          ],
        ],
      }),
      getVideoDetail: async () => ({ data: [{ video_id: 2, hash: 'hash2' }] }),
      getVideoPrivilege: async () => ({ data: [{ hash: 'quality2', level: 4 }] }),
    },
  });
  await detail.fetchMvMeta();
  assert.equal(detail.collectionId.value, '2');
  detail.switchVersion(-1);
  assert.equal(detail.collectionId.value, '1');
});

test('detail gates login and does not update another version count after an in-flight mutation', async () => {
  const pending = deferred();
  const ids = [];
  const detail = setupDetail({
    route: { params: { id: 'hash' }, query: { videoId: '1' } },
    collection: {
      toggle: (id) => {
        ids.push(id);
        return pending.promise;
      },
    },
  });
  detail.meta.value = { ...detail.buildInitialMeta(), collectionCount: 5 };
  detail.user.isLoggedIn = false;
  await detail.toggleCollection();
  assert.deepEqual(ids, []);
  assert.deepEqual(detail.notices, ['login']);
  detail.user.isLoggedIn = true;
  const task = detail.toggleCollection();
  detail.meta.value = { ...detail.meta.value, videoId: '2', collectionCount: 20 };
  pending.resolve(true);
  await task;
  assert.deepEqual(ids, ['1']);
  assert.equal(detail.meta.value.collectionCount, 20);
});
