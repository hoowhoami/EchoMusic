import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, nextTick, reactive } from 'vue';

const require = createRequire(import.meta.url);
const root = resolve('.');

/** 记录 rAF 的挂起/取消，用来断言逐字歌词循环是否真的停表。 */
const rafLog = { requested: 0, cancelled: 0, pending: 0 };
const pendingFrames: Array<() => void> = [];
const runFrame = () => {
  const frame = pendingFrames.shift();
  rafLog.pending = pendingFrames.length;
  frame?.();
};
const rafStub = {
  requestAnimationFrame(cb: () => void) {
    rafLog.requested += 1;
    pendingFrames.push(cb);
    rafLog.pending = pendingFrames.length;
    return rafLog.requested;
  },
  cancelAnimationFrame() {
    rafLog.cancelled += 1;
    pendingFrames.length = 0;
    rafLog.pending = 0;
  },
};

const originals = new Map<string, PropertyDescriptor | undefined>();
// node --test 每个测试文件独立进程，这里只需为整份 fixture 安装浏览器全局。
const globalValue = (name: string, value: unknown) => {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

const listeners = new Map<string, Set<() => void>>();
const documentStub = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  addEventListener(type: string, cb: () => void) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  },
  removeEventListener(type: string, cb: () => void) {
    listeners.get(type)?.delete(cb);
  },
};
const setVisibility = (state: 'visible' | 'hidden') => {
  documentStub.visibilityState = state;
  for (const cb of listeners.get('visibilitychange') ?? []) cb();
};

// LyricScroller 调用的是全局 requestAnimationFrame/cancelAnimationFrame（非 window. 前缀）。
globalValue('requestAnimationFrame', rafStub.requestAnimationFrame);
globalValue('cancelAnimationFrame', rafStub.cancelAnimationFrame);
globalValue('document', documentStub);
globalValue('window', {
  requestAnimationFrame: rafStub.requestAnimationFrame,
  cancelAnimationFrame: rafStub.cancelAnimationFrame,
  matchMedia: () => null,
});

const fixture = {
  player: reactive({
    isPlaying: true,
    playbackClock: { positionMs: 0 },
    currentTime: 0,
    duration: 100,
    playbackRate: 1,
    seekTimestamp: 0,
    seek() {},
    togglePlay() {},
  }),
  lyric: reactive({
    lines: [] as unknown[],
    currentIndex: 0,
    currentTimeOffset: 0,
    loadedHash: '',
    rawLyric: '',
    lyricsMode: 'original',
    isLoading: false,
    fontScale: 1,
    fontWeightIndex: 0,
    secondaryEnabled: false,
    showRomanization: false,
    showRomanizationAsRuby: false,
    lineSecondaryText: () => '',
    effectivePlayedColor: '#fff',
    effectiveUnplayedColor: '#888',
    findIndexAtTimeMs: () => 0,
  }),
  settings: reactive({
    lyricFilterEnabled: false,
    lyricFilterPattern: '',
    buildLyricFontFamily: () => 'sans-serif',
  }),
};

const stubs = {
  '@/stores/player': 'export const usePlayerStore = () => fixture.player;',
  '@/stores/lyric':
    'export const useLyricStore = () => fixture.lyric; export const LYRIC_COVER_COLOR_VALUE = "__cover__";',
  '@/stores/setting': 'export const useSettingStore = () => fixture.settings;',
  './skins/config': 'export const LYRIC_FONT_WEIGHTS = [400, 700];',
  './composables/useLyricScroll':
    'export const useLyricScroll = () => ({ scrollHighlightIndex: { value: 0 }, scrollToLine(){}, handleWheel(){}, dispose(){} });',
  './composables/useYrcAnimation': `export const useYrcAnimation = () => ({
    getLyricTimelineMs: () => 0,
    getTimelineRevision: () => 0,
    updateYrcDom() {},
    syncSeekAnchor() {},
    registerMainChar() {},
    registerSubChar() {},
    resetCharRegistry() {},
  });`,
  '@/composables/useStableLyricIndex':
    'export const createStableLyricIndex = () => ({ apply: (i) => i, reset() {} });',
  '@/utils/format': 'export const formatDuration = () => "0:00";',
  '@/utils/lyricFilter':
    'export const buildFilteredLyricEntries = () => []; export const resolveVisibleLyricIndex = () => 0;',
  '@/icons': 'export const iconPlay = {};',
  '@/plugins/lyricEffects': `export const getPluginLyricEffectClassNames = () => [];
    export const getPluginLyricEffectSummary = () => "";
    export const registerPluginLyricEffectHost = () => ({ notify() {}, dispose() {} });`,
};

