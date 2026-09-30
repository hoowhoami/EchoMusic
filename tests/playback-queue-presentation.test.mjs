import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const module = { exports: {} };
const source = readFileSync(
  new URL('../src/renderer/utils/playbackQueuePresentation.ts', import.meta.url),
  'utf8',
);
new Function('module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(
  module,
  module.exports,
);
const { getPlaybackQueuePresentation: present, getPlaybackQueueStatus: status } = module.exports;
const queue = (type, title, subtitle = '', id = `queue:${type}`) => ({ id, type, title, subtitle });

test('discover uses the same concise name for new and persisted queues', () => {
  for (const title of ['刷歌', '发现下一首']) {
    assert.deepEqual(present(queue('home-discover', title, '为你推荐')), {
      title: '刷歌',
      subtitle: '',
      typeLabel: '刷歌',
    });
  }
});

test('concrete names are not replaced by promotional subtitles or category labels', () => {
  const cases = [
    ['daily-recommend', '每日推荐', '为你量身定制'],
    ['fm', '红心 Radio', '猜你喜欢'],
    ['fm', '小众 Radio', '小众推荐'],
    ['ranking', '飙升榜', '实时热门趋势'],
    ['artist', '李荣浩', '热门歌曲'],
    ['history', '播放历史', '最近播放记录'],
    ['cloud', '云盘音乐', '你的云盘收藏'],
    ['manual', '我的队列', '手动点播与整理'],
    ['purchased', '已购音乐', '已购单曲'],
    ['listen-together', '一起听', '众乐房 · 房间同步'],
    ['default', '新歌速递', '发现新鲜声音'],
  ];
  for (const [type, title, subtitle] of cases) {
    assert.equal(present(queue(type, title, subtitle)).title, title);
    assert.equal(present(queue(type, title, subtitle)).subtitle, '', type);
  }
});

test('secondary information only shows real source metadata', () => {
  for (const [type, title, subtitle] of [
    ['album', '黑马', '李荣浩'],
    ['playlist', '夜间音乐', '收藏者'],
    ['search', '歌词搜索', '夏天'],
    ['style-recommend', '风格推荐', '流行 / 华语'],
  ]) {
    assert.equal(present(queue(type, ` ${title} `, ` ${subtitle} `)).subtitle, subtitle);
    assert.equal(present(queue(type, title)).subtitle, '');
    assert.equal(present(queue(type, title, title)).subtitle, '');
  }
  assert.equal(present(queue('playlist', '我最喜爱', '收藏歌曲', 'queue:favorites')).subtitle, '');
  assert.equal(present(queue('search', '歌词搜索', '歌曲搜索')).subtitle, '');
  assert.equal(present(queue('style-recommend', '风格推荐', '默认推荐')).subtitle, '');
  assert.equal(present(queue('album', '黑马', '专辑')).subtitle, '');
});

test('empty drawer has a neutral title and no current status', () => {
  assert.deepEqual(present(null), { title: '播放队列', subtitle: '', typeLabel: '' });
  assert.equal(status(null, null), '');
  assert.equal(present(queue('album', ' ')).title, '专辑');
});

test('current status follows queue identity, independently of playback or browsing state', () => {
  const current = queue('album', '同名专辑', '歌手', 'album:1');
  const history = { ...current, id: 'album:2' };
  const manual = queue('manual', '我的队列');
  assert.equal(status(current, current.id), '当前');
  assert.equal(status(history, current.id), '历史');
  assert.equal(status(manual, current.id), '待播');
  assert.equal(status(manual, manual.id), '当前');
  assert.equal(status(history, null), '历史');
  assert.equal(status(current, history.id), '历史');
});
