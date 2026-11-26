import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// 绘制帧率是连续值（滑杆 30–240 逐帧），省电档按 20% 自动算；
// 老配置里存的是档位名，必须就地换算成帧数，不能把用户设置读丢。
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

const { frameRateOf, normalizeWallpaperSettings, occludedFpsOf, reconcileFrameRates } = load(
  '../src/shared/wallpaper.ts',
);

test('没配过的屏回落到全局帧率', () => {
  const settings = normalizeWallpaperSettings({ frameRate: 120, frameRates: {} });
  assert.equal(frameRateOf(settings, 'a'), 120);
});

test('配过的屏用自己的帧率，另一块屏不受影响', () => {
  const settings = normalizeWallpaperSettings({
    frameRate: 120,
    frameRates: { a: 144, b: 60 },
  });
  assert.equal(frameRateOf(settings, 'a'), 144);
  assert.equal(frameRateOf(settings, 'b'), 60);
  assert.equal(frameRateOf(settings, 'c'), 120);
});

test('老配置的档位名就地换算成帧数', () => {
  const settings = normalizeWallpaperSettings({
    frameProfile: 'insane',
    frameProfiles: { a: 'fast' },
  });
  assert.equal(settings.frameRate, 240);
  assert.deepEqual(settings.frameRates, { a: 90 });
});

test('帧率被夹进 30–240，脏值直接丢掉', () => {
  const settings = normalizeWallpaperSettings({
    frameRate: 900,
    frameRates: { a: 5, b: 'x', ' ': 60, c: 144 },
  });
  assert.equal(settings.frameRate, 240);
  assert.deepEqual(settings.frameRates, { a: 30, c: 144 });
});

test('什么档位都没存的老配置落成默认 60 帧', () => {
  const settings = normalizeWallpaperSettings({});
  assert.equal(settings.frameRate, 60);
  assert.deepEqual(settings.frameRates, {});
});

test('省电档按当前帧率的 20% 四舍五入', () => {
  assert.equal(occludedFpsOf(144), 29);
  assert.equal(occludedFpsOf(240), 48);
  assert.equal(occludedFpsOf(30), 6);
  assert.equal(occludedFpsOf(1), 1);
});

test('屏幕刷新率降下来后，存下来的帧率被夹回真实上限', () => {
  // 副屏从 144Hz 改成 60Hz：存着的 144 不能一直显示成「设定 144 帧 / 当前 60 帧」
  const { rates, changed } = reconcileFrameRates({ main: 144, side: 144 }, [
    { id: 'main', refreshRate: 144 },
    { id: 'side', refreshRate: 60 },
  ]);
  assert.deepEqual(rates, { main: 144, side: 60 });
  assert.equal(changed, true);
});

test('拔掉或重连换过 id 的屏，旧键被丢掉', () => {
  const { rates, changed } = reconcileFrameRates({ gone: 60, main: 100 }, [
    { id: 'main', refreshRate: 144 },
  ]);
  assert.deepEqual(rates, { main: 100 });
  assert.equal(changed, true);
});

test('对得上时原样返回，不来回写配置', () => {
  const { rates, changed } = reconcileFrameRates({ main: 120 }, [{ id: 'main', refreshRate: 144 }]);
  assert.deepEqual(rates, { main: 120 });
  assert.equal(changed, false);
});

test('系统报不出刷新率（0）时不乱动用户设的值', () => {
  const { rates, changed } = reconcileFrameRates({ main: 240 }, [{ id: 'main', refreshRate: 0 }]);
  assert.deepEqual(rates, { main: 240 });
  assert.equal(changed, false);
});
