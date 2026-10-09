import { userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import * as vue from 'vue';
import { createPinia, defineStore } from 'pinia';
import { parse, compileScript } from 'vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';

const evaluate = (source, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const compile = (path, dependencies = {}) =>
  evaluate(readFileSync(new URL(path, import.meta.url), 'utf8'), dependencies);
const accountVip = compile('../src/renderer/utils/accountVip.ts');
const access = compile('../src/renderer/utils/songQualityAccess.ts', {
  './accountVip': accountVip,
});
const session = compile('../src/renderer/utils/userSession.ts');
const hash = '213D580CA0BDCC28A5FDBA995FFDA106';
// Fields from the actual authenticated /privilege/lite response on 2026-10-08.
const response = {
  status: 1,
  quality_vip: [
    {
      hash: hash.toLowerCase(),
      qualities: [
        {
          quality: '128',
          exists: true,
          obtainable: true,
          free_listen: true,
          need_vip: true,
          require_vip_type: '',
          size_text: '2.3M',
        },
        {
          quality: '320',
          exists: true,
          obtainable: false,
          need_vip: true,
          require_vip_type: 'concept',
          size_text: '7.7M',
        },
        {
          quality: 'flac',
          exists: true,
          obtainable: false,
          need_vip: true,
          require_vip_type: 'concept',
          size_text: '22.1M',
        },
        { quality: 'high', exists: false, obtainable: false },
        {
          quality: 'viper_tape',
          exists: true,
          obtainable: false,
          need_vip: true,
          require_vip_type: 'suvip',
          size_text: '8.0M',
        },
        {
          quality: 'viper_clear',
          exists: true,
          obtainable: false,
          need_vip: true,
          require_vip_type: 'suvip',
          size_text: '85.0M',
        },
        {
          quality: 'viper_atmos',
          exists: true,
          obtainable: false,
          need_vip: true,
          require_vip_type: 'suvip',
          size_text: '46.0M',
        },
      ],
    },
  ],
};
const vipResponse = {
  status: 1,
  data: {
    vip_type: 0,
    is_vip: 0,
    busi_vip: [
      { product_type: 'svip', is_vip: 1 },
      { product_type: 'tvip', is_vip: 1 },
      { product_type: 'qvip', is_vip: 0 },
    ],
  },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const setup = (t, api = {}, suppliedUser) => {
  const user =
    suppliedUser ??
    vue.reactive({
      accountRevision: 1,
      userInfoRevision: 0,
      isLoggedIn: true,
      info: { userid: 10, token: 'session-a' },
    });
  const calls = { songs: 0, vip: 0 };
  const storeModule = compile('../src/renderer/stores/songQualityAccess.ts', {
    pinia: { defineStore },
    vue,
    '@/stores/user': { useUserStore: () => user },
    '@/utils/watchUserSession': userSessionWatch,
    '@/utils/userSession': session,
    '@/utils/songQualityAccess': access,
    '@/api/music': {
      getSongPrivilegeLite: (...args) => {
        calls.songs++;
        return api.song ? api.song(...args) : Promise.resolve(response);
      },
    },
    '@/api/user': {
      getYouthUnionVip: () => {
        calls.vip++;
        return api.vip ? api.vip() : Promise.resolve(vipResponse);
      },
    },
  });
  const store = storeModule.useSongQualityAccessStore(createPinia());
  t.after(() => store.$dispose());
  return { user, calls, store, key: storeModule.songQualityResourceKey(hash) };
};

const playbackPayload = () => ({
  ...structuredClone(response),
  data: [
    {
      hash,
      album_audio_id: 81,
      relate_goods: response.quality_vip[0].qualities.map((item) => ({
        quality: item.quality,
        hash: `${item.quality}-hash`,
        level: 0,
      })),
    },
  ],
});
const setupPlayback = (t, options = {}) => {
  const payload = options.payload ?? playbackPayload();
  const f = setup(t, {
    song: options.song ?? (() => Promise.resolve(payload)),
    vip: options.vip,
  });
  const urlCalls = [];
  const songUtils = compile('../src/renderer/utils/song.ts');
  const cover = { normalizeCoverUrl: (value) => value };
  const utils = compile('../src/renderer/stores/player/utils.ts', {
    './noticeDetails': compile('../src/renderer/stores/player/noticeDetails.ts'),
    '@/utils/song': songUtils,
    '@/utils/cover': cover,
    '../../../shared/loudness': compile('../src/shared/loudness.ts'),
  });
  const { createResolver } = compile('../src/renderer/stores/player/resolver.ts', {
    '@/api/music': {
      getSongUrl: async (hash, quality, pageId) => {
        urlCalls.push({ hash, quality, pageId });
        return { status: 1, url: quality === (options.successQuality ?? '128') ? ['audio'] : [] };
      },
    },
    '@/utils/song': songUtils,
    '@/utils/songQualityAccess': access,
    '@/utils/cover': cover,
    '@/utils/logger': { debug() {}, warn() {} },
    '@/plugins/audioSource': {
      resolvePluginAudioSource: async () => null,
      transformPluginAudioSource: async (_context, source) => source,
    },
    '@/services/cloudAudioIndex': { getCloudAudioSourceForSong: async () => null },
    './utils': utils,
  });
  const state = { currentTrackId: 'song', audioEffect: 'none' };
  const settings = {
    defaultAudioQuality: options.quality ?? 'viper_atmos',
    compatibilityMode: options.compatibilityMode ?? true,
    viperQualityEnabled: options.viperQualityEnabled ?? true,
  };
  const track = { id: 'song', hash };
  const resolver = createResolver(state, { refreshFavoriteSongIdentity() {} }, settings, f.store);
  return { ...f, resolver, track, settings, payload, urlCalls };
};

test('playback skips all super-VIP qualities before requesting URLs and reuses one privilege response', async (t) => {
  const f = setupPlayback(t);
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['flac', '320', '128'],
  );
  assert.equal(result.quality, '128');
  assert.equal(result.qualityFailureReason, '需超级 VIP');
  assert.equal(f.track.albumAudioId, '81');
  assert.deepEqual(f.calls, { songs: 1, vip: 1 });
  assert.equal(f.store.entries.get(f.key).status, 'ready');
  await f.store.ensure(hash);
  assert.deepEqual(f.calls, { songs: 1, vip: 1 }, 'opening the popup reuses playback rights');
});

test('a non-member skips concept-only qualities too', async (t) => {
  const f = setupPlayback(t, {
    vip: async () => ({ status: 1, data: { vip_type: 0, busi_vip: [] } }),
  });
  await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['128'],
  );
});

test('deluxe VIP with no super bit skips all viper URL requests', async (t) => {
  const f = setupPlayback(t, {
    vip: async () => ({ status: 1, data: { vip_type: 6, user_type: 13, svip_level: 4 } }),
  });
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['flac', '320', '128'],
  );
  assert.equal(result.qualityFailureReason, '需超级 VIP');
});

