import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Electron 在 Windows 上的 Display.id 不稳定：换缩放、重挂、驱动更新、重启都可能换号。
// 旧名单一旦全部失效，设置页会把每块屏都判成「关」，主进程又回落到主屏接着画，
// 表现就是「开关全关着，壁纸还在动」。这三条钉住收敛规则本身。
function load(file) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    throw new Error('Unexpected dependency: ' + id);
  });
  return module.exports;
}

const { pickDisplayIds } = load('../src/shared/wallpaper.ts');

test('名单里全是已失效的屏幕：回落主屏，别让开关全灭', () => {
  assert.deepEqual(pickDisplayIds(['old-1', 'old-2'], ['a', 'b'], 'a'), ['a']);
});

test('只保留仍然存在的屏幕，并保持原有顺序', () => {
  assert.deepEqual(pickDisplayIds(['b', 'gone', 'a'], ['a', 'b'], 'a'), ['b', 'a']);
});

test('空名单与重复项都收敛成一份去重后的名单', () => {
  assert.deepEqual(pickDisplayIds([], ['a', 'b'], 'b'), ['b']);
  assert.deepEqual(pickDisplayIds(['a', 'a', 'b'], ['a', 'b'], 'a'), ['a', 'b']);
});

test('非字符串残留（老配置里的数字 id）当作失效处理', () => {
  assert.deepEqual(pickDisplayIds([1, null, 'a'], ['a'], 'a'), ['a']);
});
