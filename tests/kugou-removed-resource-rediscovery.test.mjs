import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const compile = (path, mocks = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const cover = {
  normalizeCoverUrl: (value) => value || '',
  resolveCoverDisplayUrl: (value) => value || '',
};
const song = compile('../src/renderer/utils/song.ts');
const utils = compile('../src/renderer/stores/player/utils.ts', {
  './noticeDetails': compile('../src/renderer/stores/player/noticeDetails.ts'),
  '@/utils/song': song,
  '@/utils/cover': cover,
  '../../../shared/loudness': compile('../src/shared/loudness.ts'),
});

// 已被上游移除的曲库资源：mediastore 报资源级错误 _errno=6 且 relate_goods 为空，
// quality_vip 因此把全部音质标成 exists=false（界面上表现为“歌曲不支持”）。
// 字段结构对齐 /privilege/lite 的真实响应。
const OLD_HASH = '4175D3FCC338A358A9631318B239E54F';
const NEW_HASH = 'A09F6B77B4D53E7594F0C7EB27B21A63';
const removedPayload = {
  status: 1,
  error_code: 0,
  data: [
    {
      hash: OLD_HASH,
      _errno: 6,
      _msg: '资源不存在',
      album_id: '69386141',
      album_audio_id: 588704117,
      relate_goods: [],
    },
  ],
  quality_vip: [
    {
      hash: OLD_HASH,
      qualities: ['128', '320', 'flac', 'high', 'viper_clear', 'viper_tape', 'viper_atmos'].map(
        (quality) => ({
          quality,
          exists: false,
          obtainable: false,
          free_listen: false,
          need_vip: false,
          require_vip_type: '',
          size_text: '',
          msg: '',
        }),
      ),
    },
  ],
};

// tracker 重发现后的新资源：relate_goods 恢复正常，标准音质免费可播。
const rediscoveredPayload = {
  status: 1,
  error_code: 0,
  data: [
    {
      hash: NEW_HASH,
      album_id: '69386141',
      album_audio_id: 588704117,
      relate_goods: [
        { hash: NEW_HASH, quality: '128', level: 2, status: 1, privilege: 0, pay_type: 0 },
      ],
    },
  ],
  quality_vip: [
    {
      hash: NEW_HASH,
      qualities: [
        {
          quality: '128',
          exists: true,
          obtainable: true,
          free_listen: false,
          need_vip: false,
          require_vip_type: '',
          size_text: '3.4M',
          msg: '',
        },
      ],
    },
  ],
};

const track = {
  id: '588704117',
  hash: OLD_HASH,
  albumId: '69386141',
  albumAudioId: '588704117',
  title: '星晴',
};

const setupResolver = ({ privilegesByUrl, getSongUrl }) => {
  const calls = [];
  const ensureCalls = [];
  const { createResolver, parseTrackMetadataFromPrivilege } = compile(
    '../src/renderer/stores/player/resolver.ts',
    {
      '@/api/music': {
        getSongPrivilegeLite: async () => ({ status: 1, data: [] }),
        getSongUrl: async (hash, quality, ppageId, options) => {
          calls.push({
            hash,
            quality,
            ppageId,
            albumId: options?.albumId,
            albumAudioId: options?.albumAudioId,
          });
          return getSongUrl(hash, quality, ppageId, options);
        },
      },
      '@/utils/logger': { debug() {}, info() {}, warn() {} },
      '@/utils/cover': cover,
      '@/utils/song': song,
      '@/utils/songQualityAccess': compile('../src/renderer/utils/songQualityAccess.ts', {
        './accountVip': compile('../src/renderer/utils/accountVip.ts'),
      }),
      '@/plugins/audioSource': {
        resolvePluginAudioSource: async () => null,
        transformPluginAudioSource: async (_context, source) => source,
      },
      '@/services/cloudAudioIndex': { getCloudAudioSourceForSong: async () => null },
      './utils': utils,
    },
  );
  const resolver = createResolver(
    { audioEffect: 'none', currentTrackId: track.id },
    { refreshFavoriteSongIdentity() {} },
    { defaultAudioQuality: '128', compatibilityMode: true },
    {
      ensure: async (hash) => {
        ensureCalls.push(hash);
        return privilegesByUrl[hash.toLowerCase()] ?? privilegesByUrl.default;
      },
      membership: { concept: true, superVip: true },
      captureAccessRequest: () => () => true,
    },
  );
  return { resolver, calls, ensureCalls, parseTrackMetadataFromPrivilege };
};

test('removed upstream resource is re-discovered through the tracker and playback proceeds', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: { [OLD_HASH.toLowerCase()]: removedPayload, default: rediscoveredPayload },
    getSongUrl: async (hash, quality) => {
      // 空音质是资源重发现的 tracker 探测；其余是正常音质候选请求
      if (quality === '') {
        return { status: 1, hash: NEW_HASH, url: ['https://audio.example/probe.mp3'] };
      }
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.deepEqual(
    calls.map((call) => call.quality),
    ['', '128'],
    'tracker probe precedes the ordinary quality plan',
  );
  assert.deepEqual(
    ensureCalls,
    [OLD_HASH, NEW_HASH.toLowerCase()],
    'rights are re-fetched with the re-discovered hash',
  );
  assert.equal(result.url, 'https://audio.example/standard.mp3');
  assert.equal(result.quality, '128');
  assert.equal(result.failureReason, undefined);
});

test('tracker probe keeping the removed hash plays its urls as the standard fallback', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: { default: removedPayload },
    getSongUrl: async () => ({
      status: 1,
      hash: OLD_HASH,
      volume: -10,
      url: ['https://audio.example/same.mp3'],
    }),
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.deepEqual(
    calls.filter((call) => call.quality === ''),
    [
      {
        hash: OLD_HASH,
        quality: '',
        ppageId: undefined,
        albumId: '69386141',
        albumAudioId: '588704117',
      },
    ],
    'only one tracker probe is attempted',
  );
  assert.deepEqual(ensureCalls, [OLD_HASH], 'no rights refresh without a new hash');
  assert.equal(result.url, 'https://audio.example/same.mp3');
  assert.equal(result.quality, '128');
  assert.equal(result.loudness?.lufs, -10);
  assert.equal(result.failureReason, undefined, 'the requested standard quality is audible');
});