test('a super VIP starts at mother tape and never tries the higher panorama tier', async (t) => {
  const f = setupPlayback(t, {
    quality: 'viper_tape',
    vip: async () => ({ status: 1, data: { vip_type: 6, user_type: 16 } }),
  });
  await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['viper_tape', 'viper_clear', 'flac', '320', '128'],
  );
});

test('turning off viper qualities skips even free tiers and preserves the saved preference', async (t) => {
  const payload = playbackPayload();
  for (const row of payload.quality_vip[0].qualities) row.obtainable = true;
  const f = setupPlayback(t, {
    payload,
    viperQualityEnabled: false,
    vip: async () => ({ status: 1, data: { vip_type: 6, user_type: 16 } }),
  });
  await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['flac', '320', '128'],
  );
  assert.equal(f.settings.defaultAudioQuality, 'viper_atmos');
  f.settings.viperQualityEnabled = true;
  f.urlCalls.length = 0;
  await f.resolver.resolveAudioUrl(f.track, { reuseRelateGoods: true });
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['viper_atmos', 'viper_tape', 'viper_clear', 'flac', '320', '128'],
  );
});

test('with compatibility off a saved viper preference uses Hi-Res while the feature is off', async (t) => {
  const payload = playbackPayload();
  payload.quality_vip[0].qualities.find((row) => row.quality === 'high').exists = true;
  payload.quality_vip[0].qualities.find((row) => row.quality === 'high').obtainable = true;
  const f = setupPlayback(t, {
    payload,
    viperQualityEnabled: false,
    compatibilityMode: false,
    successQuality: 'high',
  });
  assert.equal((await f.resolver.resolveAudioUrl(f.track)).quality, 'high');
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['high'],
  );
  assert.equal(f.settings.defaultAudioQuality, 'viper_atmos');
});

test('explicitly free viper qualities work even when member lookup fails', async (t) => {
  const payload = playbackPayload();
  const clear = payload.quality_vip[0].qualities.find((row) => row.quality === 'viper_clear');
  clear.obtainable = true;
  const f = setupPlayback(t, {
    payload,
    quality: 'viper_tape',
    successQuality: 'viper_clear',
    vip: async () => {
      throw new Error('membership unavailable');
    },
  });
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['viper_clear'],
  );
  assert.equal(result.quality, 'viper_clear');
});

