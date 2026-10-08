import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as vue from 'vue';
const evaluate = (source, dependencies = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )((id) => dependencies[id] ?? {}, module, module.exports);
  return module.exports;
};
const actions = evaluate(readFileSync('src/renderer/layouts/playerBarActions.ts', 'utf8'));
const { descriptor } = parse(
  readFileSync('src/renderer/views/lyric/LyricPlayerControls.vue', 'utf8'),
);
const source = compileScript(descriptor, { id: 'lyric-playerbar-layout' }).content;
const { descriptor: mainDescriptor } = parse(
  readFileSync('src/renderer/layouts/PlayerBar.vue', 'utf8'),
);
const mainSource = compileScript(mainDescriptor, { id: 'main-playerbar-layout' }).content;
function fixture(t, hasBarrage = true, surface = 'lyric') {
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const settings = vue.reactive({
    playerBarLayout: actions.emptyPlayerBarLayout(),
    lyricBarrageEnabled: false,
  });
  const verification = vue.reactive({ open: false });
  const track = vue.ref({ hash: 'A', name: 'Song' });
  const slots = hasBarrage ? { barrage: () => null } : {};
  const controls = {
    player: vue.reactive({ playMode: 'sequential' }),
    isFavorite: vue.ref(false),
    toggleFavorite: () => {
      controls.isFavorite.value = !controls.isFavorite.value;
    },
    currentTrack: track,
    queueCount: vue.ref(1),
    canAddToPlaylist: vue.ref(true),
    hasCurrentTrackMv: vue.ref(false),
    canShareCurrentTrack: vue.ref(true),
    playModeLabel: vue.ref('顺序播放'),
    playModeIcon: vue.ref({ body: 'mode' }),
  };
  controls.settingStore = settings;
  controls.desktopLyricStore = { settings: { enabled: false } };
  const component = evaluate(surface === 'main' ? mainSource : source, {
    vue: { ...vue, useSlots: () => slots, onMounted() {}, onUnmounted() {} },
    'vue-router': { useRouter: () => ({}) },
    '@/icons': { iconHeart: { body: 'heart' }, iconHeartFilled: { body: 'filled-heart' } },
    '@/composables/useLyricPagePreload': { useLyricPagePreload: () => () => {} },
    './playerBarActions': actions,
    '@vueuse/core': { useElementSize: () => ({ width: vue.ref(0) }), useResizeObserver() {} },
    '@/stores/setting': { useSettingStore: () => settings },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({ settings: { enabled: false } }) },
    '@/stores/toast': { useToastStore: () => ({}) },
    '@/stores/output': { useOutputStore: () => ({ snapshot: null }) },
    '@/plugins/playerbar': { playerbarItems: vue.ref([]) },
    '@/layouts/playerBarActions': actions,
    '@/composables/usePlayerControls': { usePlayerControls: () => controls },
    '@/composables/useDeferredSeek': { useDeferredSeek: () => ({}) },
    '@/composables/usePlaybackProgressStatus': { usePlaybackProgressStatus: () => ({}) },
    '@/utils/kugouVerification': { kugouVerificationState: verification },
  }).default;
  const view = scope.run(() => component.setup({}, { emit() {}, expose() {} }));
  view.actionCapacity.value = { left: 20, center: 20, right: 20 };
  return { settings, verification, track, view, controls };
}

test('play mode is a click chooser in every position on both player bars', (t) => {
  for (const surface of ['main', 'lyric']) {
    const f = fixture(t, true, surface);
    for (const placement of ['left', 'center', 'right', 'more']) {
      f.settings.playerBarLayout = {
        placements: { 'play-mode': placement },
        order: [],
        badges: {},
      };
      const groups = f.view.renderedPlayerBarActions.value;
      const chosen = groups[placement === 'more' ? 'overflow' : placement];
      const action = chosen.find((item) => item.key === 'play-mode');
      assert.equal(action.component, 'play-mode');
      assert.equal(action.trigger, 'click');
      action.onClick();
      assert.equal(f.controls.player.playMode, 'sequential');
    }
  }
});

