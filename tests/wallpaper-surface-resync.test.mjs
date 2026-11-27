import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// 插副屏时 Electron 报的 bounds 常是滞后的：新屏先以主屏原点 (0,0) 出现，几百毫秒后
// 才挪到本来的位置。窗口按创建那一刻的矩形挂上去，就留在主屏上，而设置里勾的是副屏，
// 用户看到的是「设置和画面反了」。这四条钉住复摆规则本身：只要屏幕几何变了就按新几何摆，
// 没变也要按父窗口坐标再摆一次，屏没了就不许乱动。

const displays = [];
let resized = [];

const electronStub = {
  BrowserWindow: class {},
  screen: {
    getAllDisplays: () => displays,
    dipToScreenPoint: (point) => ({ x: Math.round(point.x), y: Math.round(point.y) }),
  },
};

const nativeStub = {
  wallpaperResize(handle, x, y, width, height) {
    resized.push({ handle, x, y, width, height });
  },
};

function load(file) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const require = (id) => {
    if (id === 'electron') return electronStub;
    if (id === '../native/platform') return { getNativeWallpaper: () => nativeStub };
    if (id === '../windowBackgroundThrottling') return { installWindowBackgroundThrottling() {} };
    if (id === '../logger') return { default: { info() {}, warn() {}, error() {} } };
    if (id === 'node:path') return { join: (...parts) => parts.join('/') };
    throw new Error('Unexpected dependency: ' + id);
  };
  new Function('module', 'exports', 'require', '__dirname', source)(
    module,
    module.exports,
    require,
    '/tmp/app',
  );
  return module.exports;
}

const { resyncWallpaperSurface, surfaceRefreshRate, displayPhysicalBounds } = load(
  '../src/main/wallpaper/window.ts',
);

const display = (overrides = {}) => ({
  id: 3375668356,
  bounds: { x: 11, y: 1080, width: 1920, height: 1080 },
  workArea: { x: 11, y: 1080, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
  displayFrequency: 144,
  ...overrides,
});

const surfaceOf = (rect) => ({
  displayId: '3375668356',
  win: {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.from([0x2a, 0x00, 0x00, 0x00]),
  },
  monitor: { setLyricRect() {} },
  coverage: 0,
  lyricCoverage: 0,
  lyricRect: { x: 0, y: 1000, width: 1920, height: 80 },
  policy: null,
  attached: true,
  rect: { ...rect },
  nativeRect: { ...rect },
  scaleFactor: 1,
  applied: null,
});

test('插屏瞬间报成主屏原点：复摆把窗口挪到副屏真实位置', () => {
  displays.length = 0;
  displays.push(display());
  resized = [];
  const surface = surfaceOf({ x: 0, y: 0, width: 1920, height: 1032 });
  const changed = resyncWallpaperSurface(surface);
  assert.equal(changed, true);
  assert.deepEqual(surface.rect, { x: 11, y: 1080, width: 1920, height: 1080 });
  assert.deepEqual(surface.nativeRect, { x: 11, y: 1080, width: 1920, height: 1080 });
  assert.deepEqual(resized.at(-1), { handle: '42', x: 11, y: 1080, width: 1920, height: 1080 });
});

test('屏幕几何没变也要按父窗口坐标再摆一次，返回未变', () => {
  displays.length = 0;
  displays.push(display());
  resized = [];
  const bounds = { x: 11, y: 1080, width: 1920, height: 1080 };
  const surface = surfaceOf(bounds);
  const changed = resyncWallpaperSurface(surface);
  assert.equal(changed, false);
  assert.deepEqual(surface.rect, bounds);
  assert.equal(resized.length, 1);
});

test('屏幕被拔掉：不改矩形、不下发原生调用', () => {
  displays.length = 0;
  resized = [];
  const bounds = { x: 11, y: 1080, width: 1920, height: 1080 };
  const surface = surfaceOf(bounds);
  const changed = resyncWallpaperSurface(surface);
  assert.equal(changed, false);
  assert.deepEqual(surface.rect, bounds);
  assert.equal(resized.length, 0);
});

test('几何变了要作废旧歌词矩形，让渲染层按新几何重报', () => {
  displays.length = 0;
  displays.push(
    display({
      bounds: { x: 11, y: 1080, width: 1280, height: 720 },
      workArea: { x: 11, y: 1080, width: 1280, height: 720 },
      size: { width: 1280, height: 720 },
    }),
  );
  const surface = surfaceOf({ x: 11, y: 1080, width: 1920, height: 1080 });
  resyncWallpaperSurface(surface);
  assert.equal(surface.lyricRect, null);
  assert.equal(surface.rect.width, 1280);
});

test('刷新率取不到或为 0 时返回 0，交给调用方按档位原值处理', () => {
  displays.length = 0;
  displays.push(display());
  assert.equal(surfaceRefreshRate(surfaceOf({ x: 0, y: 0, width: 10, height: 10 })), 144);
  displays[0] = display({ displayFrequency: 0 });
  assert.equal(surfaceRefreshRate(surfaceOf({ x: 0, y: 0, width: 10, height: 10 })), 0);
  displays.length = 0;
  assert.equal(surfaceRefreshRate(surfaceOf({ x: 0, y: 0, width: 10, height: 10 })), 0);
});

test('物理像素只缩放尺寸，原点交给 Electron 换算，避免缩放屏整块偏移', () => {
  displays.length = 0;
  displays.push(
    display({
      bounds: { x: 0, y: 1080, width: 2880, height: 1620 },
      workArea: { x: 0, y: 1080, width: 2880, height: 1620 },
      scaleFactor: 1.5,
    }),
  );
  assert.deepEqual(displayPhysicalBounds(displays[0]), {
    x: 0,
    y: 1080,
    width: 4320,
    height: 2430,
  });
});

test('窗口隐藏时不摆放：原生摆放带 SWP_SHOWWINDOW，会把隐藏的窗口在 Win32 层偷偷显示回来', () => {
  displays.length = 0;
  displays.push(display());
  resized = [];
  const surface = surfaceOf({ x: 11, y: 1080, width: 1920, height: 1080 });
  surface.win.isVisible = () => false;
  const changed = resyncWallpaperSurface(surface);
  assert.equal(changed, false);
  assert.equal(resized.length, 0);
});

test('隐藏时即使几何变了也只记下新矩形，不调原生摆放', () => {
  displays.length = 0;
  displays.push(display());
  resized = [];
  const surface = surfaceOf({ x: 0, y: 0, width: 1920, height: 1032 });
  surface.win.isVisible = () => false;
  const changed = resyncWallpaperSurface(surface);
  assert.equal(changed, true);
  assert.deepEqual(surface.rect, { x: 11, y: 1080, width: 1920, height: 1080 });
  assert.equal(resized.length, 0);
});