test('without compatibility mode a denied preference makes no catalog URL requests', async (t) => {
  const f = setupPlayback(t, { compatibilityMode: false });
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.equal(result.url, '');
  assert.equal(result.failureReason, '需超级 VIP');
  assert.deepEqual(f.urlCalls, []);
});

test('fully blocked rights also suppress both generic catalog fallback requests', async (t) => {
  const payload = playbackPayload();
  for (const row of payload.quality_vip[0].qualities) {
    row.obtainable = false;
    row.free_listen = false;
    row.require_vip_type = '';
    row.msg = '需购买';
  }
  const f = setupPlayback(t, { payload });
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.equal(result.failureReason, '需购买');
  assert.deepEqual(f.urlCalls, []);
});

test('generic fallback never labels a denied viper preference as the resolved quality', async (t) => {
  const f = setupPlayback(t, { successQuality: '' });
  const result = await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['flac', '320', '128', ''],
  );
  assert.equal(result.quality, 'flac');
  assert.equal(result.qualityFailureReason, '需超级 VIP');
});

test('missing rights keep ordinary fallback but do not try viper tiers without super VIP', async (t) => {
  const payload = playbackPayload();
  delete payload.quality_vip;
  const f = setupPlayback(t, { payload });
  await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['high', 'flac', '320', '128'],
  );
});

test('a failed privilege refresh can use existing ordinary hashes without trying viper tiers', async (t) => {
  const f = setupPlayback(t, {
    song: async () => {
      throw new Error('privilege unavailable');
    },
  });
  f.track.relateGoods = playbackPayload().data[0].relate_goods;
  await f.resolver.resolveAudioUrl(f.track);
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['high', 'flac', '320', '128'],
  );
});

test('profile refresh updates playback permissions without opening the popup', async (t) => {
  let superVip = false;
  const f = setupPlayback(t, {
    successQuality: 'viper_atmos',
    vip: async () => ({
      status: 1,
      data: { vip_type: superVip ? 6 : 0, user_type: superVip ? 16 : 0, busi_vip: [] },
    }),
  });
  await f.resolver.resolveAudioUrl(f.track);
  assert.ok(!f.urlCalls.some((call) => call.quality.startsWith('viper')));
  f.urlCalls.length = 0;
  superVip = true;
  f.user.userInfoRevision++;
  await f.resolver.resolveAudioUrl(f.track, { reuseRelateGoods: true });
  assert.deepEqual(
    f.urlCalls.map((call) => call.quality),
    ['viper_atmos'],
  );
  f.urlCalls.length = 0;
  superVip = false;
  f.user.userInfoRevision++;
  await f.resolver.resolveAudioUrl(f.track, { reuseRelateGoods: true });
  assert.ok(!f.urlCalls.some((call) => call.quality.startsWith('viper')));
  assert.deepEqual(f.calls, { songs: 3, vip: 3 });
});

test(
  'old account privilege completion cannot issue URLs using the next account',
  { timeout: 2000 },
  async (t) => {
    const pending = deferred();
    const started = deferred();
    const f = setupPlayback(t, {
      song: () => {
        started.resolve();
        return pending.promise;
      },
    });
    const old = f.resolver.resolveAudioUrl(f.track);
    await started.promise;
    f.user.info.token = 'session-b';
    pending.resolve(playbackPayload());
    assert.equal((await old).url, '');
    assert.deepEqual(f.urlCalls, []);
    assert.equal(f.track.albumAudioId, undefined);
  },
);

const userMapper = evaluate(
  buildSync({
    entryPoints: [new URL('../src/renderer/utils/mappers/user.ts', import.meta.url).pathname],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  }).outputFiles[0].text,
);
const userFixture = (t, api = {}) => {
  const userModule = compile('../src/renderer/stores/user.ts', {
    pinia: { defineStore },
    '@/api/user': {
      getUserDetail: async () => ({ status: 1, data: { userid: 10, nickname: 'listener' } }),
      getUserVipDetail: async () => ({ status: 1, data: { vip_type: 0 } }),
      ...api,
    },
    '@/utils/mappers': userMapper,
    '@/utils/logger': { info() {}, warn() {}, error() {} },
    '@/stores/listenReport': { useListenReportStore: () => ({ reset() {} }) },
  });
  const user = userModule.useUserStore(createPinia());
  user.setUserInfo({ userid: 10, token: 'session-a', nickname: 'listener' });
  t.after(() => user.$dispose());
  return user;
};

