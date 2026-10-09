import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { DEFAULT_DESKTOP_LYRIC_SETTINGS } from '../src/shared/desktopLyric.ts';
import { DEFAULT_MINI_LYRIC_STYLE, normalizeMiniLyricStyle } from '../src/shared/miniPlayer.ts';
import * as accentPalette from '../src/shared/accentPalette.ts';
import { normalizeAccent, contrastRatio, parseAccent } from '../src/shared/accentPalette.ts';

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
function load(code, mocks) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(code, { loader: 'ts', format: 'cjs' }).code,
  )((id) => (id === 'vue' ? vue : (mocks[id] ?? {})), module, module.exports);
  return module.exports;
}
const { resolveCoverLyricColor } = load(source('shared/lyricColor.ts'), {
  './accentPalette': accentPalette,
});

test('Mini style restores old snapshots, constrains malformed settings and preserves zero spacing', () => {
  assert.deepEqual(normalizeMiniLyricStyle(), DEFAULT_MINI_LYRIC_STYLE);
  assert.deepEqual(
    normalizeMiniLyricStyle({
      fontSize: null,
      secondaryFontSize: 'bad',
      fontWeight: 900,
      alignment: 'both',
      lineGap: NaN,
      backgroundBlur: null,
    }),
    DEFAULT_MINI_LYRIC_STYLE,
  );
  const limits = normalizeMiniLyricStyle({
    fontSize: 100,
    secondaryFontSize: 2,
    lineGap: 0,
    fontWeight: 400,
    alignment: 'left',
    backgroundBlur: false,
  });
  assert.equal(limits.fontSize, 22);
  assert.equal(limits.secondaryFontSize, 10);
  assert.equal(limits.lineGap, 0);
  assert.equal(limits.backgroundBlur, false);
});

test('real Mini panel updates both colors and typography without rebuilding lyrics, and removes disabled cover background', async () => {
  const { descriptor } = parse(source('renderer/miniPlayer/MiniLyricPanel.vue'));
  const panel = load(compileScript(descriptor, { id: 'mini', inlineTemplate: true }).content, {
    '../../shared/miniPlayer': { normalizeMiniLyricStyle },
    '@vueuse/core': { useResizeObserver() {} },
  }).default;
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('text', text),
    createComment: (text) => node('comment', text),
    setText: (el, text) => {
      el.text = text;
    },
    setElementText: (el, text) => {
      el.text = text;
      el.children = [];
    },
    patchProp: (el, key, _old, value) => {
      el.props[key] = value;
    },
    insert(el, parent, anchor) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, el);
      el.parent = parent;
    },
    remove(el) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = null;
    },
    parentNode: (el) => el.parent,
    nextSibling: (el) => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  });
  const root = node('root');
  const props = {
    visible: false,
    title: 'song',
    artist: 'artist',
    coverUrl: 'cover',
    lyric: {
      trackId: 'song',
      currentIndex: 0,
      lines: [
        { time: 0, text: 'lyric' },
        { time: 1, text: 'next' },
      ],
    },
  };
  const find = (className) => {
    const walk = (el) =>
      el.props.class?.split(' ').includes(className) ? el : el.children.map(walk).find(Boolean);
    return walk(root);
  };
  renderer.render(vue.h(panel, props), root);
  await vue.nextTick();
  const track = find('mini-lyric-track');
  assert.equal(track.props.style['--mini-lyric-unplayed'], 'var(--text-secondary)');
  assert.equal(track.props.style['--mini-lyric-font-size'], '14px');
  assert.ok(find('mini-lyric-bg'));
  renderer.render(
    vue.h(panel, {
      ...props,
      playedColor: '#123456',
      unplayedColor: '#abcdef',
      lyricStyle: {
        fontSize: 20,
        secondaryFontSize: 15,
        fontWeight: 400,
        alignment: 'left',
        lineGap: 8,
        backgroundBlur: false,
      },
    }),
    root,
  );
  await vue.nextTick();
  assert.equal(find('mini-lyric-track'), track);
  assert.equal(track.props.style['--mini-lyric-played'], '#123456');
  assert.equal(track.props.style['--mini-lyric-unplayed'], '#abcdef');
  assert.equal(track.props.style['--mini-lyric-font-size'], '20px');
  assert.equal(track.props.style['--mini-lyric-secondary-size'], '15px');
  assert.equal(track.props.style['--mini-lyric-font-weight'], 400);
  assert.equal(track.props.style['--mini-lyric-alignment'], 'left');
  assert.equal(track.props.style['--mini-lyric-line-gap'], '8px');
  assert.equal(find('mini-lyric-bg'), undefined);
  renderer.render(null, root);
});
function section(file, mocks) {
  const { descriptor } = parse(source(file));
  const component = load(compileScript(descriptor, { id: file }).content, mocks).default;
  const scope = vue.effectScope();
  const exposed = scope.run(() => component.setup({}, { expose() {}, emit() {} }));
  return { exposed, stop: () => scope.stop() };
}

