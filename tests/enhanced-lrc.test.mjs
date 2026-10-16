import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as offset from '../src/shared/lyricOffset.ts';
import * as opencc from '../src/shared/opencc.ts';
import { hasWordByWordTiming, normalizeLyricLinePayload } from '../src/shared/lyrics.ts';

function compile(file, mocks, window = {}) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  });
  new Function('require', 'module', 'exports', 'window', code)(
    (id) => {
      if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
}

const { useLyricStore } = compile('../src/renderer/stores/lyric.ts', {
  pinia,
  '@/api/music': {},
  '@/utils/logger': {},
  '@/utils/color': { DEFAULT_ACCENT: '#0071e3' },
  '@/plugins/lyrics': {},
  '@/services/opencc': { convertLyricLinesForDisplay: async (lines) => lines },
  './theme': {},
  '../../shared/lyricOffset': offset,
  '../../shared/embeddedMetadata': embeddedTags,
  '../../shared/opencc': opencc,
});

const createStore = () => useLyricStore(pinia.createPinia());

const simplifyCharacters = (line) =>
  line.characters.map(({ text, startTime, endTime }) => ({ text, startTime, endTime }));

test('plain LRC without inline timestamps keeps the existing whole-line fallback', () => {
  const lyric = createStore();
  lyric.setLyric('[00:01.00]Hello world', 'plain');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].time, 1);
  assert.equal(lyric.lines[0].text, 'Hello world');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: 'Hello world', startTime: 1000, endTime: 4000 },
  ]);
});

test('enhanced LRC inline timestamps become word-level lyric characters', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>她', 'enhanced');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].time, 47.38);
  assert.equal(lyric.lines[0].text, '锁着她');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
    { text: '她', startTime: 47970, endTime: 50970 },
  ]);
});

test('a trailing enhanced LRC timestamp closes the previous segment without adding text', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>', 'closing-tag');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].text, '锁着');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
  ]);
});

test('text before the first enhanced LRC timestamp starts at the line timestamp', () => {
  const lyric = createStore();
  lyric.setLyric('[00:10.00]Intro <00:10.50>后半句<00:11.00>', 'prefix');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].text, 'Intro 后半句');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: 'Intro ', startTime: 10000, endTime: 10500 },
    { text: '后半句', startTime: 10500, endTime: 11000 },
  ]);
});

// charactersEstimated 标记「这行没有真实逐字时间戳」。所有歌词表面据此整行直显，
// 不拿估算值做卡拉OK 高亮——那会让高亮进度与真实演唱完全脱节。
test('plain LRC marks its whole-line fallback as estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[00:18.90]檐下风铃还没睡醒', 'estimated-plain');

  assert.equal(lyric.lines[0].charactersEstimated, true);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), false);
});

test('enhanced LRC keeps real per-character timing and is not marked estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>她', 'estimated-enhanced');

  assert.equal(lyric.lines[0].charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), true);
});

test('KRC with per-character tags is real word-by-word data', () => {
  const lyric = createStore();
  lyric.setLyric('[18900,4000]<0,400,0>檐<400,400,0>下<800,400,0>风', 'estimated-krc-real');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), true);
});

test('KRC without per-character tags marks the evenly spread timeline as estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[18900,4000]檐下风铃还没睡醒', 'estimated-krc-fallback');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].characters.length, 8, '仍按字数均分出字符，供主歌词页估算着色');
  assert.equal(lyric.lines[0].charactersEstimated, true);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), false);
});
