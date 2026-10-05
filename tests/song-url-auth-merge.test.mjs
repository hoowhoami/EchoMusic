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
const session = compile('../src/renderer/utils/userSession.ts');
const setup = (send) => {
  const user = { isLoggedIn: true, accountRevision: 0, info: { userid: 1, token: 'first' } };
  const origins = compile('../src/renderer/utils/serverInterceptors.ts');
  const calls = [];
  const request = {
    get: (url, config) => {
      calls.push({ url, ...config, origin: origins.getCurrentRequestOrigin() });
      return send(url, config);
    },
  };
  const userApi = compile('../src/renderer/api/user.ts', { '@/utils/request': request });
  const music = compile('../src/renderer/api/music.ts', {
    '@/utils/request': request,
    './user': userApi,
    '@/stores/user': { useUserStore: () => user },
    '@/utils/userSession': session,
    '@/utils/serverInterceptors': origins,
  });
  return { music, user, origins, calls };
};
const verified = { status: 1, data: { auth: 'user-authorization' } };

test('song URLs fetch user auth and use merge, preserving quality, album IDs and ppage_id', async () => {
  const result = { status: 1, url: ['primary'], backupUrl: ['backup'], volume_gain: 2 };
  const api = setup(async (url) => (url === '/user/verify' ? verified : result));
  for (const quality of [
    '128',
    '320',
    'flac',
    'high',
    'viper_atmos',
    'viper_clear',
    'viper_tape',
    'super',
    'piano',
    'acappella',
    'subwoofer',
    'ancient',
    'surnay',
    'dj',
  ]) {
    assert.equal(
      await api.music.getSongUrl('hash', quality, 356753938, {
        albumId: '42',
        albumAudioId: '81',
      }),
      result,
    );
    assert.equal(api.calls.at(-2).url, '/user/verify');
    assert.deepEqual(api.calls.at(-1).params, {
      hash: 'hash',
      quality,
      auth: 'user-authorization',
      ppage_id: 356753938,
      album_id: '42',
      album_audio_id: '81',
    });
    assert.equal(api.calls.at(-1).url, '/song/url/auth/merge');
  }
});

test('default requests omit unknown album IDs; supplied auth skips user verification', async () => {
  const api = setup(async () => verified);
  await api.music.getSongUrl('hash');
  assert.deepEqual(api.calls.at(-1).params, {
    hash: 'hash',
    quality: '',
    auth: 'user-authorization',
  });
  api.calls.length = 0;
  await api.music.getSongUrl('hash', '320', undefined, { auth: 'explicit' });
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ['/song/url/auth/merge'],
  );
  assert.equal(api.calls[0].params.auth, 'explicit');
});

test('both asynchronous stages retain the plugin request origin', async () => {
  const api = setup(async () => verified);
  const origin = { type: 'plugin', pluginId: 'source-plugin' };
  await api.origins.runWithRequestOrigin(origin, () => api.music.getSongUrl('hash'));
  assert.ok(api.calls.every((call) => call.origin === origin));
  assert.equal(api.origins.getCurrentRequestOrigin().type, 'host');
});

test('failed or incomplete verification never calls merge with empty auth', async () => {
  for (const response of [
    { status: 0, error_code: 20018 },
    { status: 1, data: {} },
    { status: 1, data: { auth: ' ' } },
  ]) {
    const api = setup(async () => response);
    await assert.rejects(api.music.getSongUrl('hash'), (error) => error.response === response);
    assert.deepEqual(
      api.calls.map((call) => call.url),
      ['/user/verify'],
    );
  }
  const failure = new Error('network failure');
  const api = setup(async () => {
    throw failure;
  });
  await assert.rejects(api.music.getSongUrl('hash'), (error) => error === failure);
  assert.equal(api.calls.length, 1);
});

test('account or token changes during verification cannot authorize a request for the new session', async () => {
  for (const change of [
    (user) => {
      user.accountRevision++;
    },
    (user) => {
      user.info.token = 'second';
    },
    (user) => {
      user.isLoggedIn = false;
    },
  ]) {
    let resolve;
    const api = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = api.music.getSongUrl('hash');
    change(api.user);
    resolve(verified);
    await assert.rejects(pending, /登录状态已变化/);
    assert.equal(api.calls.length, 1);
  }
});

test('merge failures propagate without falling back to the old URL endpoint', async () => {
  const failure = new Error('merge rejected');
  const api = setup(async (url) => {
    if (url === '/user/verify') return verified;
    throw failure;
  });
  await assert.rejects(api.music.getSongUrl('hash'), (error) => error === failure);
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ['/user/verify', '/song/url/auth/merge'],
  );
});

const setupResolver = (api) => {
  const song = compile('../src/renderer/utils/song.ts');
  const cover = { normalizeCoverUrl: (value) => value, resolveCoverDisplayUrl: (value) => value };
  const utils = compile('../src/renderer/stores/player/utils.ts', {
    '@/utils/song': song,
    '@/utils/cover': cover,
    '../../../shared/loudness': compile('../src/shared/loudness.ts'),
  });
  const { createResolver } = compile('../src/renderer/stores/player/resolver.ts', {
    '@/api/music': api.music,
    '@/utils/logger': { debug() {}, info() {}, warn() {} },
    '@/utils/cover': cover,
    '@/utils/song': song,
    '@/plugins/audioSource': {
      resolvePluginAudioSource: async () => null,
      transformPluginAudioSource: async (_context, source) => source,
    },
    '@/services/cloudAudioIndex': { getCloudAudioSourceForSong: async () => null },
    './utils': utils,
  });
  const state = { audioEffect: 'none', currentTrackId: 'song' };
  const settings = { defaultAudioQuality: '320', compatibilityMode: true };
  return {
    state,
    resolver: createResolver(state, { refreshFavoriteSongIdentity() {} }, settings),
  };
};

test('player forwards fresh privilege album IDs through quality, effect and default fallback requests', async () => {
  for (const effect of ['none', 'piano']) {
    const api = setup(async (url, config) => {
      if (url === '/user/verify') return verified;
      if (url === '/privilege/lite')
        return {
          data: [
            {
              album_id: '42',
              album_audio_id: '81',
              relate_goods: [{ hash: 'quality-hash', quality: '320' }],
            },
          ],
        };
      if (url === '/song/url/auth/merge') {
        return { status: 1, url: config.params.ppage_id ? ['primary', 'backup'] : [] };
      }
      throw new Error(url);
    });
    const { resolver, state } = setupResolver(api);
    state.audioEffect = effect;
    const resolved = await resolver.resolveAudioUrl({ id: 'song', hash: 'hash', audioUrl: '' });
    assert.deepEqual(resolved.urls, ['primary', 'backup']);
    const mergeCalls = api.calls.filter((call) => call.url === '/song/url/auth/merge');
    assert.ok(mergeCalls.length >= 3);
    assert.ok(
      mergeCalls.every(
        (call) => call.params.album_id === '42' && call.params.album_audio_id === '81',
      ),
    );
    assert.equal(mergeCalls[0].params.quality, effect === 'none' ? '320' : 'piano');
    assert.equal(mergeCalls.at(-1).params.ppage_id, 356753938);
  }
});
