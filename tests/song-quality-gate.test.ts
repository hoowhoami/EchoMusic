import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Song } from '../src/renderer/models/song.ts';
import {
  clampPreferredAudioQuality,
  getAvailableSongQualities,
  getSongDerivedState,
  getSongQualityCandidates,
  getSongQualityTag,
  getSongQualityTags,
  resolveEffectiveSongQuality,
} from '../src/renderer/utils/song.ts';

const tapeSong: Pick<Song, 'relateGoods'> = {
  relateGoods: [
    { quality: 'viper_tape', level: 101, hash: 'tape' },
    { quality: 'high', level: 6, hash: 'high' },
    { quality: 'flac', level: 5, hash: 'flac' },
    { quality: '320', level: 4, hash: 'hq' },
  ],
};

const createSong = (patch: Partial<Song> = {}): Song => ({
  id: '1',
  title: '测试歌曲',
  name: '测试歌曲',
  artist: '测试歌手',
  duration: 0,
  coverUrl: '',
  audioUrl: '',
  hash: 'playable-hash',
  mixSongId: '1',
  relateGoods: tapeSong.relateGoods,
  ...patch,
});

test('quality candidates omit viper tape when the gate is off', () => {
  assert.deepEqual(getSongQualityCandidates('viper_tape', true, false), [
    'high',
    'flac',
    '320',
    '128',
  ]);
  assert.deepEqual(getSongQualityCandidates('viper_tape', false, false), ['high']);
  assert.deepEqual(getSongQualityCandidates('viper_tape', true, true), [
    'viper_tape',
    'high',
    'flac',
    '320',
    '128',
  ]);
});

test('preferred viper tape clamps to high when the gate is off', () => {
  assert.equal(clampPreferredAudioQuality('viper_tape', false), 'high');
  assert.equal(clampPreferredAudioQuality('viper_tape', true), 'viper_tape');
  assert.equal(clampPreferredAudioQuality('flac', false), 'flac');
});

test('available qualities and tags hide 母带 when the gate is off', () => {
  assert.deepEqual(getAvailableSongQualities(tapeSong, false), ['128', '320', 'flac', 'high']);
  assert.deepEqual(getAvailableSongQualities(tapeSong, true), [
    '128',
    '320',
    'flac',
    'high',
    'viper_tape',
  ]);
  assert.equal(getSongQualityTag(tapeSong, false), 'Hi-Res');
  assert.equal(getSongQualityTag(tapeSong, true), '母带');
  assert.equal(getSongQualityTags(tapeSong.relateGoods, false).includes('母带'), false);
  assert.equal(getSongQualityTags(tapeSong.relateGoods, true)[0], '母带');
  assert.equal(getSongDerivedState(createSong(), false).qualityTag, 'Hi-Res');
  assert.equal(getSongDerivedState(createSong(), true).qualityTag, '母带');
});

test('effective quality does not resolve to viper tape when the gate is off', () => {
  assert.equal(resolveEffectiveSongQuality(tapeSong, 'viper_tape', true, false), 'high');
  assert.equal(resolveEffectiveSongQuality(tapeSong, 'viper_tape', true, true), 'viper_tape');
  assert.equal(
    resolveEffectiveSongQuality(
      { relateGoods: [{ quality: 'viper_tape', level: 101, hash: 'tape' }] },
      'viper_tape',
      true,
      false,
    ),
    '128',
  );
});
