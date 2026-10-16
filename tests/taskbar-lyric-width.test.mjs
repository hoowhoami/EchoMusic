import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';

const filename = 'src/renderer/taskbarPlayer/lyricWidth.ts';
// 纯函数模块，无外部依赖，直接以 CJS 求值取出导出。
const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { resolveContentWidth: resolve } = mod.exports;

const base = { natural: 400, maxWidth: 800, expanded: false, rolling: false, current: 400 };

test('静止时按自然宽度收敛，并受上限与最小宽度约束', () => {
  assert.equal(resolve(base), 400);
  assert.equal(resolve({ ...base, natural: 900 }), 800, '不超过原生上限');
  assert.equal(resolve({ ...base, natural: 40 }), 160, '不低于最小宽度');
  assert.equal(resolve({ ...base, expanded: true, maxWidth: 640 }), 640, '展开态占满');
});

test('换行动画期间不收窄：长行切到短行时旧行不会被裁掉尾巴', () => {
  assert.equal(
    resolve({ ...base, natural: 220, rolling: true, current: 520 }),
    520,
    '动画期间保持旧宽度',
  );
});

test('换行动画期间照常放行变宽：新行升入过程中不被裁', () => {
  assert.equal(resolve({ ...base, natural: 620, rolling: true, current: 300 }), 620);
});

test('动画结束（rolling=false）后收窄到新行尺寸', () => {
  assert.equal(resolve({ ...base, natural: 220, rolling: false, current: 520 }), 220);
});

test('动画期间的收窄请求不会低于上限或最小宽度', () => {
  assert.equal(resolve({ ...base, natural: 20, rolling: true, current: 40 }), 160);
  assert.equal(resolve({ ...base, natural: 999, rolling: true, current: 100, maxWidth: 800 }), 800);
});