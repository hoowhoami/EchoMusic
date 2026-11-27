import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// 壁纸绘制策略是纯函数：这里把判定链和「滞回」的进出阈值钉住。
// 之前这些规则只有肉眼验证，covered 与 paused 的先后顺序一度写反，导致
// 「暂停 + 被窗口盖住」永远停在被冻住的状态。
function load(file, mocks = {}) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    if (!(id in mocks)) throw new Error('Unexpected dependency: ' + id);
    return mocks[id];
  });
  return module.exports;
}

const policy = load('../src/main/wallpaper/policy.ts', {
  '../../shared/wallpaper': {},
});

const base = {
  enabled: true,
  attached: true,
  playing: true,
  coverage: 0,
  lyricCoverage: 0,
  lyricRegionKnown: true,
  pauseBehavior: 'freeze',
  playingFps: 60,
  occludedFps: 20,
};

const frame = (patch) => policy.resolveWallpaperFrame({ ...base, ...patch });

test('关掉开关或没挂上时既不可见也不画', () => {
  assert.deepEqual(frame({ enabled: false }), { frameRate: 0, visible: false, reason: 'disabled' });
  assert.deepEqual(frame({ attached: false }), {
    frameRate: 0,
    visible: false,
    reason: 'detached',
  });
});

test('暂停先于遮挡判定：暂停时永远算 paused，不会因为被盖住而冻着', () => {
  // 回归：判定链把 covered 放在前面时，这里会返回 covered（visible: true），
  // 于是 pauseBehavior='hide' 在窗口盖住桌面时永远不生效。
  assert.deepEqual(frame({ playing: false, pauseBehavior: 'hide', coverage: 0.95 }), {
    frameRate: 0,
    visible: false,
    reason: 'paused',
  });
  assert.deepEqual(frame({ playing: false, pauseBehavior: 'freeze', coverage: 0.95 }), {
    frameRate: 0,
    visible: true,
    reason: 'paused',
  });
});

test('歌词区域被挡住 80% 就冻结画面，但窗口留着', () => {
  assert.deepEqual(frame({ lyricCoverage: 0.8 }), {
    frameRate: 0,
    visible: true,
    reason: 'covered',
  });
  assert.equal(frame({ lyricCoverage: 0.79 }).reason, 'occluded');
});

test('冻结有滞回：退到 68% 以下才解冻', () => {
  assert.equal(frame({ lyricCoverage: 0.7, previousReason: 'covered' }).reason, 'covered');
  assert.equal(frame({ lyricCoverage: 0.68, previousReason: 'covered' }).reason, 'covered');
  assert.equal(frame({ lyricCoverage: 0.6, previousReason: 'covered' }).reason, 'occluded');
});

test('降帧档：进入 50%，退出 40%', () => {
  const occluded = frame({ lyricCoverage: 0.5 });
  assert.deepEqual(occluded, { frameRate: 20, visible: true, reason: 'occluded' });
  assert.equal(frame({ lyricCoverage: 0.45, previousReason: 'occluded' }).reason, 'occluded');
  assert.deepEqual(frame({ lyricCoverage: 0.3, previousReason: 'occluded' }), {
    frameRate: 60,
    visible: true,
    reason: 'playing',
  });
});

test('没有歌词区域时退回整屏覆盖率', () => {
  assert.equal(frame({ lyricRegionKnown: false, coverage: 0.9 }).reason, 'covered');
  assert.equal(frame({ lyricRegionKnown: false, coverage: 0.55 }).reason, 'occluded');
  assert.equal(
    frame({ lyricRegionKnown: true, coverage: 0.9, lyricCoverage: 0 }).reason,
    'playing',
  );
});

test('降帧档不超过播放帧率，播放档至少 1 帧', () => {
  assert.equal(frame({ lyricCoverage: 0.6, playingFps: 10, occludedFps: 40 }).frameRate, 10);
  assert.equal(frame({ playingFps: 0.2 }).frameRate, 1);
});