test('real response separates free listen, member requirements, missing quality and sizes', () => {
  const rows = access.parseSongQualityAccess(response, hash);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].obtainable, true);
  assert.equal(rows[0].freeListen, true);
  assert.equal(rows[1].requireVipType, 'concept');
  assert.equal(rows[2].sizeText, '22.1M');
  assert.equal(rows[3].exists, false);
  assert.equal(rows[4].requireVipType, 'suvip');
  assert.equal(access.parseSongQualityAccess(response, 'different-song'), null);
  assert.equal(access.parseSongQualityAccess({ ...response, status: 0 }, hash), null);
});

test('concept svip and tvip badges do not imply super VIP', () => {
  assert.deepEqual(access.parseQualityMembership(vipResponse), { concept: true, superVip: false });
  assert.deepEqual(
    access.parseQualityMembership({
      status: 1,
      data: { vip_type: '6', user_type: '16', busi_vip: [] },
    }),
    { concept: true, superVip: true },
  );
  assert.deepEqual(
    access.parseQualityMembership({
      status: 1,
      data: { vip_type: 0, busi_vip: [{ product_type: 'tvip', is_vip: 1 }] },
    }),
    { concept: false, superVip: false },
  );
  assert.equal(access.parseQualityMembership({ status: 1, data: {} }), null);
});

test('vip_type=6 is deluxe; only the active user_type bit 16 grants super quality', () => {
  for (const user_type of [undefined, -1, 0, 13]) {
    assert.deepEqual(
      access.parseQualityMembership({ status: 1, data: { vip_type: 6, user_type, svip_level: 4 } }),
      { concept: true, superVip: false },
    );
  }
  assert.deepEqual(
    access.parseQualityMembership({ status: 1, data: { vip_type: 0, user_type: 29 } }),
    { concept: true, superVip: true },
  );
});

test(
  'simultaneous player surfaces share pending requests and short-lived results',
  { timeout: 2000 },
  async (t) => {
    const pending = deferred();
    const f = setup(t, { song: () => pending.promise });
    const a = f.store.ensure(hash);
    const b = f.store.ensure(hash.toLowerCase());
    assert.deepEqual(f.calls, { songs: 1, vip: 1 });
    assert.equal(f.store.entries.get(f.key).status, 'loading');
    pending.resolve(response);
    await Promise.all([a, b]);
    await f.store.ensure(hash);
    assert.deepEqual(f.calls, { songs: 1, vip: 1 });
    assert.equal(f.store.entries.get(f.key).status, 'ready');
    f.store.entries.get(f.key).updatedAt = 0;
    await f.store.ensure(hash);
    assert.equal(f.calls.songs, 2);
  },
);

test(
  'account change clears rights immediately and old completions cannot overwrite a new session',
  { timeout: 2000 },
  async (t) => {
    const songA = deferred();
    const vipA = deferred();
    let songs = 0,
      vips = 0;
    const f = setup(t, {
      song: () => (++songs === 1 ? songA.promise : Promise.resolve(response)),
      vip: () =>
        ++vips === 1
          ? vipA.promise
          : Promise.resolve({ status: 1, data: { vip_type: 6, user_type: 16 } }),
    });
    const old = f.store.ensure(hash);
    f.user.info.token = 'session-b';
    assert.equal(f.store.entries.size, 0);
    assert.equal(f.store.membership, null);
    await f.store.ensure(hash);
    assert.equal(f.store.membership.superVip, true);
    songA.resolve({ status: 0 });
    vipA.resolve(vipResponse);
    await old;
    assert.equal(f.store.entries.get(f.key).status, 'ready');
    assert.equal(f.store.membership.superVip, true);
  },
);

test('errors are retryable and anonymous users do not request membership', async (t) => {
  let fail = true;
  const f = setup(t, { song: async () => (fail ? { status: 0 } : response) });
  await f.store.ensure(hash);
  assert.equal(f.store.entries.get(f.key).status, 'error');
  fail = false;
  await f.store.ensure(hash);
  assert.equal(f.store.entries.get(f.key).status, 'ready');
  f.user.isLoggedIn = false;
  await f.store.ensure(hash);
  assert.equal(f.calls.vip, 1);
  assert.deepEqual(f.store.membership, { concept: false, superVip: false });
});

test('quality decisions combine free access with the required membership instead of treating obtainable=false as blocked', () => {
  const rows = access.parseSongQualityAccess(response, hash);
  const guest = { concept: false, superVip: false };
  const concept = { concept: true, superVip: false };
  const superVip = { concept: true, superVip: true };
  const reason = access.getQualityAccessReason;
  assert.equal(reason(rows[0], null), '');
  assert.equal(reason(rows[1], guest), '需概念版 VIP');
  assert.equal(reason(rows[1], concept), '');
  assert.equal(reason(rows[2], concept), '');
  assert.equal(reason(rows[3], superVip), '歌曲不支持');
  assert.equal(reason(rows[4], concept), '需超级 VIP');
  assert.equal(reason(rows[4], superVip), '');
  assert.equal(reason(rows[1], null), '会员权益尚未确认');
  assert.equal(reason({ ...rows[1], needVip: false, requireVipType: '' }, superVip), '当前不可用');
  assert.equal(
    reason({ ...rows[4], obtainable: true }, guest),
    '',
    'free special qualities do not require a membership',
  );
});

