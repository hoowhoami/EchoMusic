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

const setupResolver = (payload = rights, url = '') => {
  const refreshed = [];
  const { createResolver, parseTrackMetadataFromPrivilege } = compile(
    '../src/renderer/stores/player/resolver.ts',
    {
      '@/api/music': {
        getSongPrivilegeLite: async () => ({ status: 1, data: [payload] }),
        getSongUrl: async () => ({ status: 1, url: url ? [url] : [] }),
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
    { defaultAudioQuality: '128', compatibilityMode: true },
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
