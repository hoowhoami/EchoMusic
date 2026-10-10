import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSongInfoText, getSongDisplayTitle } from '../src/renderer/utils/song.ts';
import type { Song } from '../src/renderer/models/song.ts';

const song = (overrides: Partial<Song>): Song => ({
  id: '1',
  title: '',
  artist: '',
  duration: 0,
  coverUrl: '',
  audioUrl: '',
  hash: 'hash-1',
  ...overrides,
});

// 接口把 songname 直接填成「歌手 - 歌名」时，mapper 把它留在 title、把剥离
// 后的歌名放进 name。复制必须用 name，否则歌手会和 title 里的前缀叠两遍。
test('copy info uses the display name, not the raw title', () => {
  assert.equal(
    formatSongInfoText(song({ title: '苏打绿 - 小情歌', name: '小情歌', artist: '苏打绿' })),
    '小情歌 - 苏打绿',
  );
});

test('copy info falls back to the raw title and strips the artist prefix', () => {
  // 部分 Song 构造点没有 name（测试/插件数据），此时回落到 title，
  // 但不能把「歌手 - 歌名」原样再拼一次歌手。
  assert.equal(
    formatSongInfoText(song({ title: '苏打绿 - 小情歌', artist: '苏打绿' })),
    '小情歌 - 苏打绿',
  );
});

test('copy info strips the artist prefix for multi-artist songs', () => {
  assert.equal(
    formatSongInfoText(
      song({
        title: '周杰伦, 费玉清 - 千里之外',
        artists: [{ name: '周杰伦' }, { name: '费玉清' }],
        artist: '周杰伦, 费玉清',
      }),
    ),
    '千里之外 - 周杰伦, 费玉清',
  );
});

test('copy info keeps a title that does not carry the artist prefix', () => {
  assert.equal(
    formatSongInfoText(song({ title: '小情歌', name: '小情歌', artist: '苏打绿' })),
    '小情歌 - 苏打绿',
  );
  // 纯文件名场景：没有 name、title 不带前缀。
  assert.equal(formatSongInfoText(song({ title: '小情歌', artist: '苏打绿' })), '小情歌 - 苏打绿');
});

test('copy info handles a missing artist', () => {
  assert.equal(formatSongInfoText(song({ title: '小情歌', name: '小情歌' })), '小情歌');
  assert.equal(formatSongInfoText(song({ title: '小情歌' })), '小情歌');
});

test('copy info handles a missing title', () => {
  assert.equal(formatSongInfoText(song({ artist: '苏打绿' })), '苏打绿');
  assert.equal(formatSongInfoText(song({})), '');
});

test('display title prefers name and never falls back to an artist-prefixed title', () => {
  assert.equal(getSongDisplayTitle({ title: '苏打绿 - 小情歌', name: '小情歌' }), '小情歌');
  assert.equal(
    getSongDisplayTitle({ title: '苏打绿 - 小情歌', name: '', artist: '苏打绿' }),
    '小情歌',
  );
  assert.equal(getSongDisplayTitle({ title: '小情歌', name: '小情歌' }), '小情歌');
  assert.equal(getSongDisplayTitle({ title: '', name: '' }), '');
});
