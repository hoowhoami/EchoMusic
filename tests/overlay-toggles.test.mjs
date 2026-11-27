import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// 播放条 / 歌词页那个桌面层按钮：点开是两项菜单（桌面歌词 / 动态歌词壁纸），
// 亮着的那项用颜色标出；点已开的那项就是关掉，点另一项就切过去。
async function load() {
  const module = { exports: {} };
  const source = transformSync(
    readFileSync(
      new URL('../src/renderer/composables/useOverlayToggles.ts', import.meta.url),
      'utf8',
    ),
    { loader: 'ts', format: 'cjs' },
  ).code;
  const lyric = { enabled: false };
  const store = {
    get settings() {
      return { enabled: lyric.enabled };
    },
    async setEnabled(value) {
      lyric.enabled = Boolean(value);
    },
    setLocal(patch) {
      if (typeof patch?.enabled === 'boolean') lyric.enabled = patch.enabled;
    },
  };
  const state = { taskbar: false, wallpaper: false };
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    electron: {
      platform: 'win32',
      taskbarLyric: {
        getState: async () => ({ enabled: state.taskbar }),
        setEnabled: async (v) => {
          state.taskbar = Boolean(v);
          return { enabled: state.taskbar };
        },
        onStateChange() {},
      },
      wallpaper: {
        getState: async () => ({ enabled: state.wallpaper }),
        setEnabled: async (v) => {
          state.wallpaper = Boolean(v);
          if (state.wallpaper) lyric.enabled = false;
          return { enabled: state.wallpaper };
        },
        onStateChange() {},
      },
    },
  };
  // 菜单锚点取当前获得焦点的按钮，这里给个空 document 兜住右下角回退分支。
  globalThis.document = { activeElement: null };
  const mocks = {
    vue: {
      ref: (value) => ({ value }),
      reactive: (value) => value,
      readonly: (value) => value,
      computed: (fn) => ({
        get value() {
          return fn();
        },
      }),
    },
    '@/desktopLyric/store': { useDesktopLyricStore: () => store },
  };
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    if (!(id in mocks)) throw new Error('Unexpected dependency: ' + id);
    return mocks[id];
  });
  const toggles = module.exports.useOverlayToggles();
  // 初始化会异步拉一次主进程状态，先让它落定，否则会和用例里的操作抢着写同一份标志。
  await new Promise((resolve) => setImmediate(resolve));
  return { toggles, state, lyric, store };
}

const itemOf = (toggles, key) => toggles.desktopSurfaceItems.value.find((item) => item.key === key);

test('点按钮只弹菜单，不直接开关', async () => {
  const { toggles, lyric, state } = await load();
  toggles.openDesktopSurfaceMenu();
  assert.equal(toggles.desktopSurfaceMenu.open, true);
  assert.equal(lyric.enabled, false, '光点按钮不该把桌面歌词打开');
  assert.equal(state.wallpaper, false, '光点按钮也不该开壁纸');
  assert.deepEqual(
    toggles.desktopSurfaceItems.value.map((item) => item.label),
    ['桌面歌词', '动态歌词壁纸'],
    '菜单里只有这两项',
  );
  assert.equal(itemOf(toggles, 'lyric').enabled, false);
  assert.equal(itemOf(toggles, 'wallpaper').enabled, false);
});

test('菜单开着时再点一次按钮就收起', async () => {
  const { toggles } = await load();
  toggles.openDesktopSurfaceMenu();
  assert.equal(toggles.desktopSurfaceMenu.open, true, '第一下弹出');
  toggles.openDesktopSurfaceMenu();
  assert.equal(toggles.desktopSurfaceMenu.open, false, '第二下收回');
});

test('菜单里点桌面歌词：打开它并把菜单收起，颜色标出这一项', async () => {
  const { toggles, lyric } = await load();
  toggles.openDesktopSurfaceMenu();
  await toggles.setDesktopSurface('lyric');
  assert.equal(lyric.enabled, true);
  assert.equal(toggles.desktopSurfaceMenu.open, false, '选完就收起');
  assert.equal(itemOf(toggles, 'lyric').enabled, true, '开着的这项要标出来');
  assert.equal(itemOf(toggles, 'wallpaper').enabled, false);
});