test('transparent desktop uses bright normalized colors; Mini colors retain text contrast', () => {
  for (const color of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#777777']) {
    assert.equal(resolveCoverLyricColor(color, 'desktop'), normalizeAccent(color, true));
    for (const [mode, background] of [
      ['light', '#ffffff'],
      ['dark', '#121212'],
    ]) {
      const actual = resolveCoverLyricColor(color, mode, [background]);
      assert.ok(contrastRatio(parseAccent(actual), parseAccent(background)) >= 4.5);
    }
  }
  for (const value of [undefined, null, '', '__cover__', 'red', '#xyzxyz']) {
    assert.equal(resolveCoverLyricColor(value, 'desktop'), undefined);
  }
});

test('desktop color picker enables cover without overwriting manual colors and fixed selection disables it', async () => {
  const settings = vue.reactive({
    ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
    playedColor: '#123456',
    unplayedColor: '#654321',
  });
  const theme = vue.reactive({ coverColor: '#ff0000', coverColorReady: true });
  const store = {
    settings,
    async syncSettings(patch) {
      Object.assign(settings, patch);
    },
  };
  const fixture = section('renderer/views/settings/components/DesktopLyricSettingsSection.vue', {
    '@/desktopLyric/store': { useDesktopLyricStore: () => store },
    '@/stores/theme': { useThemeStore: () => theme },
    '../../../../shared/desktopLyric': { DEFAULT_DESKTOP_LYRIC_SETTINGS },
    '../../../../shared/lyricColor': { resolveCoverLyricColor },
  });
  const s = fixture.exposed;
  s.openDesktopLyricColorPicker('playedColor');
  assert.equal(s.coverColorOption.value.value, '__cover__');
  await s.applyDesktopLyricColor('__cover__');
  assert.equal(settings.followCoverColor, true);
  assert.equal(settings.playedColor, '#123456');
  assert.equal(s.playedColorPreview.value, resolveCoverLyricColor('#ff0000', 'desktop'));
  theme.coverColorReady = false;
  assert.equal(s.playedColorPreview.value, '#123456');
  s.openDesktopLyricColorPicker('unplayedColor');
  assert.equal(s.coverColorOption.value.value, '__cover__');
  await s.applyDesktopLyricColor('__cover__');
  assert.equal(settings.unplayedFollowCoverColor, true);
  assert.equal(settings.unplayedColor, '#654321');
  assert.equal(s.unplayedColorPreview.value, '#654321');
  theme.coverColorReady = true;
  assert.equal(s.unplayedColorPreview.value, resolveCoverLyricColor('#ff0000', 'desktop'));
  s.openDesktopLyricColorPicker('unplayedColor');
  assert.equal(s.activeDesktopLyricColorValue.value, '__cover__');
  s.closeDesktopLyricColorPicker();
  assert.equal(settings.followCoverColor, true);
  s.openDesktopLyricColorPicker('playedColor');
  await s.applyDesktopLyricColor('#fedcba');
  assert.equal(settings.followCoverColor, false);
  assert.equal(settings.unplayedFollowCoverColor, true);
  s.openDesktopLyricColorPicker('unplayedColor');
  await s.applyDesktopLyricColor('#abcdef');
  assert.equal(settings.unplayedFollowCoverColor, false);
  assert.equal(settings.unplayedColor, '#abcdef');
  assert.equal(s.playedColorPreview.value, '#fedcba');
  fixture.stop();
});

