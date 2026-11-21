import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { normalizeAccent } from '../src/shared/accentPalette.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// 封面解码桩：计数调用并返回固定主色（绿色，色相非 0 以区分色相坍缩问题）
let extractCalls = 0;
const extractedColor = '#00ff88';

const { code } = transformSync(
  readFileSync(
    new URL('../src/renderer/views/lyric/composables/useLyricBackground.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
);

function setup() {
  extractCalls = 0;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id === 'vue')
        return {
          ref: (value) => ({ value }),
          computed: (getter) => ({
            get value() {
              return getter();
            },
          }),
          watch: (sources, callback, options) => {
            if (options?.immediate) {
              callback(
                sources.map((source) => (typeof source === 'function' ? source() : source.value)),
                undefined,
                () => {},
              );
            }
            return () => {};
          },
          onScopeDispose: () => {},
        };
      if (id === '@/utils/color')
        return {
          getNormalizedAccent: normalizeAccent,
          extractDominantColor: async () => {
            extractCalls += 1;
            return extractedColor;
          },
          waitForAbortableDelay: async () => true,
        };
      if (id === '@/plugins/coverFallback') return { coverFallbackRevision: { value: 0 } };
      if (id === '@/utils/cover') return { resolveCoverColorUrls: (url) => (url ? [url] : []) };
      return {};
    },
    module,
    module.exports,
  );
  return module.exports.useLyricBackground;
}

const lightnessOf = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

const channelsOf = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

test('dark lyric page darkens the cover color into the deep backdrop band', async () => {
  const useLyricBackground = setup();
  const isDark = { value: true };
  const background = useLyricBackground({ value: 'mock://cover-300' }, isDark);
  await tick();
  await tick();
  const color = background.backgroundColor.value;
  assert.match(color, /^#[0-9a-f]{6}$/);
  const l = lightnessOf(color);
  assert.ok(l >= 0.12 && l <= 0.22, `深色背景亮度应在 0.12~0.22，实际 ${l}`);
  // 色相保持：绿色封面主色在输出中 G 通道必须最大（防止色相坍缩为灰）
  const { r, g, b } = channelsOf(color);
  assert.ok(g > r && g > b, `绿色封面应保持绿色相，实际输出 ${color}`);
  // 同一封面在深浅档间派生切换，不应重新解码封面
  isDark.value = false;
  const lightColor = background.backgroundColor.value;
  const lightL = lightnessOf(lightColor);
  assert.ok(lightL >= 0.86 && lightL <= 0.94, `浅色背景亮度应在 0.86~0.94，实际 ${lightL}`);
  const lightChannels = channelsOf(lightColor);
  assert.ok(
    lightChannels.g > lightChannels.r && lightChannels.g > lightChannels.b,
    `浅色档绿色封面应保持绿色相，实际输出 ${lightColor}`,
  );
  assert.equal(extractCalls, 1);
});

test('light lyric page tints the cover color into the soft light band', async () => {
  const useLyricBackground = setup();
  const background = useLyricBackground({ value: 'mock://cover-300' }, { value: false });
  await tick();
  await tick();
  const color = background.backgroundColor.value;
  assert.match(color, /^#[0-9a-f]{6}$/);
  const l = lightnessOf(color);
  assert.ok(l >= 0.86 && l <= 0.94, `浅色背景亮度应在 0.86~0.94，实际 ${l}`);
});

test('missing cover keeps the background empty across both appearances', async () => {
  const useLyricBackground = setup();
  const background = useLyricBackground({ value: '' }, { value: false });
  await tick();
  await tick();
  assert.equal(background.backgroundColor.value, '');
});
