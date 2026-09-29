import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as vue from 'vue';
import * as offset from '../src/shared/lyricOffset.ts';
import * as persistence from '../src/shared/storePersistence.ts';
import * as lyrics from '../src/shared/lyrics.ts';
import * as desktopLyric from '../src/shared/desktopLyric.ts';
import * as nowPlaying from '../src/shared/nowPlaying.ts';
import * as lruMap from '../src/renderer/utils/lruMap.ts';
import { parse, compileScript } from '@vue/compiler-sfc';

function compile(file, mocks, window = {}, source) {
  const module = { exports: {} };
  const { code } = transformSync(source ?? readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  });
  new Function('require', 'module', 'exports', 'window', code)(
    (id) => {
      if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
}

const { useLyricStore } = compile('../src/renderer/stores/lyric.ts', {
  pinia,
  '@/api/music': {},
  '@/utils/logger': {},
  '@/utils/color': { DEFAULT_ACCENT: '#0071e3' },
  '@/plugins/lyrics': {},
  './theme': {},
  '../../shared/lyricOffset': offset,
});
const store = () => useLyricStore(pinia.createPinia());

test('settings input applies seconds, clamps invalid values and resets only global calibration', async (t) => {
  const lyric = store();
  lyric.loadedHash = 'a';
  lyric.adjustTimeOffset(200);
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('#text', text),
    createComment: (text) => node('#comment', text),
    setText: (el, text) => {
      el.text = text;
    },
    setElementText: (el, text) => {
      el.text = text;
      el.children = [];
    },
    parentNode: (el) => el.parent,
    nextSibling: (el) => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
    patchProp: (el, name, _old, value) => {
      el.props[name] = value;
    },
    insert(el, parent, anchor = null) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(at < 0 ? parent.children.length : at, 0, el);
    },
    remove(el) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = null;
    },
  });
  const stub = {
    __esModule: true,
    default: {
      setup:
        (_props, { slots }) =>
        () =>
          vue.h('section', slots.default?.()),
    },
  };
  const file = '../src/renderer/views/settings/components/PageLyricSettingsSection.vue';
  const { descriptor } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'offset-settings-test', inlineTemplate: true });
  const component = compile(
    file,
    {
      vue,
      '@/stores/setting': { useSettingStore: () => vue.reactive({ lyricOffsetStep: 0.1 }) },
      '@/stores/lyric': { useLyricStore: () => lyric },
      '@/components/ui/Switch.vue': stub,
      '@/components/ui/Select.vue': stub,
      '@/components/ui/PageLyricIcon.vue': stub,
      './SettingsSectionShell.vue': stub,
      '../constants': { sectionTitles: { pageLyric: { label: '页面歌词' } } },
      '../../../../shared/lyricOffset': offset,
    },
    {},
    script.content,
  ).default;
  const container = node('root');
  const app = renderer.createApp(component);
  app.mount(container);
  t.after(() => app.unmount());
  const flatten = (el) => [el, ...el.children.flatMap(flatten)];
  const input = flatten(container).find((el) => el.type === 'input' && el.props.type === 'number');
  const reset = flatten(container).find(
    (el) => el.type === 'button' && el.text.includes('重置全局'),
  );
  assert.equal(input.props['aria-label'], '全局歌词时间偏移（秒）');
  assert.equal(reset.props.disabled, true);
  for (const [value, expected] of [
    [0.4, 400],
    [35, 10000],
    [-35, -10000],
    [NaN, 0],
  ]) {
    const target = { valueAsNumber: value, value: String(value) };
    input.props.onChange({ target });
    await vue.nextTick();
    assert.equal(lyric.globalTimeOffsetMs, expected);
    assert.equal(target.value, String(expected / 1000));
  }
  input.props.onChange({ target: { valueAsNumber: 0.5, value: '0.5' } });
  await vue.nextTick();
  assert.equal(reset.props.disabled, false);
  reset.props.onClick();
  await vue.nextTick();
  assert.equal(lyric.globalTimeOffsetMs, 0);
  assert.equal(lyric.currentTrackTimeOffset, 200);
});

