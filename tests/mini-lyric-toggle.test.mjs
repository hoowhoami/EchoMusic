import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const panel = readFileSync(
  new URL('../src/renderer/miniPlayer/MiniLyricPanel.vue', import.meta.url),
  'utf8',
);
const resolverCode = panel.slice(
  panel.indexOf('const resolveLyricSecondaryLines ='),
  panel.indexOf('const lyricEntries ='),
);
const resolve = (lyric, line, ruby = false) =>
  new Function(
    'props',
    'isRubyLine',
    `${transformSync(resolverCode, { loader: 'ts' }).code};return resolveLyricSecondaryLines;`,
  )(
    { lyric },
    () => ruby,
  )(line);

test('translation switch hides translated text even when enabled romanization is missing', () => {
  const line = { text: 'Original', translated: '译文', romanized: '' };
  assert.deepEqual(resolve({ wantTranslation: true, wantRomanization: true }, line), [
    { text: '译文', kind: 'translation' },
  ]);
  assert.deepEqual(resolve({ wantTranslation: false, wantRomanization: true }, line), []);
});

test('translation and romanization remain independent across missing data and ruby mode', () => {
  const line = { translated: '译文', romanized: 'roman' };
  assert.deepEqual(resolve({ wantTranslation: false, wantRomanization: true }, line), [
    { text: 'roman', kind: 'romanization' },
  ]);
  assert.deepEqual(resolve({ wantTranslation: true, wantRomanization: false }, line), [
    { text: '译文', kind: 'translation' },
  ]);
  assert.deepEqual(
    resolve({ wantTranslation: true, wantRomanization: false }, { romanized: 'roman' }),
    [],
  );
  assert.deepEqual(resolve({ wantTranslation: true, wantRomanization: true }, line, true), [
    { text: '译文', kind: 'translation' },
  ]);
  assert.deepEqual(resolve({ wantTranslation: false, wantRomanization: true }, line, true), []);
  assert.deepEqual(resolve({ wantTranslation: false, wantRomanization: false }, line), []);
});

test('real mini command handler changes each preference without changing the other', () => {
  const sync = readFileSync(new URL('../src/renderer/miniPlayer/sync.ts', import.meta.url), 'utf8');
  const code = transformSync(
    sync.slice(
      sync.indexOf('const executeMiniPlayerCommand ='),
      sync.indexOf('export const initMiniPlayerSync'),
    ),
    { loader: 'ts' },
  ).code;
  const lyric = { wantTranslation: true, wantRomanization: true, showRomanizationAsRuby: false };
  const command = new Function('useLyricStore', `${code};return executeMiniPlayerCommand;`)(
    () => lyric,
  );
  command('toggleTranslation');
  assert.equal(lyric.wantTranslation, false);
  assert.equal(lyric.wantRomanization, true);
  command('toggleTranslation');
  assert.equal(lyric.wantTranslation, true);
  command('toggleRomanization');
  assert.equal(lyric.wantRomanization, false);
  assert.equal(lyric.wantTranslation, true);
});
