import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// AMLL 引擎宿主样式：歌词字体继承（#522 回归）与歌词颜色 CSS 变量。
const compile = (path) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    () => {
      throw new Error('hostStyle.ts must stay dependency-free');
    },
    module,
    module.exports,
  );
  return module.exports;
};
const { buildAmllHostStyle } = compile('../src/renderer/views/lyric/amll/hostStyle.ts');

test('buildAmllHostStyle always carries the lyric page font family (#522)', () => {
  const style = buildAmllHostStyle('"【嵐】竹风体", system-ui, sans-serif', undefined, '#ffffff');
  assert.equal(style.fontFamily, '"【嵐】竹风体", system-ui, sans-serif');
  assert.equal('--amll-lp-color' in style, false);
});

test('buildAmllHostStyle forwards the skin text color as the amll css variable', () => {
  const style = buildAmllHostStyle('system-ui', '#ff0000', '#ff0000');
  assert.equal(style['--amll-lp-color'], '#ff0000');
  assert.equal(style.fontFamily, 'system-ui');
});

test('buildAmllHostStyle treats empty text color as unset (theme default)', () => {
  const style = buildAmllHostStyle('system-ui', '', '#ffffff');
  assert.equal('--amll-lp-color' in style, false);
});