test('lyric barrage joins layout management only when its rendering slot is available', (t) => {
  const managed = fixture(t),
    without = fixture(t, false);
  assert.equal(
    managed.view.resolvedPlayerBarActions.value.find((item) => item.key === 'barrage').component,
    'barrage',
  );
  assert.ok(managed.view.leftPlayerBarActions.value.some((item) => item.key === 'barrage'));
  assert.ok(!without.view.resolvedPlayerBarActions.value.some((item) => item.key === 'barrage'));
  for (const f of [managed, without]) {
    f.view.leftActionsRef.value = { parentElement: { clientWidth: 180 } };
    f.view.updateActionCapacity();
  }
  assert.equal(managed.view.actionCapacity.value.left, 6);
  assert.equal(without.view.actionCapacity.value.left, 5);
});

test('saved lyric barrage placement and order apply to every zone exactly once', (t) => {
  const f = fixture(t);
  for (const zone of ['left', 'center', 'right', 'more']) {
    f.settings.playerBarLayout = {
      placements: { barrage: zone },
      order: ['barrage', 'comments'],
      badges: { queue: false },
    };
    const groups = f.view.renderedPlayerBarActions.value;
    const chosen = groups[zone === 'more' ? 'overflow' : zone];
    assert.equal(chosen[0].key, 'barrage');
    assert.equal(
      Object.values(groups)
        .flat()
        .filter((item) => item.key === 'barrage').length,
      1,
    );
  }
  f.settings.playerBarLayout = actions.emptyPlayerBarLayout();
  assert.ok(f.view.leftPlayerBarActions.value.some((item) => item.key === 'barrage'));
});

test('narrow lyric bar overflows barrage without changing its saved placement', (t) => {
  const f = fixture(t);
  f.settings.playerBarLayout = actions.setPlayerBarActionPlacement(
    f.settings.playerBarLayout,
    'barrage',
    'left',
  );
  f.view.actionCapacity.value = { left: 0, center: 20, right: 20 };
  assert.equal(
    f.view.overflowPlayerBarActions.value.find((item) => item.key === 'barrage').placement,
    'left',
  );
  assert.equal(f.settings.playerBarLayout.placements.barrage, 'left');
});

test('lyric barrage disabled and active states follow track, verification and display settings', (t) => {
  const f = fixture(t),
    get = () => f.view.resolvedPlayerBarActions.value.find((item) => item.key === 'barrage');
  assert.equal(get().disabled, false);
  f.track.value = { hash: '' };
  assert.equal(get().disabled, true);
  f.track.value = { hash: 'B' };
  f.verification.open = true;
  assert.equal(get().disabled, true);
  f.verification.open = false;
  f.settings.lyricBarrageEnabled = true;
  assert.equal(get().disabled, false);
  assert.equal(get().active, true);
  assert.match(get().tooltip, /已开启/);
});

for (const surface of ['main', 'lyric']) {
  test(`favorite placement and saved order apply once in all ${surface} bar zones`, async (t) => {
    const f = fixture(t, true, surface);
    for (const placement of ['left', 'center', 'right', 'more']) {
      f.settings.playerBarLayout = {
        placements: { favorite: placement },
        order: ['favorite', 'comments'],
        badges: {},
      };
      const groups = f.view.renderedPlayerBarActions.value;
      const chosen = groups[placement === 'more' ? 'overflow' : placement];
      assert.equal(chosen[0].key, 'favorite');
      assert.equal(
        Object.values(groups)
          .flat()
          .filter((item) => item.key === 'favorite').length,
        1,
      );
      await chosen[0].onClick();
      const updated = f.view.resolvedPlayerBarActions.value.find((item) => item.key === 'favorite');
      assert.equal(updated.active, f.controls.isFavorite.value);
      assert.equal(updated.icon.body, updated.active ? 'filled-heart' : 'heart');
      assert.equal(updated.tooltip, updated.active ? '取消收藏' : '收藏');
    }
    f.track.value = null;
    const favorite = f.view.resolvedPlayerBarActions.value.find((item) => item.key === 'favorite');
    assert.equal(favorite.disabled, true);
    assert.equal(favorite.placement, 'more');
  });
}
