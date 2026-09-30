import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as offset from '../src/shared/lyricOffset.ts';
import * as opencc from '../src/shared/opencc.ts';

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