test('paused global calibration reaches now-playing/taskbar, Mini and desktop snapshots without seeking audio', async (t) => {
  const root = pinia.createPinia();
  t.after(() => pinia.disposePinia(root));
  const lyric = useLyricStore(root);
  lyric.loadedHash = 'a';
  lyric.lines = [{ time: 1, text: '歌词', characters: [] }];
  lyric.adjustTimeOffset(100);
  let seeks = 0;
  const player = pinia.defineStore('offset-player', {
    state: () => ({
      playbackClock: undefined,
      currentTime: 1,
      currentTimeUpdatedAt: 1000,
      isPlaying: false,
      duration: 100,
      playbackRate: 1,
      currentTrackId: 'a',
      currentTrackSnapshot: { id: 'a', hash: 'a', name: 'test' },
      seekTimestamp: 0,
      nativeTrackSeq: 1,
      volume: 50,
      currentSourceQueueId: 'q',
      playbackProgressBusyReason: null,
      playbackProgressIsBusy: false,
    }),
    actions: {
      seek() {
        seeks++;
      },
    },
  })(root);
  const playlist = pinia.defineStore('offset-playlist', {
    state: () => ({ favorites: [], favoritesLoaded: true }),
    actions: { getQueueById: () => null, isFavoriteSong: () => false },
  })(root);
  const settings = vue.reactive({ globalFont: '', buildGlobalFontFamily: () => '' });
  const theme = vue.reactive({ isDark: false });
  const desktop = vue.reactive({ settings: { enabled: false }, hydrate: async () => null });
  const patches = { nowPlaying: [], miniPlayer: [], desktopLyric: [] };
  const commands = {};
  const electron = Object.fromEntries(
    Object.keys(patches).map((key) => [
      key,
      {
        syncSnapshot: (patch) => patches[key].push(patch),
        onSnapshot: () => () => {},
        onCommand: (handler) => {
          commands[key] = handler;
          return () => {};
        },
      },
    ]),
  );
  electron.ipcRenderer = { on() {}, off() {} };
  const mocks = {
    vue,
    pinia,
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/lyric': { useLyricStore: () => lyric },
    '@/stores/setting': { useSettingStore: () => settings },
    '@/stores/theme': { useThemeStore: () => theme },
    '@/stores/toast': { useToastStore: () => ({ success() {} }) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => desktop },
    './store': { useDesktopLyricStore: () => desktop },
    '@/utils/shortcuts': {},
    '@/utils/lruMap': lruMap,
    '@/stores/playlist/helpers': { resolveFavoriteSongKey: () => 'a' },
    '../../shared/nowPlaying': nowPlaying,
    '../../shared/lyrics': lyrics,
    '../../shared/desktopLyric': desktopLyric,
  };
  for (const [file, init] of [
    ['nowPlaying', 'initNowPlayingSync'],
    ['miniPlayer', 'initMiniPlayerSync'],
    ['desktopLyric', 'initDesktopLyricSync'],
  ]) {
    const api = compile(`../src/renderer/${file}/sync.ts`, mocks, { electron });
    const dispose = await api[init]();
    t.after(dispose);
  }
  const verify = (expected) => {
    assert.equal(patches.nowPlaying.filter((p) => p.lyric).at(-1).lyric.timeOffset, expected);
    assert.equal(patches.miniPlayer.filter((p) => p.lyric).at(-1).lyric.timeOffset, expected);
    assert.equal(
      patches.desktopLyric.filter((p) => 'lyricTimeOffset' in p).at(-1).lyricTimeOffset,
      expected,
    );
    assert.equal(player.currentTime, 1);
    assert.equal(seeks, 0);
  };
  lyric.setGlobalTimeOffset(400);
  await vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 120));
  verify(500);
  commands.nowPlaying('lyricOffsetReset');
  await vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 120));
  verify(400);
  lyric.setGlobalTimeOffset(-300);
  await vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 120));
  verify(-300);
});

test('old profiles default to zero; global calibration persists across track changes and lyric clearing', () => {
  const lyric = store();
  assert.equal(lyric.currentTimeOffset, 0);
  lyric.loadedHash = 'a';
  lyric.adjustTimeOffset(200);
  lyric.setGlobalTimeOffset(400);
  assert.equal(lyric.currentTimeOffset, 600);
  lyric.beginLoading('b');
  assert.equal(lyric.currentTimeOffset, 400);
  lyric.adjustTimeOffset(-100);
  assert.equal(lyric.currentTimeOffset, 300);
  lyric.clear('a');
  assert.equal(lyric.currentTimeOffset, 600);
  assert.deepEqual({ ...lyric.timeOffsetMap }, { a: 200, b: -100 });
});