test('Mini picker keeps its own colors, supports no-cover fallback and reset to theme', () => {
  const settings = vue.reactive({
    miniLyricFollowCoverColor: false,
    miniLyricPlayedColor: '#123456',
    miniLyricUnplayedFollowCoverColor: false,
    miniLyricUnplayedColor: '#654321',
  });
  const theme = vue.reactive({
    coverColor: '#ff0000',
    coverColorReady: true,
    isDark: true,
    accentSurfaces: ['#121212'],
    accentTextColor: '#abcdef',
    cssTokens: { '--text-secondary': '#777777', '--floating-text-secondary': '#888888' },
  });
  const fixture = section('renderer/views/settings/components/MiniLyricSettingsSection.vue', {
    '@/stores/setting': { useSettingStore: () => settings },
    '@/stores/theme': { useThemeStore: () => theme },
    '../../../../shared/lyricColor': { resolveCoverLyricColor },
    '../../../../shared/miniPlayer': { DEFAULT_MINI_LYRIC_STYLE, normalizeMiniLyricStyle },
  });
  const s = fixture.exposed;
  s.openMiniColor('played');
  s.applyMiniColor('__cover__');
  assert.equal(settings.miniLyricPlayedColor, '#123456');
  assert.equal(s.miniColorPreview.value, resolveCoverLyricColor('#ff0000', 'dark', ['#121212']));
  theme.coverColorReady = false;
  assert.equal(s.miniColorPreview.value, '#123456');
  s.openMiniColor('played');
  s.applyMiniColor('#fedcba');
  assert.equal(settings.miniLyricFollowCoverColor, false);
  assert.equal(s.miniColorPreview.value, '#fedcba');
  s.openMiniColor('unplayed');
  s.applyMiniColor('__cover__');
  assert.equal(settings.miniLyricFollowCoverColor, false);
  assert.equal(settings.miniLyricUnplayedColor, '#654321');
  assert.equal(s.miniUnplayedColorPreview.value, '#654321');
  theme.coverColorReady = true;
  assert.equal(
    s.miniUnplayedColorPreview.value,
    resolveCoverLyricColor('#ff0000', 'dark', ['#121212']),
  );
  s.openMiniColor('unplayed');
  s.applyMiniColor('#112233');
  assert.equal(settings.miniLyricUnplayedFollowCoverColor, false);
  assert.equal(s.miniUnplayedColorPreview.value, '#112233');
  s.resetMiniColor();
  assert.equal(s.miniColorPreview.value, '#abcdef');
  assert.equal(s.miniUnplayedColorPreview.value, '#888888');
  s.updateMiniNumber('fontSize', '19');
  s.updateMiniNumber('secondaryFontSize', '15');
  s.updateMiniNumber('lineGap', '8');
  assert.equal(settings.miniLyricFontSize, 19);
  assert.equal(settings.miniLyricSecondaryFontSize, 15);
  assert.equal(settings.miniLyricLineGap, 8);
  s.resetMiniStyle();
  assert.deepEqual(s.miniStyle.value, DEFAULT_MINI_LYRIC_STYLE);
  fixture.stop();
});