test('点已开着的那项就是关掉', async () => {
  const { toggles, lyric } = await load();
  await toggles.setDesktopSurface('lyric');
  assert.equal(lyric.enabled, true);
  await toggles.setDesktopSurface('lyric');
  assert.equal(lyric.enabled, false, '再点一次同一项就关掉');
});

test('从桌面歌词切到壁纸：壁纸开、桌面歌词关，两项不会同时亮', async () => {
  const { toggles, lyric, state } = await load();
  await toggles.setDesktopSurface('lyric');
  await toggles.setDesktopSurface('wallpaper');
  assert.equal(state.wallpaper, true);
  assert.equal(lyric.enabled, false, '互斥：壁纸占住桌面层时桌面歌词关掉');
  assert.equal(itemOf(toggles, 'wallpaper').enabled, true);
  assert.equal(itemOf(toggles, 'lyric').enabled, false);
});

test('从壁纸切回桌面歌词：先把壁纸关掉', async () => {
  const { toggles, lyric, state } = await load();
  await toggles.setDesktopSurface('wallpaper');
  await toggles.setDesktopSurface('lyric');
  assert.equal(state.wallpaper, false);
  assert.equal(lyric.enabled, true);
});

test('都关着时按钮图案沿用上次开过的形态', async () => {
  const { toggles } = await load();
  assert.equal(toggles.desktopSurfaceIconKind.value, 'lyric', '默认图案是桌面歌词');
  await toggles.setDesktopSurface('wallpaper');
  assert.equal(toggles.desktopSurfaceIconKind.value, 'wallpaper');
  await toggles.setDesktopSurface('wallpaper');
  assert.equal(toggles.desktopSurfaceIconKind.value, 'wallpaper', '关掉后图案留在壁纸');
  await toggles.setDesktopSurface('lyric');
  await toggles.setDesktopSurface('lyric');
  assert.equal(toggles.desktopSurfaceIconKind.value, 'lyric', '换回桌面歌词后图案也跟回来');
});

test('提示文案按动作说：关着说开启，开着说关闭', async () => {
  const { toggles } = await load();
  assert.equal(toggles.desktopSurfaceHint.value, '开启桌面歌词', '都关着时提示去开');
  await toggles.setDesktopSurface('lyric');
  assert.equal(toggles.desktopSurfaceHint.value, '关闭桌面歌词', '开着时说关闭');
  await toggles.setDesktopSurface('wallpaper');
  assert.equal(toggles.desktopSurfaceHint.value, '关闭动态歌词壁纸');
  await toggles.setDesktopSurface('wallpaper');
  assert.equal(toggles.desktopSurfaceHint.value, '开启动态歌词壁纸', '关掉后提示再开回来');
  assert.ok(!toggles.desktopSurfaceHint.value.includes('桌面层'), '不带前缀');
});

test('菜单开着时按钮不弹悬浮提示', () => {
  const files = [
    new URL('../src/renderer/layouts/PlayerBar.vue', import.meta.url),
    new URL('../src/renderer/views/lyric/LyricPlayerControls.vue', import.meta.url),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    assert.ok(
      source.includes("overlayToggles.desktopSurfaceMenu.open ? ''"),
      '菜单开着时不显示 tooltip：' + file.pathname,
    );
  }
});

test('按钮不再一按即关，也不再有三态循环或切换锁', () => {
  const source = readFileSync(
    new URL('../src/renderer/composables/useOverlayToggles.ts', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('cycleDesktopSurface'), '三态循环已移除');
  assert.ok(!source.includes('toggleDesktopSurface'), '一按即关已移除');
  assert.ok(!source.includes('desktopSurfaceLocked'), '桌面层不再有切换锁');
  assert.ok(source.includes('openDesktopSurfaceMenu'));
});

test('当前开着的那项只靠绿点标出，不再写「已开」', () => {
  const source = readFileSync(
    new URL('../src/renderer/components/music/DesktopSurfaceMenu.vue', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('desktop-surface-on'), '不再有「已开」那截文字标签');
  assert.ok(!source.includes('>已开<'), '菜单里不再有「已开」两个字');
  assert.ok(source.includes('desktop-surface-dot'), '只留圆点');
});