const songUtils = compile('../src/renderer/utils/song.ts');
const controlsFixture = (t, api, user) => {
  const f = setup(t, api, user);
  const selections = [];
  const player = vue.reactive({
    currentTrackId: 'song-a',
    currentTrackSnapshot: {
      id: 'song-a',
      hash,
      title: '甲乙丙丁',
      artist: '李佳薇',
      relateGoods: [],
      mixSongId: '920474385',
    },
    currentResolvedAudioQuality: 'flac',
    currentResolvedSourceKind: 'catalog',
    audioSourceRefreshRequestSeq: null,
    playbackRequestSeq: 1,
    getEffectiveAudioQuality: () => 'flac',
    setPreferredAudioQuality: (quality) => selections.push(quality),
  });
  const settings = vue.reactive({});
  const controlsModule = compile('../src/renderer/composables/usePlayerControls.ts', {
    vue,
    'vue-router': { useRouter: () => ({}), useRoute: () => ({}) },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => ({ defaultList: [], favorites: [] }) },
    '@/stores/setting': { useSettingStore: () => settings },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({}) },
    '@/stores/user': { useUserStore: () => f.user },
    '@/stores/toast': { useToastStore: () => ({}) },
    '@/stores/songQualityAccess': {
      useSongQualityAccessStore: () => f.store,
      songQualityResourceKey: (hash, album) =>
        JSON.stringify([hash.toLowerCase(), String(album ?? '')]),
    },
    '@/utils/songQualityAccess': access,
    '@/utils/song': songUtils,
    '@/utils/share': {},
    '@/services/cloudAudioIndex': { getCloudAudioSourceForSong: async () => null },
    '@/icons': {},
  });
  return { ...f, player, settings, selections, controls: controlsModule.usePlayerControls() };
};

test('shared controls disable before load and reject restricted clicks while permitting concept qualities', async (t) => {
  const f = controlsFixture(t);
  assert.equal(
    f.controls.isAudioQualityDisabled('flac'),
    true,
    'even the current quality must not bypass account checks',
  );
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.equal(f.controls.isAudioQualityDisabled('128'), false);
  assert.equal(f.controls.isAudioQualityDisabled('320'), false);
  assert.equal(f.controls.isAudioQualityDisabled('flac'), false);
  assert.equal(f.controls.isAudioQualityDisabled('high'), true);
  assert.equal(f.controls.isAudioQualityDisabled('viper_tape'), true);
  f.controls.setAudioQuality('viper_tape');
  f.controls.setAudioQuality('high');
  assert.deepEqual(f.selections, []);
  f.controls.setAudioQuality('320');
  assert.deepEqual(f.selections, ['320']);
  assert.equal(f.controls.getAudioQualitySizeText('flac'), '22.1M');
  f.user.info.token = 'new-session';
  assert.equal(f.controls.isAudioQualityDisabled('flac'), true);
});

test('cloud files remain selectable independently and catalog rights use hashStd', async (t) => {
  const queried = [];
  const f = controlsFixture(t, {
    song: async (hash) => {
      queried.push(hash);
      return response;
    },
  });
  f.player.currentResolvedSourceKind = 'cloud';
  f.player.currentTrackSnapshot = {
    ...f.player.currentTrackSnapshot,
    source: 'cloud',
    hash: 'cloud-file-hash',
    cloudAudioSource: { hash: 'cloud-file-hash', hashStd: hash },
  };
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.deepEqual(queried, [hash]);
  assert.equal(f.controls.hasCloudAudioSourceOption.value, true);
  assert.equal(f.controls.isAudioQualityDisabled('flac'), false);
  f.player.currentTrackSnapshot.cloudAudioSource.hashStd = '';
  assert.equal(f.controls.hasCatalogAudioSourceOption.value, false);
  assert.equal(f.controls.hasCloudAudioSourceOption.value, true);
  assert.equal(f.controls.isAudioQualityDisabled('128'), true);
});

test(
  'a late previous-song response cannot enable the current song',
  { timeout: 2000 },
  async (t) => {
    const pending = deferred();
    const f = controlsFixture(t, { song: () => pending.promise });
    const old = f.controls.ensureCurrentTrackCatalogQualities();
    f.player.currentTrackSnapshot = {
      ...f.player.currentTrackSnapshot,
      id: 'song-b',
      hash: 'new-catalog-hash',
    };
    f.player.currentTrackId = 'song-b';
    pending.resolve(response);
    await old;
    assert.equal(f.controls.isAudioQualityDisabled('flac'), true);
    assert.equal(f.controls.hasAudioQualityAccessError.value, true);
  },
);

