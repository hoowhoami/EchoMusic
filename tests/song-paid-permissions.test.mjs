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
const shared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': cover,
  '../../../shared/object': compile('../src/shared/object.ts'),
});
const { mapPlaylistSong } = compile('../src/renderer/utils/mappers/song.ts', {
  './shared': shared,
});
const song = compile('../src/renderer/utils/song.ts');
const utils = compile('../src/renderer/stores/player/utils.ts', {
  '@/utils/song': song,
  '@/utils/cover': cover,
  '../../../shared/loudness': compile('../src/shared/loudness.ts'),
});

// Selected fields from the actual favorites and /privilege/lite responses on 2026-10-05.
const favorite = {
  name: '儿歌多多 - 数鸭子 (幼儿园早教儿歌).mp3',
  hash: '4175D3FCC338A358A9631318B239E54F',
  mixsongid: 588704117,
  audio_id: 313621529,
  album_id: '69386141',
  albuminfo: { id: 69386141, name: '儿歌多多幼儿园歌曲|启蒙儿歌' },
  timelen: 103627,
  media_privilege: 10,
  media_pay_type: 2,
  media_old_cpy: 0,
  trans_param: { audio_privilege: 10, pay_block_tpl: 2 },
};
const rights = {
  type: 'album',
  hash: favorite.hash,
  album_id: favorite.album_id,
  album_audio_id: favorite.mixsongid,
  privilege: 10,
  pay_type: 2,
  old_cpy: 0,
  status: 0,
  topic_remark: '购买专辑',
  relate_goods: [{ hash: favorite.hash, quality: '128', level: 2 }],
};

const setupResolver = (payload = rights, url = '', options = {}) => {
  const refreshed = [];
  const { createResolver, parseTrackMetadataFromPrivilege } = compile(
    '../src/renderer/stores/player/resolver.ts',
    {
      '@/api/music': {
        getSongPrivilegeLite: async () => ({ status: 1, data: [payload] }),
        getSongUrl: options.getSongUrl ?? (async () => ({ status: 1, url: url ? [url] : [] })),
      },
      '@/utils/logger': { debug() {}, info() {}, warn() {} },
      '@/utils/cover': cover,
      '@/utils/song': song,
      '@/plugins/audioSource': {
        resolvePluginAudioSource: async () => null,
        transformPluginAudioSource: async (_context, source) => source,
      },
      '@/services/cloudAudioIndex': { getCloudAudioSourceForSong: async () => null },
      './utils': utils,
    },
  );
  const resolver = createResolver(
    { audioEffect: 'none', currentTrackId: String(favorite.mixsongid) },
    { refreshFavoriteSongIdentity: (track) => refreshed.push(track) },
    { defaultAudioQuality: options.quality ?? '128', compatibilityMode: true },
  );
  return { resolver, refreshed, parseTrackMetadataFromPrivilege };
};

test('actual favorite media permission fields restore the paid tag and purchase failure hint', () => {
  const track = mapPlaylistSong(favorite);
  assert.equal(track.privilege, 10);
  assert.equal(track.payType, 2);
  assert.deepEqual(
    song.getSongPrivilegeTags(track).map((tag) => tag.label),
    ['付费'],
  );
  const notice = utils.resolvePlaybackNotice({ code: 'audio-url-unavailable', track });
  assert.match(notice.reason, /购买/);
  assert.equal(song.isPlayableSong(track), true);
});

test('VIP and free favorites retain their distinct permission behavior', () => {
  const vip = mapPlaylistSong({ ...favorite, media_pay_type: '3' });
  assert.deepEqual(
    song.getSongPrivilegeTags(vip).map((tag) => tag.label),
    ['VIP'],
  );
  assert.match(
    utils.resolvePlaybackNotice({
      code: 'audio-url-unavailable',
      track: vip,
      isUserNovip: true,
    }).reason,
    /VIP/,
  );
  const free = mapPlaylistSong({ ...favorite, media_privilege: 1, media_pay_type: 0 });
  assert.deepEqual(song.getSongPrivilegeTags(free), []);
  const withoutMediaPrivilege = { ...favorite };
  delete withoutMediaPrivilege.media_privilege;
  assert.equal(mapPlaylistSong(withoutMediaPrivilege).privilege, 10);
});