test('global and track reset are independent, including cancelling offsets', () => {
  const lyric = store();
  lyric.loadedHash = 'a';
  lyric.setGlobalTimeOffset(500);
  lyric.adjustTimeOffset(-500);
  assert.equal(lyric.currentTimeOffset, 0);
  assert.equal(lyric.currentTrackTimeOffset, -500);
  lyric.resetTimeOffset();
  assert.equal(lyric.currentTimeOffset, 500);
  lyric.adjustTimeOffset(250);
  lyric.setGlobalTimeOffset(0);
  assert.equal(lyric.currentTimeOffset, 250);
});

test('offsets normalize invalid persisted values, clamp each scope and do not clamp their sum', () => {
  const lyric = store();
  lyric.loadedHash = 'a';
  for (const value of [NaN, Infinity, -Infinity, undefined, null, '500', {}]) {
    lyric.globalTimeOffsetMs = value;
    lyric.timeOffsetMap.a = value;
    assert.equal(lyric.currentTimeOffset, 0);
  }
  lyric.setGlobalTimeOffset(20000);
  lyric.adjustTimeOffset(20000);
  assert.equal(lyric.currentTimeOffset, 20000);
  assert.equal(lyric.adjustTimeOffset(NaN), 10000);
  lyric.setGlobalTimeOffset(-20000);
  assert.equal(lyric.currentTimeOffset, 0);
  lyric.setGlobalTimeOffset(400.4);
  assert.equal(lyric.globalTimeOffsetMs, 400);
});

test('positive offset advances line and word highlighting once, negative offset delays it', () => {
  const lyric = store();
  lyric.loadedHash = 'a';
  lyric.lines = [1, 2].map((time) => ({
    time,
    text: `line ${time}`,
    characters: [
      { text: '字', startTime: time * 1000, endTime: time * 1000 + 500, highlighted: false },
    ],
  }));
  lyric.updateCurrentIndex(0.5, true);
  assert.equal(lyric.currentIndex, -1);
  lyric.setGlobalTimeOffset(300);
  lyric.adjustTimeOffset(200);
  lyric.updateCurrentIndex(0.5, true);
  assert.equal(lyric.currentIndex, 0);
  assert.equal(lyric.lines[0].characters[0].highlighted, true);
  lyric.updateCurrentIndex(1.2, true);
  assert.equal(lyric.currentIndex, 0, 'offset must not be applied twice');
  lyric.setGlobalTimeOffset(-800);
  lyric.updateCurrentIndex(1.2, true);
  assert.equal(lyric.currentIndex, -1);
  assert.equal(lyric.lines[0].characters[0].highlighted, false);
});

test('SQLite persistence saves both scopes and restores them in a new store', async () => {
  let saved;
  const writes = [];
  const timers = new Map();
  const window = {
    setTimeout: (fn) => {
      timers.set(1, fn);
      return 1;
    },
    clearTimeout: (id) => timers.delete(id),
    electron: {
      storage: {
        getKv: async () => saved,
        setKv: async (_key, value) => {
          saved = value;
          writes.push(value);
        },
      },
    },
  };
  const plugin = compile(
    '../src/renderer/stores/sqlitePersist.ts',
    {
      '../../shared/storePersistence': persistence,
    },
    window,
  );
  const firstPinia = pinia.createPinia().use(plugin.sqlitePersistPlugin);
  vue.createApp({}).use(firstPinia);
  const first = useLyricStore(firstPinia);
  await plugin.waitForSqlitePersistHydration();
  first.loadedHash = 'a';
  first.setGlobalTimeOffset(400);
  first.adjustTimeOffset(-100);
  await vue.nextTick();
  for (const fn of timers.values()) fn();
  assert.equal(writes.length, 1);
  assert.equal(saved.globalTimeOffsetMs, 400);
  assert.equal(saved.timeOffsetMap.a, -100);
  const secondPinia = pinia.createPinia().use(plugin.sqlitePersistPlugin);
  vue.createApp({}).use(secondPinia);
  const second = useLyricStore(secondPinia);
  await plugin.waitForSqlitePersistHydration();
  second.loadedHash = 'a';
  assert.equal(second.currentTimeOffset, 300);
  pinia.disposePinia(firstPinia);
  pinia.disposePinia(secondPinia);
});