test('membership lookup failures retain free choices and recover on retry', async (t) => {
  let fail = true;
  const f = controlsFixture(t, {
    vip: async () => {
      if (fail) throw new Error('offline');
      return vipResponse;
    },
  });
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.equal(f.controls.hasAudioQualityAccessError.value, true);
  assert.equal(f.controls.isAudioQualityDisabled('128'), false);
  assert.equal(f.controls.isAudioQualityDisabled('320'), true);
  fail = false;
  await f.controls.retryCurrentTrackQualityAccess();
  assert.equal(f.controls.hasAudioQualityAccessError.value, false);
  assert.equal(f.controls.isAudioQualityDisabled('320'), false);
});

const popoverDescriptor = parse(
  readFileSync(
    new URL('../src/renderer/components/player/QualityPopover.vue', import.meta.url),
    'utf8',
  ),
).descriptor;
const popoverComponent = (controls, inlineTemplate) => {
  const box = vue.defineComponent({
    setup(_, { slots, attrs }) {
      return () => vue.h('div', attrs, slots.default?.());
    },
  });
  const dependencies = {
    vue,
    '@/icons': {},
    '@/composables/usePlayerControls': { usePlayerControls: () => controls },
  };
  for (const path of ['Popover', 'Tag', 'Badge', 'AudioWaveIcon', 'Button'])
    dependencies[`@/components/ui/${path}.vue`] = box;
  return evaluate(
    compileScript(popoverDescriptor, { id: 'quality-access-test', inlineTemplate }).content,
    dependencies,
  ).default;
};

const renderQualityPopup = async (controls) => {
  const app = vue.createSSRApp(popoverComponent(controls, true), { open: false });
  app.component('Icon', vue.defineComponent({ render: () => null }));
  const html = await renderToString(app);
  return {
    html,
    buttons: [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]),
  };
};

test(
  'cold loading keeps row structure stable until both song and membership arrive',
  { timeout: 2000 },
  async (t) => {
    const song = deferred();
    const vip = deferred();
    const f = controlsFixture(t, { song: () => song.promise, vip: () => vip.promise });
    const task = f.controls.ensureCurrentTrackCatalogQualities();
    const initial = await renderQualityPopup(f.controls);
    assert.equal(initial.buttons.length, 7);
    assert.equal([...initial.html.matchAll(/class="pm-detail"/g)].length, 7);
    assert.doesNotMatch(initial.html, /pm-hint|正在查询音质权限/);
    assert.match(initial.html, /正在查询音质…/);
    assert.match(initial.buttons[2], /is-active/);
    for (const button of initial.buttons) {
      assert.match(button, / disabled/);
      assert.doesNotMatch(button, /is-disabled/);
    }

    song.resolve(response);
    await vue.nextTick();
    assert.equal(f.store.entries.get(f.key).status, 'ready');
    assert.equal(f.controls.hasAudioQualityAccessData.value, false);
    assert.deepEqual(
      await renderQualityPopup(f.controls),
      initial,
      'partial results do not repaint every row',
    );
    f.controls.setAudioQuality('128');
    assert.deepEqual(f.selections, []);

    vip.resolve(vipResponse);
    await task;
    const ready = await renderQualityPopup(f.controls);
    assert.equal([...ready.html.matchAll(/class="pm-detail"/g)].length, 7);
    assert.doesNotMatch(ready.html, /pm-hint/);
    assert.match(ready.buttons[2], /is-active/);
    assert.match(ready.buttons[2], /22\.1M/);
    assert.doesNotMatch(ready.buttons[2], / disabled|is-disabled/);
    assert.match(ready.buttons[4], / disabled/);
    assert.match(ready.buttons[4], /is-disabled/);
  },
);