test('shared cover extraction rejects old song results, clears readiness while loading and after failure', async () => {
  const pending = new Map();
  const options = load(source('renderer/stores/theme.ts'), {
    pinia: { defineStore: (_id, options) => options },
    '@/utils/color': {
      DEFAULT_ACCENT: '#0071e3',
      waitForAbortableDelay: async (_delay, signal) => !signal.aborted,
      extractDominantColor: (url) => new Promise((resolve) => pending.set(url, resolve)),
    },
  }).useThemeStore;
  const state = { coverColor: '#112233', coverColorReady: true, applyCurrent() {} };
  const refresh = (url) => options.actions.refreshCoverColor.call(state, url);
  const a = refresh('a');
  await Promise.resolve();
  assert.equal(state.coverColorReady, false);
  const b = refresh('b');
  await Promise.resolve();
  pending.get('b')('#ff0000');
  await b;
  assert.equal(state.coverColorReady, true);
  pending.get('a')('#00ff00');
  assert.equal(await a, null);
  assert.equal(state.coverColor, '#ff0000');
  const failed = refresh('failure');
  await Promise.resolve();
  pending.get('failure')(null);
  await failed;
  assert.equal(state.coverColorReady, false);
  assert.equal(await refresh(''), '#0071e3');
  assert.equal(state.coverColorReady, false);
});

test('desktop display derives color without mutating persisted manual settings', () => {
  const file = source('renderer/desktopLyric/DesktopLyricView.vue');
  const code = file.slice(
    file.indexOf('const coverLyricColor ='),
    file.indexOf('const lyricTextShadow ='),
  );
  const settings = vue.ref({
    followCoverColor: true,
    playedColor: '#123456',
    unplayedColor: '#abcdef',
  });
  const snapshot = vue.ref({ playback: { coverColor: '#ff0000' } });
  const { playedColor, unplayedColor } = new Function(
    'computed',
    'settings',
    'snapshot',
    'resolveCoverLyricColor',
    `${transformSync(code, { loader: 'ts' }).code}; return { playedColor, unplayedColor };`,
  )(vue.computed, settings, snapshot, resolveCoverLyricColor);
  assert.equal(playedColor.value, resolveCoverLyricColor('#ff0000', 'desktop'));
  assert.equal(unplayedColor.value, '#abcdef');
  snapshot.value.playback = {};
  assert.equal(playedColor.value, '#123456');
  settings.value.followCoverColor = false;
  settings.value.unplayedFollowCoverColor = true;
  snapshot.value.playback.coverColor = '#ff0000';
  assert.equal(playedColor.value, '#123456');
  assert.equal(unplayedColor.value, resolveCoverLyricColor('#ff0000', 'desktop'));
  snapshot.value.playback = {};
  assert.equal(unplayedColor.value, '#abcdef');
  settings.value.unplayedFollowCoverColor = false;
  snapshot.value.playback.coverColor = '#ff0000';
  assert.equal(unplayedColor.value, '#abcdef');
});

