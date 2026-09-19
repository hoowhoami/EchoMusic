import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import {
  computed,
  createRenderer,
  defineComponent,
  effectScope,
  h,
  nextTick,
  reactive,
  ref,
} from 'vue';

const require = createRequire(import.meta.url);
const root = resolve('.');
const fixture = {};
const stubs = {
  '@/stores/player': 'export const usePlayerStore = () => fixture.controls.player;',
  '@/stores/setting': 'export const useSettingStore = () => fixture.settings;',
  '@/stores/lyric':
    'export const useLyricStore = () => fixture.lyric; export const LYRIC_COVER_COLOR_VALUE = "__cover__";',
  '@/stores/toast': 'export const useToastStore = () => fixture.toast;',
  '@/composables/usePlayerControls': 'export const usePlayerControls = () => fixture.controls;',
  '@/plugins/coverFallback': 'export const coverFallbackRevision = { value: 0 };',
  '@/utils/cover': 'export const resolveCoverDisplayUrl = () => "";',
};
const realComponents = new Set(['LyricPage.vue', 'LyricPageTitlebar.vue', 'OverlayHeader.vue']);
const bundle = await build({
  stdin: {
    contents: `export * from './src/renderer/plugins/lyricsPage';
      export { default as Boundary } from './src/renderer/plugins/PluginLyricsPageView';
      export { default as Page } from './src/renderer/views/lyric/LyricPage.vue';
      export { useLyricsPageContext } from './src/renderer/views/lyric/composables/useLyricsPageContext';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'lyric-host-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === 'vue') return { path: 'vue', external: true };
          if (stubs[args.path]) return { path: args.path, namespace: 'fixture' };
          if (args.path === '@/icons') return { path: args.path, namespace: 'fixture' };
          if (args.path.endsWith('/useLyricBackground'))
            return { path: 'background', namespace: 'fixture' };
          if (args.path.endsWith('.vue')) {
            const file = args.path.startsWith('@/')
              ? resolve(root, 'src/renderer', args.path.slice(2))
              : resolve(args.resolveDir, args.path);
            return {
              path: file,
              namespace: realComponents.has(basename(file)) ? 'sfc' : 'component',
            };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            stubs[args.path] ??
            (args.path === 'background'
              ? 'export const useLyricBackground = () => ({ backgroundColor: { value: "" } });'
              : 'export const iconChevronDown={}, iconChevronLeft={}, iconChevronRight={}, iconList={}, iconSettings={}, iconArrowBarDown={}, iconArrowBarToUp={}, iconRotateCcw={}, iconRotateCw={}, iconRefreshCw={}, iconCopy={}, iconShirt={};'),
          loader: 'js',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'component' }, (args) => ({
          contents: `import { h } from 'vue'; export default { name: ${JSON.stringify(basename(args.path))},
          inheritAttrs: false, setup(_, { attrs, slots }) { return () => h(${JSON.stringify(basename(args.path))}, attrs, slots.default?.()); } };`,
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
const api = module.exports;
const makeApi = (id = 'test', errors = []) =>
  api.createLyricsPageApi(
    id,
    () => {},
    (source, error) => errors.push({ source, error }),
    true,
  );
const key = (id = 'test', page = 'custom') => JSON.stringify([id, page]);
afterEach(() => {
  ['test', 'other'].forEach(api.removeLyricsPagesByPlugin);
});

// Exercise real Vue mounting/error capture without an Electron window or music account.
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null });
const renderer = createRenderer({
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
  patchProp: (el, name, old, value) => {
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
const flatten = (tree) => [tree, ...tree.children.flatMap(flatten)];
const find = (tree, type) => flatten(tree).find((el) => el.type === type);
const flush = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};

function setupFixture(t) {
  const calls = [];
  const listeners = new Map();
  const oldWindow = globalThis.window,
    oldDocument = globalThis.document;
  const cleanups = [];
  fixture.cleanups = cleanups;
  globalThis.window = {
    electron: { platform: 'linux' },
    setTimeout,
    clearTimeout,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
  t.after(() => {
    cleanups.forEach((cleanup) => cleanup());
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  fixture.settings = reactive({
    lyricViewMode: 'cover',
    lyricsPageProvider: 'host',
    effectiveWindowBackground: {},
    lyricOffsetStep: 0.5,
    viperTapeQualityEnabled: true,
  });
  fixture.lyric = reactive({
    lines: [],
    sourceDialogOpen: false,
    currentTimeOffset: 0,
    loadedHash: '',
    clear() {},
    fetchLyrics() {},
    updateCurrentIndex() {},
    adjustTimeOffset(ms) {
      this.currentTimeOffset += ms;
    },
    resetTimeOffset() {
      this.currentTimeOffset = 0;
    },
  });
  fixture.toast = { warning: (value) => calls.push(['warning', value]), success() {} };
  const player = reactive({
    currentTime: 2,
    duration: 120,
    volume: 50,
    playMode: 'list',
    audioEffect: 'none',
    isPlaying: true,
    toggleLyricView: (value) => calls.push(['visible', value]),
    togglePlay: () => calls.push(['toggle']),
    next: () => calls.push(['next']),
    prev: () => calls.push(['prev']),
    setVolume(value) {
      this.volume = value;
    },
    seek: (value) => calls.push(['seek', value]),
    setPlayMode(value) {
      this.playMode = value;
    },
    playTrack: (...args) => calls.push(['playTrack', ...args]),
  });
  const track = { id: 'a', name: 'Song A', hash: 'hash-a', mixSongId: '100' };
  fixture.controls = {
    player,
    playlist: { removeFromQueue: (...args) => calls.push(['remove', ...args]) },
    settingStore: fixture.settings,
    currentTrack: ref(track),
    currentPlaybackQueue: ref({ id: 'queue-a', songs: [track] }),
    isQueueDrawerOpen: ref(false),
    showAddToPlaylistDialog: ref(false),
    isPlaylistLoading: ref(false),
    createdPlaylists: ref([]),
    addToPlaybackQueues: ref([]),
    canAddToPlaylist: ref(true),
    handleOpenAddToPlaylist() {
      this;
      fixture.controls.showAddToPlaylistDialog.value = true;
    },
    handleAddToQueue() {},
    handleSelectPlaylist() {},
    isFavorite: ref(false),
    toggleFavorite: () => calls.push(['favorite']),
    isAudioQualityDisabled: (value) => value === 'high',
    effectiveAudioQuality: ref('flac'),
    isAudioEffectPresetSelectionDisabled: ref(false),
    isAudioSourceSwitching: ref(false),
    playModeLabel: ref('列表循环'),
    canShareCurrentTrack: ref(true),
    isResolvedCloudSource: ref(false),
    hasCloudAudioSourceOption: ref(false),
    toggleMute() {},
    setPlaybackRate() {},
    cyclePlayMode() {},
    ensureCurrentTrackCatalogQualities() {},
    setAudioQuality: (value) => calls.push(['quality', value]),
    setCloudAudioSource() {},
    setAudioEffect() {},
    handleShareCurrentTrack() {},
    toggleDesktopLyric() {},
  };
  return { calls, listeners };
}

function mountPage(t) {
  const tree = node('root');
  const app = renderer.createApp(api.Page);
  app.component('Icon', { render: () => h('icon') });
  app.mount(tree);
  fixture.cleanups.push(() => app.unmount());
  return tree;
}

test('registrations are namespaced, validated, and old disposers cannot remove replacements', () => {
  const one = makeApi(),
    other = makeApi('other');
  const component = { render: () => null };
  const dispose = one.register({ id: 'custom', component });
  other.register({ id: 'custom', component, titlebar: 'none' });
  one.register({ id: 'custom', component, title: 'New' });
  dispose();
  dispose();
  assert.equal(api.resolveLyricsPage(key()).title, 'New');
  assert.equal(api.resolveLyricsPage(key()).titlebar, 'host');
  assert.equal(api.resolveLyricsPage(key('other')).titlebar, 'none');
  assert.equal(api.resolveLyricsPage('host'), undefined);
  for (const input of [
    { id: '', component },
    { id: 'bad', component: null },
    { id: 'bad', component, titlebar: 'main' },
  ])
    assert.throws(() => one.register(input));
  assert.throws(() => one.usePage(), /setup/);
  api.removeLyricsPagesByPlugin('test');
  assert.equal(api.lyricsPages.value.length, 5); // 4 built-in skins + 1 plugin page
});

test('host and none modes replace native content, keep shared panels, and revoke stale actions', async (t) => {
  setupFixture(t);
  let page;
  const plugin = makeApi();
  const component = defineComponent({
    setup() {
      page = plugin.usePage();
      return () => h('replacement');
    },
  });
  const dispose = plugin.register({ id: 'custom', component });
  const tree = mountPage(t);
  assert.ok(find(tree, 'CoverMode.vue'));
  fixture.settings.lyricsPageProvider = key();
  await flush();
  assert.ok(find(tree, 'replacement'));
  assert.ok(find(tree, 'header'));
  assert.match(find(tree, 'header').props.class, /overlay-header/);
  assert.equal(find(tree, 'CoverMode.vue'), undefined);
  assert.equal(find(tree, 'LyricPlayerControls.vue'), undefined);
  assert.ok(flatten(tree).some((el) => String(el.props.class).includes('with-host-titlebar')));
  assert.ok(find(tree, 'LyricSourceDialog.vue'));
  const oldPage = page;
  plugin.register({ id: 'custom', component, titlebar: 'none' });
  dispose();
  await flush();
  assert.equal(find(tree, 'header'), undefined);
  assert.ok(find(tree, 'replacement'));
  assert.throws(() => oldPage.playback.next(), /失效/);
  assert.equal(page.state.value.titlebar, 'none');
  api.removeLyricsPagesByPlugin('test');
  await flush();
  assert.ok(find(tree, 'CoverMode.vue'));
  assert.ok(find(tree, 'header'));
  assert.throws(() => page.panels.open('queue'), /失效/);
});

test('render failures recover native content, reset selection, and do not retry on each open', async (t) => {
  setupFixture(t);
  const errors = [];
  let attempts = 0;
  makeApi('test', errors).register({
    id: 'custom',
    component: {
      render() {
        attempts++;
        throw Error('broken');
      },
    },
  });
  fixture.settings.lyricsPageProvider = key();
  const tree = mountPage(t);
  await flush();
  assert.ok(find(tree, 'CoverMode.vue'));
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(fixture.settings.lyricsPageProvider, 'host:cover');
  assert.equal(api.resolveLyricsPage(key()), undefined);
  api.retryAndSelectLyricsPage(key(), (next) => {
    fixture.settings.lyricsPageProvider = next;
  });
  await flush();
  assert.equal(attempts, 2);
  assert.ok(find(tree, 'CoverMode.vue'));
  assert.equal(fixture.settings.lyricsPageProvider, 'host:cover');
});

test('lyrics page register throws without capabilities.lyricsPage', () => {
  const denied = api.createLyricsPageApi('denied', () => {}, () => {}, false);
  assert.throws(
    () => denied.register({ id: 'custom', component: { render: () => null } }),
    /lyricsPage/,
  );
  assert.equal(api.resolveLyricsPage(key('denied')), undefined);
});

test('scoped barrage.enabled stays live and is revoked after unmount', () => {
  const enabled = { value: false };
  const page = {
    barrage: {
      get enabled() {
        return enabled.value;
      },
      set enabled(value) {
        enabled.value = value;
      },
      send() {},
    },
  };
  let active = true;
  const scoped = api.scopeLyricsPageContext(page, () => active);
  assert.equal(scoped.barrage.enabled, false);
  enabled.value = true;
  assert.equal(scoped.barrage.enabled, true);
  scoped.barrage.enabled = false;
  assert.equal(enabled.value, false);
  active = false;
  assert.throws(() => scoped.barrage.enabled, /失效/);
  assert.throws(() => {
    scoped.barrage.enabled = true;
  }, /失效/);
});

test('plugin panels use host surfaces; comments keep their original song and Escape closes the panel first', async (t) => {
  const { calls, listeners } = setupFixture(t);
  let page;
  const plugin = makeApi();
  plugin.register({
    id: 'custom',
    component: {
      setup() {
        page = plugin.usePage();
        return () => h('replacement');
      },
    },
  });
  fixture.settings.lyricsPageProvider = key();
  const tree = mountPage(t);
  await page.panels.open('comments');
  await flush();
  assert.equal(find(tree, 'CommentDrawer.vue').props.resourceId, '100');
  fixture.controls.currentTrack.value = { id: 'b', name: 'Song B', mixSongId: '200' };
  await flush();
  assert.equal(find(tree, 'CommentDrawer.vue').props.resourceId, '100');
  await page.panels.open('quality-picker');
  await flush();
  assert.equal(find(tree, 'CommentDrawer.vue').props.open, false);
  assert.equal(find(tree, 'QualityPopover.vue').props.open, true);
  await page.panels.open('audio-effects');
  await flush();
  assert.equal(find(tree, 'QualityPopover.vue'), undefined);
  assert.equal(find(tree, 'EffectPopover.vue').props.open, true);
  await page.panels.open('lyrics-picker');
  assert.equal(fixture.lyric.sourceDialogOpen, true);
  const escape = () =>
    listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  escape();
  assert.equal(fixture.lyric.sourceDialogOpen, false);
  assert.equal(
    calls.some(([name]) => name === 'visible'),
    false,
  );
  escape();
  assert.deepEqual(calls.at(-1), ['visible', false]);
  fixture.controls.canAddToPlaylist.value = false;
  await assert.rejects(page.panels.open('add-to-playlist'), /登录/);
  await assert.rejects(page.panels.open('unknown'), /未知/);
});

test('page controls share reactive playback and validate seek, volume, queues, and audio availability', async (t) => {
  const { calls } = setupFixture(t);
  const scope = effectScope();
  const page = scope.run(() =>
    api.useLyricsPageContext(
      fixture.controls,
      computed(() => 'host'),
      () => {},
      () => {},
    ),
  );
  t.after(() => scope.stop());
  page.playback.next();
  page.playback.prev();
  page.playback.toggle();
  page.playback.seek(300);
  page.playback.setVolume(200);
  assert.equal(page.state.value.volume, 100);
  assert.deepEqual(calls.slice(0, 4), [['next'], ['prev'], ['toggle'], ['seek', 120]]);
  assert.throws(() => page.playback.seek(NaN));
  page.playback.setMode('single');
  assert.equal(page.state.value.playMode, 'single');
  assert.throws(() => page.playback.setMode('invalid'));
  page.queue.play('a');
  page.queue.remove('a');
  assert.equal(calls.at(-2)[3].sourceQueueId, 'queue-a');
  assert.deepEqual(calls.at(-1), ['remove', 'a', 'queue-a']);
  assert.throws(() => page.queue.play('missing'));
  assert.throws(() => page.audio.setQuality('high'), /不可用/);
  page.audio.setQuality('flac');
  assert.deepEqual(calls.at(-1), ['quality', 'flac']);
  assert.equal(
    page.state.value.qualityOptions.some((option) => option.value === 'viper_tape'),
    true,
  );
  fixture.settings.viperTapeQualityEnabled = false;
  assert.equal(
    page.state.value.qualityOptions.some((option) => option.value === 'viper_tape'),
    false,
  );
  assert.throws(() => page.audio.setQuality('viper_tape'), /不可用/);
  page.lyrics.adjustOffset(500);
  assert.equal(page.state.value.lyrics.timeOffset, 500);
  page.lyrics.resetOffset();
  assert.equal(page.state.value.lyrics.timeOffset, 0);
  await page.favorite.toggle();
  assert.deepEqual(calls.at(-1), ['favorite']);
  scope.stop();
  assert.throws(() => page.panels.open('queue'), /关闭/);
});
