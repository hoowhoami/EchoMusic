import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Song } from '../src/renderer/models/song.ts';
import { getSongUnavailableMessage } from '../src/renderer/utils/song.ts';

const createSong = (patch: Partial<Song> = {}): Song => ({
  id: '1',
  title: '测试歌曲',
  name: '测试歌曲',
  artist: '测试歌手',
  duration: 0,
  coverUrl: '',
  audioUrl: '',
  hash: '',
  mixSongId: '1',
  ...patch,
});

test('VIP song without a playable source reports the VIP requirement', () => {
  assert.equal(
    getSongUnavailableMessage(createSong({ privilege: 10, payType: 3 })),
    '需要 VIP 权限',
  );
});

test('unknown unplayable song uses a generic playback message', () => {
  assert.equal(getSongUnavailableMessage(createSong()), '暂不可播放');
});

test('playable song does not report an unavailable message', () => {
  assert.equal(getSongUnavailableMessage(createSong({ hash: 'playable-hash' })), null);
});