test('Mini appearance sends color changes without settings writes or lyric progress updates', async () => {
  const sent = [];
  const theme = vue.reactive({
    isDark: true,
    cssTokens: {},
    floatingSurfaceFrosted: false,
    accentColor: '#0071e3',
    coverColor: '#ff0000',
    coverColorReady: true,
    accentSurfaces: ['#121212'],
  });
  const setting = vue.reactive({
    miniLyricFollowCoverColor: true,
    miniLyricPlayedColor: '#123456',
    buildGlobalFontFamily: () => '',
    miniLyricUnplayedFollowCoverColor: false,
    miniLyricUnplayedColor: '#654321',
  });
  const player = vue.reactive({
    currentTrackId: null,
    currentTrackSnapshot: null,
    playbackClock: null,
    currentTime: 0,
    isPlaying: false,
    duration: 0,
    playbackRate: 1,
    nativeTrackSeq: 0,
    volume: 50,
    currentSourceQueueId: null,
    seekTimestamp: 0,
    playbackProgressBusyReason: null,
    playbackProgressIsBusy: false,
  });
  const lyric = vue.reactive({
    displayLines: [],
    displayRevision: 0,
    currentIndex: -1,
    wantTranslation: false,
    wantRomanization: false,
    showRomanizationAsRuby: false,
    hasTranslation: false,
    hasRomanization: false,
    currentTimeOffset: 0,
    tips: '',
  });
  const playlist = vue.reactive({
    getQueueById: () => null,
    favorites: [],
    defaultList: [],
    favoritesLoaded: true,
  });
  const desktop = vue.reactive({ settings: { enabled: false } });
  globalThis.window = {
    electron: {
      miniPlayer: {
        syncSnapshot: (patch) => sent.push(patch),
        onSnapshot: () => () => {},
        onCommand: () => () => {},
      },
    },
  };
  const sync = load(source('renderer/miniPlayer/sync.ts'), {
    pinia: { storeToRefs: vue.toRefs },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/lyric': { useLyricStore: () => lyric },
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/theme': { useThemeStore: () => theme },
    '@/stores/setting': { useSettingStore: () => setting },
    '@/desktopLyric/store': { useDesktopLyricStore: () => desktop },
    '../../shared/lyricColor': { resolveCoverLyricColor },
    '../../shared/miniPlayer': { normalizeMiniLyricStyle },
  });
  const dispose = await sync.initMiniPlayerSync();
  assert.equal(sent.findLast((p) => p.appearance).appearance.lyricUnplayedColor, '#654321');
  assert.deepEqual(
    sent.findLast((p) => p.appearance).appearance.lyricStyle,
    DEFAULT_MINI_LYRIC_STYLE,
  );
  assert.equal(
    sent.findLast((p) => p.appearance).appearance.lyricPlayedColor,
    resolveCoverLyricColor('#ff0000', 'dark', ['#121212']),
  );
  theme.coverColorReady = false;
  await vue.nextTick();
  assert.equal(sent.at(-1).appearance.lyricPlayedColor, '#123456');
  theme.coverColor = '#00ff00';
  theme.coverColorReady = true;
  await vue.nextTick();
  assert.equal(
    sent.at(-1).appearance.lyricPlayedColor,
    resolveCoverLyricColor('#00ff00', 'dark', ['#121212']),
  );
  setting.miniLyricFollowCoverColor = false;
  setting.miniLyricPlayedColor = '';
  await vue.nextTick();
  assert.equal(sent.at(-1).appearance.lyricPlayedColor, undefined);
  setting.miniLyricUnplayedFollowCoverColor = true;
  setting.miniLyricFontSize = 20;
  setting.miniLyricAlignment = 'right';
  setting.miniLyricBackgroundBlur = false;
  await vue.nextTick();
  assert.equal(
    sent.at(-1).appearance.lyricUnplayedColor,
    resolveCoverLyricColor('#00ff00', 'dark', ['#121212']),
  );
  assert.equal(sent.at(-1).appearance.lyricStyle.fontSize, 20);
  assert.equal(sent.at(-1).appearance.lyricStyle.alignment, 'right');
  assert.equal(sent.at(-1).appearance.lyricStyle.backgroundBlur, false);
  const count = sent.length;
  dispose();
  theme.coverColor = '#0000ff';
  await vue.nextTick();
  assert.equal(sent.length, count);
});

test('desktop color merge preserves native clock and rejects a different song, cover or transition', () => {
  const file = source('main/desktopLyric.ts');
  const code = file.slice(
    file.indexOf('      // 取色完成可能晚于原生进度补丁'),
    file.indexOf('      if (payload.lyrics !== undefined)'),
  );
  const { isSamePlaybackSnapshot } = load(source('shared/playback.ts'), {});
  const apply = new Function(
    'snapshot',
    'payload',
    'desktopLyricPlaybackBridge',
    'isSameDesktopLyricPlayback',
    `let desktopPatch = {}; ${transformSync(code, { loader: 'ts' }).code}; return { snapshot, desktopPatch };`,
  );
  const current = {
    trackId: 'a',
    lyricHash: 'a',
    trackSeq: 2,
    coverUrl: 'cover-a',
    currentTime: 50,
    updatedAt: 200,
    clock: { marker: 'native' },
    coverColor: '#ff0000',
  };
  const incoming = { ...current, coverColor: '#00ff00', currentTime: 10, updatedAt: 100 };
  const run = (patch, awaitingRenderer = false) =>
    apply({ playback: current }, { playback: patch }, { awaitingRenderer }, (a, b) =>
      isSamePlaybackSnapshot(a, b),
    );
  const result = run(incoming);
  assert.equal(result.snapshot.playback.coverColor, '#00ff00');
  assert.equal(result.snapshot.playback.currentTime, 50);
  assert.equal(result.snapshot.playback.updatedAt, 200);
  assert.equal(result.snapshot.playback.clock, current.clock);
  assert.equal(run({ ...incoming, trackSeq: 1 }).snapshot.playback, current);
  assert.equal(run({ ...incoming, coverUrl: 'cover-b' }).snapshot.playback, current);
  assert.equal(run(incoming, true).snapshot.playback, current);
  assert.equal(run({ ...incoming, coverColor: undefined }).snapshot.playback.coverColor, undefined);
});

