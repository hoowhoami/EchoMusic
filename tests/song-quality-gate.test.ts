import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Song } from '../src/renderer/models/song.ts';
import {
  clampPreferredAudioQuality,
  doesRelateGoodMatchQuality,
  getAvailableSongQualities,
  getSongEffectTags,
  getSongQualityCandidates,
  getSongQualityTag,
  getSongQualityTags,
  resolveEffectiveSongQuality,
} from '../src/renderer/utils/song.ts';

const song: Pick<Song, 'relateGoods'> = {
  relateGoods: [
    { quality: '128', level: 2, hash: 'standard' },
    { quality: '320', level: 4, hash: 'hq' },
    { quality: 'flac', level: 5, hash: 'flac' },
    { quality: 'high', level: 6, hash: 'high' },
    { quality: 'viper_clear', level: 0, hash: 'clear' },
    { quality: 'viper_tape', level: 101, hash: 'tape' },
    { quality: 'viper_atmos', level: 0, hash: 'atmos' },
  ],
};

test('all seven qualities are available when viper qualities are enabled', () => {
  assert.deepEqual(getAvailableSongQualities(song), [
    '128',
    '320',
    'flac',
    'high',
    'viper_clear',
    'viper_tape',
    'viper_atmos',
  ]);
  for (const quality of ['viper_clear', 'viper_tape', 'viper_atmos'] as const) {
    assert.equal(clampPreferredAudioQuality(quality), quality);
    assert.equal(resolveEffectiveSongQuality(song, quality), quality);
    assert.deepEqual(getSongQualityCandidates(quality, false), [quality]);
  }
});

test('one feature switch removes all viper candidates without affecting resource tags', () => {
  assert.deepEqual(getAvailableSongQualities(song, false), ['128', '320', 'flac', 'high']);
  for (const quality of ['viper_clear', 'viper_tape', 'viper_atmos'] as const) {
    assert.equal(clampPreferredAudioQuality(quality, false), 'high');
    assert.equal(resolveEffectiveSongQuality(song, quality, true, false), 'high');
    assert.deepEqual(getSongQualityCandidates(quality, true, false), [
      'high',
      'flac',
      '320',
      '128',
    ]);
    assert.deepEqual(getSongQualityCandidates(quality, false, false), ['high']);
  }
  assert.ok(getSongQualityTags(song.relateGoods).includes('母带'));
});

test('compatibility fallback follows the supported quality order', () => {
  assert.deepEqual(getSongQualityCandidates('viper_atmos'), [
    'viper_atmos',
    'viper_tape',
    'viper_clear',
    'high',
    'flac',
    '320',
    '128',
  ]);
  assert.deepEqual(getSongQualityCandidates('viper_clear'), [
    'viper_clear',
    'high',
    'flac',
    '320',
    '128',
  ]);
  assert.equal(
    resolveEffectiveSongQuality(
      { relateGoods: song.relateGoods?.filter((item) => item.quality !== 'viper_atmos') },
      'viper_atmos',
    ),
    'viper_tape',
  );
});

test('special qualities with level zero or a shared hash are matched by quality', () => {
  const clear = { quality: 'viper_clear', level: 0, hash: 'shared' };
  const atmos = { quality: 'viper_atmos', level: 0, hash: 'shared' };
  assert.equal(doesRelateGoodMatchQuality(clear, 'viper_clear'), true);
  assert.equal(doesRelateGoodMatchQuality(clear, 'viper_atmos'), false);
  assert.equal(doesRelateGoodMatchQuality(atmos, 'viper_tape'), false);
  assert.equal(doesRelateGoodMatchQuality(atmos, '128'), false);
  assert.equal(doesRelateGoodMatchQuality({ level: 1 }, '128'), true);
});

test('song card badge omits master tape while detail quality tags retain it', () => {
  assert.deepEqual(getSongQualityTags(song.relateGoods), [
    'HQ',
    'SQ',
    'Hi-Res',
    '超清',
    '母带',
    '全景声',
  ]);
  assert.deepEqual(getSongEffectTags(song.relateGoods), []);
  assert.equal(getSongQualityTag(song), '全景声');
  assert.equal(getSongQualityTag({ relateGoods: [{ quality: 'viper_clear', level: 0 }] }), '超清');
  assert.equal(getSongQualityTag({ qualityMap: 1 << 24 }), '');
});