test(
  'expired same-song queries keep known content visible while blocking clicks',
  { timeout: 2000 },
  async (t) => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    const song = deferred();
    const vip = deferred();
    let refresh = false;
    const f = controlsFixture(t, {
      song: () => (refresh ? song.promise : Promise.resolve(response)),
      vip: () => (refresh ? vip.promise : Promise.resolve(vipResponse)),
    });
    await f.controls.ensureCurrentTrackCatalogQualities();
    const before = await renderQualityPopup(f.controls);
    refresh = true;
    now += 30_001;
    const task = f.controls.ensureCurrentTrackCatalogQualities();
    assert.equal(f.store.membership.concept, true);
    assert.equal(f.controls.hasAudioQualityAccessData.value, true);
    const loading = await renderQualityPopup(f.controls);
    const details = (html) =>
      [...html.matchAll(/<span class="pm-detail"[^>]*>(.*?)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(details(loading.html), details(before.html));
    assert.doesNotMatch(loading.buttons[2], /is-disabled/);
    assert.match(loading.buttons[4], /is-disabled/);
    for (const button of loading.buttons) assert.match(button, / disabled/);
    f.controls.setAudioQuality('320');
    assert.deepEqual(f.selections, []);

    // Retaining presentation during refresh must not retain permission after an error.
    song.resolve(response);
    vip.resolve({ status: 0 });
    await task;
    assert.equal(f.store.membership, null);
    assert.equal(f.controls.isAudioQualityDisabled('128'), false);
    assert.equal(f.controls.isAudioQualityDisabled('320'), true);
    assert.match((await renderQualityPopup(f.controls)).html, /权限查询失败/);
  },
);

test('account changes discard previous content and empty state keeps the preferred check', async (t) => {
  const f = controlsFixture(t);
  await f.controls.ensureCurrentTrackCatalogQualities();
  f.user.info.token = 'new-session';
  const loading = await renderQualityPopup(f.controls);
  assert.doesNotMatch(loading.html, /22\.1M|需超级 VIP/);
  for (const button of loading.buttons) assert.match(button, / disabled/);
  f.player.currentTrackSnapshot = null;
  f.player.currentTrackId = null;
  f.player.getEffectiveAudioQuality = () => '320';
  const empty = await renderQualityPopup(f.controls);
  assert.match(empty.html, /暂无歌曲/);
  assert.doesNotMatch(empty.html, /正在查询/);
  for (const button of empty.buttons) assert.match(button, /is-disabled.* disabled/);
  assert.match(empty.buttons[1], /is-active/);
  assert.match(empty.buttons[1], /is-visible/);
});

test('rendered popup shows real sizes, unavailable reasons, and native disabled buttons', async (t) => {
  const f = controlsFixture(t);
  await f.controls.ensureCurrentTrackCatalogQualities();
  const app = vue.createSSRApp(popoverComponent(f.controls, true), { open: false });
  app.component('Icon', vue.defineComponent({ render: () => null }));
  const html = await renderToString(app);
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 7);
  assert.match(buttons[1], /7\.7M/);
  assert.doesNotMatch(buttons[1], / disabled/);
  assert.match(buttons[3], /歌曲不支持/);
  assert.match(buttons[3], / disabled/);
  assert.match(buttons[4], /需超级 VIP/);
  assert.match(buttons[4], / disabled/);
});

test('the viper switch hides popup rows and rejects calls to hidden qualities', async (t) => {
  const f = controlsFixture(t);
  await f.controls.ensureCurrentTrackCatalogQualities();
  f.settings.viperQualityEnabled = false;
  const render = () =>
    renderToString(vue.createSSRApp(popoverComponent(f.controls, true), { open: false }));
  let html = await render();
  assert.equal([...html.matchAll(/<button\b/g)].length, 4);
  assert.doesNotMatch(html, /蝰蛇母带|蝰蛇超清|蝰蛇全景声/);
  for (const quality of ['viper_tape', 'viper_clear', 'viper_atmos']) {
    assert.equal(f.controls.isAudioQualityHidden(quality), true);
    f.controls.setAudioQuality(quality);
  }
  assert.deepEqual(f.selections, []);
  f.settings.viperQualityEnabled = true;
  html = await render();
  assert.equal([...html.matchAll(/<button\b/g)].length, 7);
});

test('an open popup rechecks on song/account key changes, and a closed popup stays quiet', async (t) => {
  let queries = 0;
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const key = vue.ref('song-a:session-a');
  const component = popoverComponent(
    {
      settingStore: {},
      isAudioQualityHidden: () => false,
      audioQualityAccessLookupKey: key,
      ensureCurrentTrackCatalogQualities: async () => {
        queries++;
      },
      isAudioSourceSwitching: vue.ref(false),
      requestedAudioQuality: vue.ref('128'),
    },
    false,
  );
  const props = vue.reactive({ open: false });
  const view = scope.run(() => component.setup(props, { expose() {}, emit() {} }));
  assert.equal(queries, 0);
  view.handleOpenChange(true);
  await vue.nextTick();
  assert.equal(queries, 1);
  key.value = 'song-b:session-a';
  await vue.nextTick();
  assert.equal(queries, 2);
  key.value = 'song-b:session-b';
  await vue.nextTick();
  assert.equal(queries, 3);
  view.handleOpenChange(false);
  await vue.nextTick();
  key.value = 'song-c:session-b';
  await vue.nextTick();
  assert.equal(queries, 3);
});

