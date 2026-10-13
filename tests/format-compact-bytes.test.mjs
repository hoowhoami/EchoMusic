import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// 与服务端 quality_vip 下发的 size_text 保持同一风格：单字母单位、无空格、
// 非字节档一位小数。音质面板里的云盘文件大小也走这个函数。
const module = { exports: {} };
const source = readFileSync(new URL('../src/renderer/utils/format.ts', import.meta.url), 'utf8');
new Function('module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(
  module,
  module.exports,
);
const { formatCompactBytes } = module.exports;

test('renders the same shape as the server-provided quality size_text', () => {
  // 截图里的四行音质大小，以及 /user/cloud 实测的 FLAC 样本。
  assert.equal(formatCompactBytes(1572864), '1.5M');
  assert.equal(formatCompactBytes(5452595), '5.2M');
  assert.equal(formatCompactBytes(14495515), '13.8M');
  assert.equal(formatCompactBytes(26214400), '25.0M');
  // docs: 遠野ひかる - LOVE 2000.flac，size=62144976（59.27 MB）。
  assert.equal(formatCompactBytes(62144976), '59.3M');
});

test('picks the unit from the byte count', () => {
  assert.equal(formatCompactBytes(500), '500B');
  assert.equal(formatCompactBytes(1024), '1.0K');
  assert.equal(formatCompactBytes(1024 * 1024), '1.0M');
  assert.equal(formatCompactBytes(1024 ** 3), '1.0G');
  assert.equal(formatCompactBytes(1024 ** 4), '1.0T');
});

test('clamps at the largest unit instead of running off the end', () => {
  assert.equal(formatCompactBytes(1024 ** 5), '1024.0T');
});

test('returns an empty string when there is no usable size', () => {
  // 调用方用 `|| '\u00a0'` 占位，空串才不会把行撑高。
  for (const value of [0, -1, -5, NaN, Infinity, null, undefined]) {
    assert.equal(formatCompactBytes(value), '', `expected empty for ${String(value)}`);
  }
});

test('accepts a numeric string, as /user/cloud/url returns fileSize', () => {
  // data.fileSize 是字符串形态，data.list[].size 是数字，两者同值。
  assert.equal(formatCompactBytes('62144976'), '59.3M');
  assert.equal(formatCompactBytes('abc'), '');
});
