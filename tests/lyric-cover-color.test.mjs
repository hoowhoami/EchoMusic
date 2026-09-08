import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { normalizeAccent } from '../src/shared/accent-palette.ts';

const theme = { coverColor: '#0071e3' };
const { code } = transformSync(
  readFileSync(new URL('../src/renderer/stores/lyric.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
);
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (id) => {
    if (id === 'pinia') return { defineStore: (_name, options) => options };
    if (id === '@/utils/color')
      return { DEFAULT_ACCENT: '#0071e3', getNormalizedAccent: normalizeAccent };
    if (id === './theme') return { useThemeStore: () => theme };
    return {};
  },
  module,
  module.exports,
);
const store = module.exports.useLyricStore;

test('cover-derived lyric text uses the dark normalization without extra whitening independently of application theme', () => {
  for (const color of [
    '#000000',
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ffff00',
    '#777777',
  ]) {
    theme.coverColor = color;
    const actual = store.getters.effectivePlayedColor({ playedColor: '__cover__' });
    assert.equal(actual, normalizeAccent(color, true));

    assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '__cover__' }), actual);
  }
});

test('manual and default lyric colors are preserved', () => {
  assert.equal(store.getters.effectivePlayedColor({ playedColor: '#123456' }), '#123456');
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '#fedcba' }), '#fedcba');
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '' }), '#ffffff');
});
