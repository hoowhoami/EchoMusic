import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// 时长格式化：歌曲时长与有声时长共用同一个函数，超过一小时要有小时位（否则 3 小时显示成 180:00）。
function load(file) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, () => {
    throw new Error('Unexpected dependency');
  });
  return module.exports;
}

const { formatDuration } = load('../src/renderer/utils/format.ts');

test('不足一小时用 mm:ss', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(59), '00:59');
  assert.equal(formatDuration(61), '01:01');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3599), '59:59');
});

test('满一小时自动补小时位，长音频不再显示 180:00', () => {
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(10800), '3:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('空值与负数按 00:00 处理', () => {
  assert.equal(formatDuration(undefined), '00:00');
  assert.equal(formatDuration(Number.NaN), '00:00');
});