test('retained-source quality errors use warning toasts without setting fatal song state', () => {
  const player = readFileSync(new URL('../src/renderer/stores/player.ts', import.meta.url), 'utf8');
  const code = transformSync(
    player.slice(
      player.indexOf('    const showPlaybackNotice ='),
      player.indexOf('    const clearPlaybackNotice ='),
    ),
    { loader: 'ts' },
  ).code;
  const state = { playbackNotice: null };
  const toasts = [];
  const notify = new Function(
    'state',
    'toastStore',
    'useUserStore',
    'settingStore',
    'resolvePlaybackNotice',
    `${code}; return showPlaybackNotice;`,
  )(
    state,
    { standard: (...args) => toasts.push(args) },
    () => ({ isLoggedIn: false }),
    { autoNext: true, autoNextDelaySeconds: 3 },
    utils.resolvePlaybackNotice,
  );
  const track = mapPlaylistSong({ ...favorite, media_pay_type: 3 });
  for (const code of ['audio-quality-unavailable', 'audio-quality-switch-failed']) {
    notify(code, track);
    assert.equal(state.playbackNotice, null);
    const [message, tone, duration, action, title] = toasts.at(-1);
    assert.match(title, /^音质切换失败 · /);
    assert.match(message, /已保留原音质，继续播放/);
    assert.doesNotMatch(message, /尝试下一首|播放失败/);
    assert.equal(tone, 'warning');
    assert.equal(duration, 6000);
    assert.equal(action, undefined);
  }
  assert.match(toasts[0][0], /VIP/);
  assert.doesNotMatch(toasts[1][0], /VIP|购买/, 'decoder errors do not imply missing rights');
  notify('playback-failed', track);
  const fatalNotice = state.playbackNotice;
  assert.equal(fatalNotice.title, '播放失败');
  notify('audio-quality-unavailable', track);
  assert.equal(
    state.playbackNotice,
    fatalNotice,
    'nonfatal feedback must not overwrite a real error',
  );
  const free = mapPlaylistSong({ ...favorite, media_privilege: 1, media_pay_type: 0 });
  notify('audio-quality-unavailable', free);
  assert.doesNotMatch(toasts.at(-1)[0], /VIP|购买/);
});

test('legacy playlist permission fields keep their existing precedence', () => {
  const track = mapPlaylistSong({
    ...favorite,
    privilege: 1,
    pay_type: 0,
  });
  assert.equal(track.privilege, 1);
  assert.equal(track.payType, 0);
  const download = mapPlaylistSong({
    ...favorite,
    privilege: 10,
    download: [{ pay_type: 3 }],
  });
  assert.equal(download.payType, 3);
});

test('playback refresh enriches older cached favorites before displaying an unavailable URL notice', async () => {
  const track = mapPlaylistSong({
    ...favorite,
    media_privilege: undefined,
    media_pay_type: undefined,
    trans_param: {},
  });
  const { resolver, refreshed } = setupResolver();
  assert.deepEqual(song.getSongPrivilegeTags(track), []);
  const result = await resolver.resolveAudioUrl(track);
  assert.equal(result.url, '');
  assert.equal(track.privilege, 10);
  assert.equal(track.payType, 2);
  assert.equal(track.oldCpy, 0);
  assert.deepEqual(refreshed, [track]);
  assert.deepEqual(
    song.getSongPrivilegeTags(track).map((tag) => tag.label),
    ['付费'],
  );
  assert.match(
    utils.resolvePlaybackNotice({ code: 'audio-url-unavailable', track }).reason,
    /购买/,
  );
});

test('paid metadata still permits playback when an account or another source supplies a URL', async () => {
  const track = mapPlaylistSong(favorite);
  const { resolver } = setupResolver(rights, 'https://audio.example/authorized.mp3');
  const result = await resolver.resolveAudioUrl(track);
  assert.equal(result.url, 'https://audio.example/authorized.mp3');
  assert.equal(song.isPlayableSong(track), true);
});

test('actual VIP quality rejection survives the successful standard-quality fallback', async () => {
  // Selected fields from /song/url/auth/merge for 甲乙丙丁, verified on 2026-10-08.
  const rejected = {
    status: 2,
    trans_param: { pay_block_tpl: 1 },
    tracker_through: { identity_block: 0, all_quality_free: 0, musicpack_advance: 1 },
  };
  const calls = [];
  const vipRights = {
    ...rights,
    pay_type: 3,
    relate_goods: [
      {
        quality: 'flac',
        hash: 'lossless-hash',
        level: 5,
        status: 0,
        pay_type: 3,
        fail_process: 12,
      },
      {
        quality: '320',
        hash: 'high-quality-hash',
        level: 4,
        status: 0,
        pay_type: 3,
        fail_process: 12,
      },
      { quality: '128', hash: 'standard-hash', level: 2, status: 0, pay_type: 3, fail_process: 12 },
    ],
  };
  const track = mapPlaylistSong({ ...favorite, media_pay_type: 3 });
  const { resolver } = setupResolver(vipRights, '', {
    quality: 'flac',
    getSongUrl: async (_hash, quality) => {
      calls.push(quality);
      return quality === '128' ? { status: 1, url: ['standard-audio'] } : rejected;
    },
  });
  const result = await resolver.resolveAudioUrl(track, { forceReload: true });
  assert.deepEqual(calls, ['flac', '320', '128']);
  assert.equal(result.url, 'standard-audio', 'normal track playback can still use the fallback');
  assert.equal(result.quality, '128');
  assert.equal(result.qualityFailureReason, '所选音质需要 VIP 权限');
  const notice = utils.resolvePlaybackNotice({
    code: 'audio-quality-unavailable',
    track,
    isUserNovip: false,
    error: result.qualityFailureReason,
  });
  assert.equal(
    notice.reason,
    '所选音质需要 VIP 权限',
    'song/quality authorization overrides generic VIP account state',
  );
  assert.equal(notice.detail, '已保留原音质，继续播放');
});