test('next query invalidates same-account rights even if refreshed profile fields stay unchanged', async (t) => {
  const user = userFixture(t);
  const f = setup(t, {}, user);
  await f.store.ensure(hash);
  const accountRevision = user.accountRevision;
  for (let i = 1; i <= 2; i++) {
    await user.fetchUserInfo();
    assert.equal(user.accountRevision, accountRevision);
    assert.equal(user.userInfoRevision, i);
    assert.equal(f.store.entries.get(f.key).status, 'ready');
    assert.equal(f.store.membership.concept, true);
    assert.deepEqual(f.calls, { songs: i, vip: i }, 'closed panels do not eagerly request rights');
    await f.store.ensure(hash);
    assert.deepEqual(f.calls, { songs: i + 1, vip: i + 1 });
  }
});

test('successful VIP-only refresh invalidates rights, but a failed refresh preserves the cache', async (t) => {
  let vipSuccess = true;
  const user = userFixture(t, {
    getUserDetail: async () => ({ status: 0 }),
    getUserVipDetail: async () => ({
      status: vipSuccess ? 1 : 0,
      data: { vip_type: 6, user_type: 16 },
    }),
  });
  const f = setup(t, {}, user);
  await f.store.ensure(hash);
  await user.fetchUserInfo();
  assert.equal(user.userInfoRevision, 1);
  assert.equal(f.store.entries.get(f.key).status, 'ready');
  await f.store.ensure(hash);
  vipSuccess = false;
  await user.fetchUserInfo();
  assert.equal(user.userInfoRevision, 1);
  assert.equal(f.store.entries.get(f.key).status, 'ready');
});

test('personal refresh leaves an open popup unchanged and updates membership on reopening', async (t) => {
  const user = userFixture(t);
  let superVip = false;
  const f = controlsFixture(
    t,
    {
      vip: async () =>
        superVip ? { status: 1, data: { vip_type: 6, user_type: 16 } } : vipResponse,
    },
    user,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const component = popoverComponent(f.controls, false);
  const view = scope.run(() =>
    component.setup(vue.reactive({ open: true }), { expose() {}, emit() {} }),
  );
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.equal(f.controls.isAudioQualityDisabled('viper_atmos'), true);
  superVip = true;
  await user.fetchUserInfo();
  await vue.nextTick();
  assert.deepEqual(f.calls, { songs: 1, vip: 1 });
  assert.equal(f.controls.isAudioQualityDisabled('viper_atmos'), true);
  view.handleOpenChange(false);
  await vue.nextTick();
  view.handleOpenChange(true);
  await vue.nextTick();
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.equal(f.controls.isAudioQualityDisabled('viper_atmos'), false);
  superVip = false;
  await user.fetchUserInfo();
  await vue.nextTick();
  assert.deepEqual(f.calls, { songs: 2, vip: 2 });
  assert.equal(f.controls.isAudioQualityDisabled('viper_atmos'), false);
  view.handleOpenChange(false);
  await vue.nextTick();
  view.handleOpenChange(true);
  await vue.nextTick();
  await f.controls.ensureCurrentTrackCatalogQualities();
  assert.equal(f.controls.isAudioQualityDisabled('viper_atmos'), true);
  assert.deepEqual(f.calls, { songs: 3, vip: 3 });
});

test(
  'same-account refresh rejects old responses and their cleanup cannot remove the fresh request',
  { timeout: 2000 },
  async (t) => {
    const user = userFixture(t);
    const oldSong = deferred(),
      oldVip = deferred(),
      newSong = deferred(),
      newVip = deferred();
    let songs = 0,
      vips = 0;
    const f = setup(
      t,
      {
        song: () => (++songs === 1 ? oldSong.promise : newSong.promise),
        vip: () => (++vips === 1 ? oldVip.promise : newVip.promise),
      },
      user,
    );
    const old = f.store.ensure(hash);
    await user.fetchUserInfo();
    const fresh = f.store.ensure(hash);
    oldSong.resolve({ status: 0 });
    oldVip.resolve(vipResponse);
    await old;
    assert.equal(f.store.entries.get(f.key).status, 'loading');
    assert.equal(f.store.membership, null);
    assert.equal(f.store.membershipStatus, 'loading');
    const shared = f.store.ensure(hash);
    assert.deepEqual(f.calls, { songs: 2, vip: 2 });
    newSong.resolve(response);
    newVip.resolve({ status: 1, data: { vip_type: 6, user_type: 16 } });
    await Promise.all([fresh, shared]);
    assert.equal(f.store.entries.get(f.key).status, 'ready');
    assert.equal(f.store.membership.superVip, true);
  },
);
