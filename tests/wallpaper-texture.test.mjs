import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 把 TS 源码转成 CJS 后直接 require，避免为了一个纯函数搭建完整构建链。
const load = (relativePath) => {
  const filename = path.join(root, relativePath);
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });
  const module = { exports: {} };
  const require = createRequire(filename);
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return module.exports;
};

const wallpaper = load('src/shared/wallpaper.ts');

test('压暗三项的默认值：中心 15%、边缘 85%、曲线 50%', () => {
  const texture = wallpaper.normalizeWallpaperSettings({}).texture;
  assert.equal(texture.centerDim, 0.15);
  assert.equal(texture.edgeDim, 0.85);
  assert.equal(texture.curve, 0.5);
});

test('老配置按真实浓度迁移：中心反算 ÷0.3，压黑范围当曲线用', () => {
  const texture = wallpaper.normalizeWallpaperSettings({
    texture: { edgeStart: 0.3, edgeDarkness: 0.4, centerDim: 1 },
  }).texture;
  assert.equal(texture.centerDim, 0.3);
  assert.equal(texture.edgeDim, 0.4);
  assert.equal(texture.curve, 0.3);
  assert.equal('edgeStart' in texture, false);
  assert.equal('edgeDarkness' in texture, false);
});

test('新口径原样保存，超范围收敛到 0~1', () => {
  const texture = wallpaper.normalizeWallpaperSettings({
    texture: { centerDim: 0.2, edgeDim: 0.6, curve: 0.8 },
  }).texture;
  assert.deepEqual(
    { centerDim: texture.centerDim, edgeDim: texture.edgeDim, curve: texture.curve },
    { centerDim: 0.2, edgeDim: 0.6, curve: 0.8 },
  );
  const clamped = wallpaper.normalizeWallpaperSettings({
    texture: { centerDim: -1, edgeDim: 3, curve: 9 },
  }).texture;
  assert.deepEqual(
    { centerDim: clamped.centerDim, edgeDim: clamped.edgeDim, curve: clamped.curve },
    { centerDim: 0, edgeDim: 1, curve: 1 },
  );
});

test('压暗层按中心/边缘/曲线采样，不再有写死的中间与边缘系数', () => {
  const source = readFileSync(
    path.join(root, 'src/renderer/views/wallpaper/WallpaperDim.vue'),
    'utf8',
  );
  assert.match(source, /props\.centerDim/);
  assert.match(source, /props\.edgeDim/);
  assert.match(source, /props\.curve/);
  assert.match(source, /addColorStop/);
  assert.doesNotMatch(source, /0\.3 \* clamp/);
  assert.doesNotMatch(source, /0\.27 \* darkness|0\.67 \* darkness/);
});

test('设置页三项滑杆换成中心压暗、边缘压暗与压暗曲线', () => {
  const source = readFileSync(
    path.join(root, 'src/renderer/views/settings/components/WallpaperSettingsSection.vue'),
    'utf8',
  );
  assert.match(source, /label: '中心压暗'/);
  assert.match(source, /label: '边缘压暗'/);
  assert.match(source, /label: '压暗曲线'/);
  assert.doesNotMatch(source, /label: '压黑范围'|label: '压黑暗度'|label: '中心压黑'/);
});