test('specific upstream and player causes take precedence without guessing VIP from network or decode failures', () => {
  const vip = mapPlaylistSong({ ...favorite, media_pay_type: 3 });
  for (const [error, expected] of [
    [{ response: { body: { status: 2, msg: '当前地区无版权' } } }, '当前地区无版权'],
    [{ response: { body: { status: 0, msg: '音源授权已过期' } } }, '音源授权已过期'],
    [
      new Error(
        "Error invoking remote method 'player:switch-source': Error: source switch cancelled: insufficient prepared audio at hand-off; old source kept",
      ),
      '新音源缓冲不足，未能完成切换',
    ],
    [new Error('source switch preparation timed out'), '音源加载超时，请稍后重试'],
    [new Error('HTTP 403 Forbidden'), '音源访问被拒绝'],
    [{ errorCode: 'decode', message: 'Failed to decode audio source' }, '音频解码失败'],
    [
      { errorCode: 'network', reason: 'request-rejected', message: '当前音质需要 VIP 权限' },
      '当前音质需要 VIP 权限',
    ],
    [new Error('offline'), '网络连接异常'],
    [new Error('VIP required'), '所选音质需要 VIP 权限'],
  ]) {
    assert.equal(
      utils.resolvePlaybackNotice({ code: 'audio-quality-switch-failed', track: vip, error })
        .reason,
      expected,
    );
  }
  assert.equal(
    utils.resolveAudioFailureReason({ status: 2 }, mapPlaylistSong(favorite), true),
    '需要购买歌曲或专辑后播放',
  );
  assert.equal(
    utils.resolveAudioFailureReason({ status: 2 }, { id: 'free', privilege: 1, payType: 0 }, true),
    '此音源需要付费授权',
  );
});

test('requested-quality rights and explicit authorization override the song-level VIP badge', () => {
  const vip = mapPlaylistSong({ ...favorite, media_pay_type: 3 });
  const rejected = { status: 2 };
  assert.equal(
    utils.resolveAudioFailureReason(rejected, vip, true, { payType: 2, failProcess: 4 }),
    '需要购买歌曲或专辑后播放',
  );
  assert.equal(
    utils.resolveAudioFailureReason(rejected, vip, true, { payType: 0 }),
    '此音源需要付费授权',
  );
  assert.equal(
    utils.resolveAudioFailureReason(rejected, vip, true, { payType: 3, allQualityFree: 1 }),
    '此音源需要额外的播放授权',
  );
  assert.equal(
    utils.resolveAudioFailureReason(
      { status: 2, auth_through: { pay_type: 2, fail_process: 4 } },
      vip,
      true,
      { payType: 3, failProcess: 12 },
    ),
    '需要购买歌曲或专辑后播放',
  );
  assert.equal(
    utils.resolveAudioFailureReason({ status: 2, errmsg: '当前音质需要VIP' }, vip, true),
    '当前音质需要VIP',
  );
});

test('fresh per-quality permission records survive privilege parsing', async () => {
  const track = mapPlaylistSong(favorite);
  const { resolver } = setupResolver({
    ...rights,
    relate_goods: [
      {
        hash: 'flac-hash',
        quality: 'flac',
        level: 5,
        status: 4,
        privilege: 10,
        pay_type: 3,
        fail_process: 12,
        type: 'audio',
        trans_param: { all_quality_free: 1 },
      },
    ],
  });
  await resolver.ensureTrackRelateGoods(track, { forceReload: true });
  assert.deepEqual(track.relateGoods, [
    {
      hash: 'flac-hash',
      quality: 'flac',
      level: 5,
      status: 4,
      privilege: 10,
      payType: 3,
      failProcess: 12,
      goodsType: 'audio',
      allQualityFree: 1,
    },
  ]);
});

test('missing or malformed refreshed permissions do not erase known rights, explicit zero does', () => {
  const { parseTrackMetadataFromPrivilege } = setupResolver();
  const track = mapPlaylistSong(favorite);
  for (const value of [undefined, null, '', ' ', 'invalid', false]) {
    Object.assign(
      track,
      parseTrackMetadataFromPrivilege({
        data: [{ privilege: value, pay_type: value, old_cpy: value }],
      }),
    );
    assert.equal(track.privilege, 10);
    assert.equal(track.payType, 2);
    assert.equal(track.oldCpy, 0);
  }
  Object.assign(
    track,
    parseTrackMetadataFromPrivilege({ data: [{ privilege: '1', pay_type: '0', old_cpy: 1 }] }),
  );
  assert.equal(track.privilege, 1);
  assert.equal(track.payType, 0);
  assert.equal(track.oldCpy, 1);
  assert.deepEqual(song.getSongPrivilegeTags(track), []);
});
