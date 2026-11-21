import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { normalizeAccent } from '../src/shared/accentPalette.ts';
import { LYRIC_PAGE_INK, resolveLyricPageIsDark } from '../src/shared/lyricPageAppearance.ts';

const theme = { coverColor: '#0071e3', isDark: true };
const setting = { lyricPageAppearanceMode: 'dark' };
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
    if (id === './setting')
      return {
        resolveLyricPageIsDark,
        useSettingStore: () => setting,
        LYRIC_PAGE_INK,
      };
    return {};
  },
  module,
  module.exports,
);
const store = module.exports.useLyricStore;

// 用例内可改动外观模式/主题桩，结束后统一复位避免污染后续用例
const resetFixtures = () => {
  setting.lyricPageAppearanceMode = 'dark';
  theme.isDark = true;
  theme.coverColor = '#0071e3';
};

test('cover-derived lyric text uses the dark normalization without extra whitening independently of application theme', (t) => {
  t.after(resetFixtures);
  setting.lyricPageAppearanceMode = 'dark';
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

test('light lyric page derives cover text with light normalization and a dark unplayed default', (t) => {
  t.after(resetFixtures);
  setting.lyricPageAppearanceMode = 'light';
  for (const color of ['#000000', '#ff0000', '#0000ff', '#777777']) {
    theme.coverColor = color;
    const actual = store.getters.effectivePlayedColor({ playedColor: '__cover__' });
    assert.equal(actual, normalizeAccent(color, false));
  }
  assert.equal(
    store.getters.effectiveUnplayedColor({ unplayedColor: '' }),
    '#1a1d22',
    '浅色档未播字色默认回退墨色',
  );
  // 手动指定的颜色不受外观分档影响
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '#fedcba' }), '#fedcba');
});

test('follow mode tracks the main program theme for cover normalization', (t) => {
  t.after(resetFixtures);
  setting.lyricPageAppearanceMode = 'follow';
  theme.coverColor = '#ff0000';
  theme.isDark = true;
  assert.equal(
    store.getters.effectivePlayedColor({ playedColor: '__cover__' }),
    normalizeAccent('#ff0000', true),
  );
  theme.isDark = false;
  assert.equal(
    store.getters.effectivePlayedColor({ playedColor: '__cover__' }),
    normalizeAccent('#ff0000', false),
  );
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '' }), '#1a1d22');
});

test('played color default follows the appearance mode for readability', (t) => {
  t.after(resetFixtures);
  // 深色档保持品牌绿
  setting.lyricPageAppearanceMode = 'dark';
  assert.equal(store.getters.effectivePlayedColor({ playedColor: '' }), '#31cfa1');
  // 浅色档回退等色相加深绿：#31cfa1 对浅背景对比度仅 ~1.8:1，且已在
  // normalizeAccent 浅色亮度带内（normalize 对它无调整效果），需显式加深常量
  setting.lyricPageAppearanceMode = 'light';
  const played = store.getters.effectivePlayedColor({ playedColor: '' });
  assert.equal(played, '#0e8f66');
  // 手动指定的已播色不受外观分档影响
  assert.equal(store.getters.effectivePlayedColor({ playedColor: '#123456' }), '#123456');
});

test('unknown appearance mode falls back to the dark default', (t) => {
  t.after(resetFixtures);
  setting.lyricPageAppearanceMode = 'bogus';
  assert.equal(
    store.getters.effectiveUnplayedColor({ unplayedColor: '' }),
    '#ffffff',
    '脏值应回退深色档默认白字',
  );
});

test('manual and default lyric colors are preserved', () => {
  assert.equal(store.getters.effectivePlayedColor({ playedColor: '#123456' }), '#123456');
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '#fedcba' }), '#fedcba');
  assert.equal(store.getters.effectiveUnplayedColor({ unplayedColor: '' }), '#ffffff');
});