test('tracker probe without urls keeps the unsupported failure', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: { default: removedPayload },
    getSongUrl: async (_hash, quality) => {
      if (quality === '') return { status: 1, hash: OLD_HASH, url: [] };
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.equal(calls.filter((call) => call.quality === '').length, 1, 'probe is not retried');
  assert.deepEqual(ensureCalls, [OLD_HASH], 'no rights refresh without usable urls');
  assert.equal(result.url, '');
  assert.equal(result.failureReason, '歌曲不支持');
});

test('removed resource metadata does not clobber the retained album audio id', async () => {
  const removedWithoutAudioId = {
    ...removedPayload,
    data: [{ ...removedPayload.data[0], album_audio_id: 0, id: 0, audio_id: 0 }],
  };
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: {
      [OLD_HASH.toLowerCase()]: removedWithoutAudioId,
      default: rediscoveredPayload,
    },
    getSongUrl: async (_hash, quality) => {
      if (quality === '') {
        return { status: 1, hash: NEW_HASH, url: ['https://audio.example/probe.mp3'] };
      }
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const target = { ...track, albumAudioId: '588704117' };
  const result = await resolver.resolveAudioUrl(target, { forceReload: true });
  assert.equal(
    calls[0]?.albumAudioId,
    '588704117',
    'the probe keeps the id retained by the queue instead of the 0 placeholder',
  );
  assert.deepEqual(ensureCalls, [OLD_HASH, NEW_HASH.toLowerCase()]);
  assert.equal(result.url, 'https://audio.example/standard.mp3');
  assert.equal(target.albumAudioId, '588704117', 'metadata backfill leaves the identity intact');
});

test('resource ids skip zero placeholders and keep later valid candidates', () => {
  const { parseTrackMetadataFromPrivilege } = setupResolver({
    privilegesByUrl: { default: removedPayload },
    getSongUrl: async () => ({ status: 1, url: [] }),
  });
  const metadata = parseTrackMetadataFromPrivilege({
    data: [{ album_audio_id: 0, mixsongid: 27602112, id: 0, audio_id: 942642 }],
  });
  assert.equal(metadata.albumAudioId, '27602112');
  assert.equal(metadata.mixSongId, '27602112');
  assert.equal(metadata.songId, '942642');
});

test('mixSongId stands in for albumAudioId when the queue entry lacks it', async () => {
  const { resolver, calls } = setupResolver({
    privilegesByUrl: {
      default: { ...removedPayload, data: [{ ...removedPayload.data[0], album_audio_id: 0 }] },
    },
    getSongUrl: async () => ({
      status: 1,
      hash: OLD_HASH,
      url: ['https://audio.example/same.mp3'],
    }),
  });
  await resolver.resolveAudioUrl(
    {
      id: track.id,
      hash: track.hash,
      albumId: track.albumId,
      title: track.title,
      mixSongId: 27602112,
    },
    { forceReload: true },
  );
  assert.equal(calls[0]?.albumAudioId, '27602112');
});

test("a '0' albumAudioId placeholder falls back to mixSongId", async () => {
  const { resolver, calls } = setupResolver({
    privilegesByUrl: {
      default: { ...removedPayload, data: [{ ...removedPayload.data[0], album_audio_id: 0 }] },
    },
    getSongUrl: async () => ({
      status: 1,
      hash: OLD_HASH,
      url: ['https://audio.example/same.mp3'],
    }),
  });
  await resolver.resolveAudioUrl(
    {
      id: track.id,
      hash: track.hash,
      albumId: track.albumId,
      title: track.title,
      albumAudioId: '0',
      mixSongId: 27602112,
    },
    { forceReload: true },
  );
  assert.equal(calls[0]?.albumAudioId, '27602112');
});

test('healthy catalog rights never trigger the tracker probe', async () => {
  const { resolver, calls } = setupResolver({
    privilegesByUrl: { default: rediscoveredPayload },
    getSongUrl: async () => ({ status: 1, url: ['https://audio.example/standard.mp3'] }),
  });
  const result = await resolver.resolveAudioUrl(
    { ...track, hash: NEW_HASH },
    { forceReload: true },
  );
  assert.deepEqual(
    calls.map((call) => call.quality),
    ['128'],
    'only the ordinary quality request runs, no empty-quality probe',
  );
  assert.equal(result.url, 'https://audio.example/standard.mp3');
  assert.equal(result.failureReason, undefined);
});

test('a rejected tracker probe keeps the fallback chain and the unsupported failure', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: { default: removedPayload },
    getSongUrl: async (_hash, quality) => {
      if (quality === '') throw new Error('tracker unavailable');
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.deepEqual(
    calls.filter((call) => call.quality === ''),
    [
      {
        hash: OLD_HASH,
        quality: '',
        ppageId: undefined,
        albumId: '69386141',
        albumAudioId: '588704117',
      },
    ],
    'the failed probe is not retried',
  );
  assert.deepEqual(ensureCalls, [OLD_HASH], 'no rights refresh after a failed probe');
  assert.equal(result.url, '');
  assert.equal(result.failureReason, '歌曲不支持');
});

test('relate_goods entries short-circuit the probe even when quality_vip reports nothing', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: {
      default: {
        ...removedPayload,
        data: [{ ...removedPayload.data[0], relate_goods: [{ hash: OLD_HASH, quality: '128' }] }],
      },
    },
    getSongUrl: async (_hash, quality) => {
      if (quality === '') throw new Error('probe must not run');
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.deepEqual(
    calls.filter((call) => call.quality === ''),
    [],
    'existing rights entries are the next-matching signal that a probe is pointless',
  );
  assert.deepEqual(ensureCalls, [OLD_HASH]);
  assert.equal(result.url, '');
  assert.equal(result.failureReason, '歌曲不支持');
});

test('a nested tracker response still yields the re-discovered hash', async () => {
  const { resolver, calls, ensureCalls } = setupResolver({
    privilegesByUrl: { [OLD_HASH.toLowerCase()]: removedPayload, default: rediscoveredPayload },
    getSongUrl: async (_hash, quality) => {
      if (quality === '') {
        // 兼容 data 包一层的历史响应形态，hash 从 data 内读取
        return { status: 1, data: { hash: NEW_HASH, url: ['https://audio.example/probe.mp3'] } };
      }
      return { status: 1, url: ['https://audio.example/standard.mp3'] };
    },
  });
  const result = await resolver.resolveAudioUrl({ ...track }, { forceReload: true });
  assert.deepEqual(
    calls.map((call) => call.quality),
    ['', '128'],
  );
  assert.deepEqual(ensureCalls, [OLD_HASH, NEW_HASH.toLowerCase()]);
  assert.equal(result.url, 'https://audio.example/standard.mp3');
  assert.equal(result.failureReason, undefined);
});
