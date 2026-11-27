import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const vue = require('vue');

// 插件自绘循环不受宿主 frameBudget 管辖，所以壁纸帧率必须以契约形式下发给插件：
// fps 是上限（0=不限），frozen 才是暂停；两者混用会让插件把「不限」当成「停」。
function load(file, deps = {}) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    if (id in deps) return deps[id];
    throw new Error('Unexpected dependency: ' + id);
  });
  return module.exports;
}

const readSource = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

const shared = load('../src/shared/wallpaper.ts');
const contractSource = readSource('../src/renderer/wallpaper/frameContract.ts');
const contract = load('../src/renderer/wallpaper/frameContract.ts', {
  vue,
  '../../shared/wallpaper': shared,
});

// 极简 window：只实现契约用到的三个方法
function installWindow() {
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
  };
  return listeners;
}

test('下发给插件的帧率保留 0 表示不限，且不超过量程', () => {
  assert.equal(shared.paceFpsOf(0), 0);
  assert.equal(shared.paceFpsOf(-5), 0);
  assert.equal(shared.paceFpsOf(Number.NaN), 0);
  assert.equal(shared.paceFpsOf(144), 144);
  assert.equal(shared.paceFpsOf(59.6), 60);
  assert.equal(shared.paceFpsOf(1000), shared.WALLPAPER_MAX_FPS);
  // 省电档不能被抬到最小量程，否则「挡住的 29 帧」会变成「30 帧」
  assert.equal(shared.paceFpsOf(shared.occludedFpsOf(144)), 29);
  assert.notEqual(shared.paceFpsOf(0), shared.clampFrameRate(0));
});

test('设定变化时才派发事件，detail 与读音一致', () => {
  installWindow();
  const seen = [];
  contract.onWallpaperFrameModeChange((mode) => seen.push(mode));
  contract.setWallpaperFrameMode(120, false);
  contract.setWallpaperFrameMode(120, false);
  assert.deepEqual(seen, [{ fps: 120, frozen: false }]);
  contract.setWallpaperFrameMode(120, true);
  assert.deepEqual(seen.at(-1), { fps: 120, frozen: true });
  assert.deepEqual(contract.readWallpaperFrameMode(), { fps: 120, frozen: true });
  assert.equal(seen.length, 2);
});

test('帧率照样清洗，冻结只认 true', () => {
  installWindow();
  contract.setWallpaperFrameMode(0, false);
  const seen = [];
  contract.onWallpaperFrameModeChange((mode) => seen.push(mode));
  contract.setWallpaperFrameMode(9999, true);
  assert.deepEqual(seen.at(-1), { fps: 240, frozen: true });
  contract.setWallpaperFrameMode(-1, true);
  assert.deepEqual(seen.at(-1), { fps: 0, frozen: true });
  // 契约里只有 true 才算冻结，别的真值不当成暂停
  contract.setWallpaperFrameMode(30, 1);
  assert.deepEqual(seen.at(-1), { fps: 30, frozen: false });
});

test('订阅可以取消，取消后不再收到事件', () => {
  installWindow();
  let count = 0;
  const off = contract.onWallpaperFrameModeChange(() => {
    count++;
  });
  contract.setWallpaperFrameMode(60, false);
  off();
  contract.setWallpaperFrameMode(90, false);
  assert.equal(count, 1);
});

test('响应式镜像与快照同源', () => {
  installWindow();
  contract.setWallpaperFrameMode(72, false);
  assert.equal(contract.wallpaperFrameMode.value.fps, 72);
  assert.equal(contract.wallpaperFrameMode.value.frozen, false);
  assert.equal(contract.readWallpaperFrameMode().fps, 72);
  assert.equal(contract.WALLPAPER_FRAME_EVENT, 'echomusic:wallpaper-frame');
  assert.match(
    contractSource,
    /if \(next\.fps === current\.fps && next\.frozen === current\.frozen\) return;/,
  );
});

test('壁纸页面把同一份设定下发给插件', () => {
  const page = readSource('../src/renderer/views/wallpaper/WallpaperPage.vue');
  assert.match(page, /import \{ setWallpaperFrameMode \} from '@\/wallpaper\/frameContract';/);
  assert.match(page, /setWallpaperFrameMode\(fps, isFrozen\)/);
  assert.match(page, /\[frozen\.value, state\.value\?\.frameRate \?\? 0\] as const/);
});

test('歌词页上下文的 view 里带 fps 与 frozen', () => {
  const context = readSource('../src/renderer/views/lyric/composables/useLyricsPageContext.ts');
  assert.match(context, /import \{ wallpaperFrameMode \} from '@\/wallpaper\/frameContract';/);
  assert.match(
    context,
    /frame: \{\s*fps: wallpaperFrameMode\.value\.fps,\s*frozen: wallpaperFrameMode\.value\.frozen,/,
  );
});

test('宿主托管的插件动画循环按契约排帧', () => {
  const graphics = readSource('../src/renderer/plugins/runtime/graphics.ts');
  assert.match(graphics, /readWallpaperFrameMode\(\)/);
  assert.match(graphics, /if \(mode\.frozen\) \{/);
  assert.match(graphics, /1000 \/ mode\.fps/);
  assert.match(graphics, /animationUnsubscribe \?\?= onWallpaperFrameModeChange/);
  // 主窗口 fps 0 时必须还是每帧 rAF，不能退化成不画
  assert.match(
    graphics,
    /if \(mode\.fps <= 0\) \{\s*animation = window\.requestAnimationFrame\(tick\);/,
  );
});

test('契约文档写明事件名与 0 表示不限', () => {
  const doc = readSource('../docs/wallpaper-frame-contract.md');
  assert.match(doc, /echomusic:wallpaper-frame/);
  assert.match(doc, /0 表示不限/);
  assert.match(doc, /frozen/);
  const pluginDoc = readSource('../docs/plugin-system.md');
  assert.match(pluginDoc, /wallpaper-frame-contract\.md/);
});