test('desktop sync coalesces color updates into playback only, including while paused, and disposes watchers', async () => {
  const sent = [];
  const theme = vue.reactive({ coverColor: '#ff0000', coverColorReady: true });
  const player = vue.reactive({
    currentTrackId: 'a',
    currentTrackSnapshot: { id: 'a', hash: 'a', coverUrl: 'cover-a' },
    playbackClock: null,
    currentTime: 10,
    isPlaying: false,
    duration: 100,
    playbackRate: 1,
    nativeTrackSeq: 2,
    seekTimestamp: 0,
    currentTimeUpdatedAt: 100,
  });
  const lyric = vue.reactive({
    displayLines: [],
    displayRevision: 0,
    currentIndex: -1,
    loadedHash: 'a',
    currentTimeOffset: 0,
    currentTrackTimeOffset: 0,
    wantTranslation: false,
    wantRomanization: false,
    showRomanizationAsRuby: false,
    textConversionMode: 'none',
  });
  const settings = vue.reactive({ ...DEFAULT_DESKTOP_LYRIC_SETTINGS });
  const snapshot = {
    playback: null,
    lyricsTrackId: null,
    lyricsRevision: 0,
    lyrics: [],
    currentIndex: -1,
    lyricTimeOffset: 0,
    currentTrackTimeOffset: 0,
    settings,
    lockPhase: 'idle',
  };
  const desktop = {
    settings,
    hydrate: async () => snapshot,
    setLocal(patch) {
      Object.assign(settings, patch);
    },
  };
  globalThis.window = {
    electron: {
      ipcRenderer: { on() {}, off() {} },
      desktopLyric: {
        syncSnapshot: (patch) => sent.push(patch),
        onSnapshot: () => () => {},
      },
    },
  };
  const shared = load(source('shared/desktopLyric.ts'), {});
  const sync = load(source('renderer/desktopLyric/sync.ts'), {
    pinia: { storeToRefs: vue.toRefs },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/lyric': { useLyricStore: () => lyric },
    '@/stores/setting': { useSettingStore: () => ({ lyricOffsetStep: 0.5 }) },
    '@/stores/theme': { useThemeStore: () => theme },
    './store': { useDesktopLyricStore: () => desktop },
    '@/stores/toast': { useToastStore: () => ({}) },
    '../../shared/desktopLyric': shared,
  });
  const dispose = await sync.initDesktopLyricSync();
  await new Promise((resolve) => setTimeout(resolve, 95));
  assert.equal(sent.findLast((p) => p.playback).playback.coverColor, '#ff0000');
  sent.length = 0;
  theme.coverColor = '#00ff00';
  theme.coverColor = '#0000ff';
  await vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 95));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].playback.coverColor, '#0000ff');
  assert.equal(sent[0].settings, undefined);
  theme.coverColorReady = false;
  await vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 95));
  assert.equal(sent.at(-1).playback.coverColor, undefined);
  const count = sent.length;
  dispose();
  theme.coverColorReady = true;
  await vue.nextTick();
  assert.equal(sent.length, count);
});
