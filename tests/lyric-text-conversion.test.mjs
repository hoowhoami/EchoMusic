import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as opencc from '../src/shared/opencc.ts';

const module = { exports: {} };
const { code } = transformSync(
  readFileSync(new URL('../src/shared/lyricTextConversion.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
);
new Function('require', 'module', 'exports', code)(
  (id) => {
    if (id === './opencc') return opencc;
    if (id === './lyrics') return {};
    throw new Error(`Unexpected dependency: ${id}`);
  },
  module,
  module.exports,
);
const { applyLyricTextConversion, buildLyricTextConversionRequest } = module.exports;

test('lyric text conversion targets visible Chinese text without touching romanization', () => {
  const lines = [
    {
      time: 1,
      text: '后臺',
      translated: '開放中文轉換',
      romanized: 'hou tai',
      characters: [
        { text: '后', startTime: 1000, endTime: 1100, highlighted: true },
        { text: '臺', startTime: 1100, endTime: 1200, highlighted: false },
      ],
      translatedCharacters: [{ text: '開', startTime: 1000, endTime: 1100, highlighted: false }],
      romanizedCharacters: [{ text: 'hou', startTime: 1000, endTime: 1100, highlighted: false }],
      rubyUnits: [
        {
          text: '后',
          ruby: 'hou',
          startTime: 1000,
          endTime: 1100,
          charStart: 0,
          chars: [{ text: '后', startTime: 1000, endTime: 1100, highlighted: true }],
        },
      ],
    },
  ];

  const request = buildLyricTextConversionRequest(lines, 'simplified');
  assert.equal(request.profile, 't2s');
  assert.deepEqual(new Set(request.texts), new Set(['后臺', '開放中文轉換', '后', '臺', '開']));

  const converted = applyLyricTextConversion(
    lines,
    new Map([
      ['后臺', '后台'],
      ['開放中文轉換', '开放中文转换'],
      ['后', '后'],
      ['臺', '台'],
      ['開', '开'],
    ]),
  );

  assert.equal(converted[0].text, '后台');
  assert.equal(converted[0].translated, '开放中文转换');
  assert.equal(converted[0].romanized, 'hou tai');
  assert.equal(converted[0].characters[1].text, '台');
  assert.equal(converted[0].characters[0].highlighted, true);
  assert.equal(converted[0].characters[0].startTime, 1000);
  assert.equal(converted[0].translatedCharacters[0].text, '开');
  assert.equal(converted[0].romanizedCharacters[0].text, 'hou');
  assert.equal(converted[0].rubyUnits[0].text, '后');
  assert.equal(converted[0].rubyUnits[0].ruby, 'hou');
  assert.equal(converted[0].rubyUnits[0].chars[0].highlighted, true);
});

test('lyric text conversion request is empty for original mode', () => {
  const request = buildLyricTextConversionRequest(
    [{ time: 0, text: '開放中文轉換', characters: [] }],
    'none',
  );
  assert.equal(request.profile, null);
  assert.deepEqual(request.texts, []);
});
