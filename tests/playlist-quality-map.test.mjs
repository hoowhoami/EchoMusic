import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const load = (path, dependencies = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
  )(
    (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const shared = load('../src/renderer/utils/mappers/shared.ts', {
  '../cover': { normalizeCoverUrl: (value) => value },
  '../../../shared/object': load('../src/shared/object.ts'),
});
const { mapPlaylistSong } = load('../src/renderer/utils/mappers/song.ts', { './shared': shared });
const { getSongDerivedState, getAvailableSongQualities } = load('../src/renderer/utils/song.ts');

// Selected fields from live /playlist/track/all/new responses and independently
// checked against /privilege/lite on 2026-10-07 (200 matching songs).
const samples = [
  [
    '王忻辰、苏星婕 - 清空.mp3',
    { bits: '8fffc0db411ffffff3fe475', attr0: 2134893685, attr1: 1747189759 },
    '母带',
    'Hi-Res',
  ],
  [
    'Maroon 5 - Animals.mp3',
    { bits: '800000db4100000773fc035', attr0: 2000666677, attr1: 1746927616 },
    '母带',
    'SQ',
  ],
  ['梦里啥都有 - 泡沫 (Beyonce版).mp3', { bits: '7e80000004', attr0: 4, attr1: 253 }, '', ''],
  [
    '宝宝巴士 - 小燕子.mp3',
    { bits: '800000db41000003330c014', attr0: 858832916, attr1: 1746927616 },
    '母带',
    'HQ',
  ],
  [
    '儿歌多多 - 数鸭子 (幼儿园早教儿歌).mp3',
    { bits: '2001e007e80000034', attr0: 52, attr1: 3932413 },
    'SQ',
    'SQ',
  ],
  [
    'Ocean Media - ไต่ปุยจิ่ว (大悲咒).mp3',
    { bits: '800000c0000000040004074', attr0: 1073758324, attr1: 0 },
    'Hi-Res',
    'Hi-Res',
  ],
];
for (const [name, qualitymap, enabled, disabled] of samples) {
  test(`playlist and favorite mapping restores quality labels from the actual response: ${name}`, () => {
    const row = {
      name,
      hash: 'original-playback-hash',
      mixsongid: 123,
      fileid: 9,
      sort: 0,
      media_privilege: 10,
      media_pay_type: 2,
      trans_param: { qualitymap },
    };
    const song = mapPlaylistSong(row);
    assert.equal(getSongDerivedState(song, true).qualityTag, enabled);
    assert.equal(getSongDerivedState(song, false).qualityTag, disabled);
    assert.equal(song.hash, row.hash);
    assert.equal(song.fileId, row.fileid);
    assert.equal(song.playlistSort, row.sort);
    assert.equal(song.privilege, row.media_privilege);
    assert.equal(song.payType, row.media_pay_type);
    assert.deepEqual(
      song.relateGoods,
      [],
      'display bits must not bypass playback privilege/hash loading',
    );
    assert.deepEqual(getAvailableSongQualities(song), ['128']);
  });
}

test('bitmaps use 31-bit groups and support decimal strings and long hexadecimal bits without precision loss', () => {
  for (const [value, expected] of [
    [{ attr0: '2134893685' }, 2134893685],
    [{ bits: '8fffc0db411ffffff3fe475' }, 2134893685],
    [{ attr0: 'bad', bits: '2001e007e80000034' }, 52],
    [{ bits: '80000034' }, 52],
    [{ attr0: 0, bits: '74' }, 0],
  ]) {
    assert.equal(shared.readQualityMap(value), expected);
  }
});

test('missing, invalid and unrelated flags do not invent quality labels', () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { attr0: true },
    { attr0: 1.2 },
    { attr0: 2 ** 40 },
    { bits: 'xyz' },
    { attr0: 4 },
    { attr0: 1 << 23 },
  ]) {
    const song = mapPlaylistSong({ trans_param: { qualitymap: value } });
    assert.equal(getSongDerivedState(song).qualityTag, '');
  }
});

test('explicit relate_goods remains authoritative and preserves real playback hashes', () => {
  const song = mapPlaylistSong({
    trans_param: { qualitymap: { attr0: 2134893685 } },
    relate_goods: [{ quality: 'flac', level: 5, hash: 'real-flac-hash' }],
  });
  assert.equal(getSongDerivedState(song).qualityTag, 'SQ');
  assert.equal(song.relateGoods[0].hash, 'real-flac-hash');
});