const bundle = await build({
  stdin: {
    contents: `export { default as Scroller } from './src/renderer/views/lyric/LyricScroller.vue';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [
    {
      name: 'lyric-scroller-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === 'vue') return { path: 'vue', external: true };
          if (stubs[args.path]) return { path: args.path, namespace: 'fixture' };
          if (args.path.endsWith('.vue')) {
            const file = args.path.startsWith('@/')
              ? resolve(root, 'src/renderer', args.path.slice(2))
              : resolve(args.resolveDir, args.path);
            return { path: file, namespace: 'sfc' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'sfc' }, (args) => {
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return {
            contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
            loader: 'ts',
            resolveDir: resolve(args.path, '..'),
          };
        });
      },
    },
  ],
});

const module = { exports: {} };
new Function('require', 'module', 'exports', 'fixture', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
  fixture,
);
const Scroller = module.exports.Scroller;

const createNode = (tag: string) => ({
  tag,
  children: [] as unknown[],
  style: { setProperty() {}, removeProperty() {} },
  dataset: {} as Record<string, string>,
  setAttribute() {},
  removeAttribute() {},
  getAttribute() {
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  isConnected: true,
});

const nodeOps = {
  createElement: (tag: string) => createNode(tag),
  createText: (text: string) => ({ tag: '#text', text }),
  createComment: (text: string) => ({ tag: '#comment', text }),
  setText: (node: any, text: string) => {
    node.text = text;
  },
  setElementText: (node: any, text: string) => {
    node.text = text;
  },
  insert: (child: any, parent: any, anchor?: any) => {
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child);
    else parent.children.push(child);
  },
  remove: (child: any) => {
    const parent = child.parent;
    if (parent) {
      const index = parent.children.indexOf(child);
      if (index >= 0) parent.children.splice(index, 1);
      child.parent = null;
    }
  },
  parentNode: (node: any) => node.parent ?? null,
  nextSibling: (node: any) => {
    const siblings = node.parent?.children;
    if (!siblings) return null;
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  querySelector: () => null,
  setScopeId: () => {},
  patchProp: () => {},
};

const mount = () => {
  const { createApp } = createRenderer(nodeOps as never);
  const container: any = { tag: 'root', children: [] };
  const app = createApp(Scroller);
  app.config.warnHandler = () => {};
  app.mount(container);
  return app;
};

const resetRaf = () => {
  rafLog.requested = 0;
  rafLog.cancelled = 0;
  pendingFrames.length = 0;
  rafLog.pending = 0;
  listeners.clear();
  documentStub.visibilityState = 'visible';
  fixture.player.isPlaying = true;
  fixture.player.playbackClock = { positionMs: 0 };
};

test('per-word lyric rAF keeps running while the window is visible', async () => {
  resetRaf();
  const app = mount();
  await nextTick();

  assert.equal(rafLog.requested > 0, true, '可见且播放中时应启动逐帧循环');
  const before = rafLog.requested;
  runFrame();
  await nextTick();
  assert.equal(rafLog.requested > before, true, '可见时每帧都应继续排下一帧');

  app.unmount();
});

test('per-word lyric rAF stops when the window is hidden and resumes when shown again', async () => {
  resetRaf();
  const app = mount();
  await nextTick();
  assert.equal(rafLog.requested > 0, true);

  // 窗口隐藏：必须停表。
  setVisibility('hidden');
  await nextTick();
  assert.equal(rafLog.cancelled > 0, true, '窗口隐藏时应取消逐帧循环');
  assert.equal(rafLog.pending, 0, '隐藏后不应残留待执行帧');

  // 隐藏期间即使播放时钟推进也不应重新启动。
  const afterHide = rafLog.requested;
  fixture.player.playbackClock = { positionMs: 5000 };
  await nextTick();
  assert.equal(rafLog.requested, afterHide, '窗口隐藏期间时钟推进也不得重启逐帧循环');

  // 重新可见：应恢复。
  setVisibility('visible');
  await nextTick();
  assert.equal(rafLog.requested > afterHide, true, '窗口重新可见后应恢复逐帧循环');

  app.unmount();
});

test('per-word lyric rAF stays stopped while paused and resumes on playback', async () => {
  resetRaf();
  fixture.player.isPlaying = false;
  const app = mount();
  await nextTick();

  assert.equal(rafLog.requested, 0, '暂停时不应启动逐帧循环');

  // 真实播放器恢复播放时会推进 playbackClock，宿主据此重启循环。
  fixture.player.isPlaying = true;
  fixture.player.playbackClock = { positionMs: 12000 };
  await nextTick();
  assert.equal(rafLog.requested > 0, true, '恢复播放后应启动逐帧循环');

  app.unmount();
});
