import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { nextTick, reactive, watch } from 'vue';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (source) => transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const audio = { exports: {} };
new Function('require', 'module', compile(read('../src/renderer/stores/player/audio.ts')))((id) => {
  if (id === './utils') return { normalizeQuality: (value) => value };
  if (id === './stateMachine') return { getPlaybackIsLoading: (state) => state.loading };
  if (id === '../../../shared/playback') return { DEFAULT_PLAYER_VOLUME: 75 };
  if (id === '../playlist/constants') return { PERSONAL_FM_QUEUE_ID: 'fm' };
  throw new Error(id);
}, audio);
const playerSource = read('../src/renderer/stores/player.ts');
const policyStart = playerSource.indexOf('        if (shouldRefresh) {');
const policyEnd = playerSource.indexOf('        if (shouldUpdateFade', policyStart);
const syncSettings = new Function(
  'state',
  'settingStore',
  'compatibilityChanged',
  'refreshCurrentTrack',
  'getPlaybackIsLoading',
  'shouldRefresh',
  compile(playerSource.slice(policyStart, policyEnd)),
);
function setup() {
  const settings = defineStore('test-quality', {
    state: () => ({ defaultAudioQuality: '128', compatibilityMode: true }),
  })(createPinia());
  const state = reactive({
    currentTrackId: 'a',
    currentResolvedAudioQuality: '128',
    currentResolvedSourceKind: 'catalog',
    currentAudioQualityOverride: null,
    audioSourceRefreshRequestSeq: null,
    audioSourceRefreshQuality: null,
    playbackRequestSeq: 1,
    pendingSettingRefresh: false,
    loading: false,
  });
  const calls = [];
  const refresh = async (options) => {
    calls.push(options);
    state.audioSourceRefreshRequestSeq = ++state.playbackRequestSeq;
    state.audioSourceRefreshQuality =
      state.currentAudioQualityOverride ?? settings.defaultAudioQuality;
  };
  let previousQuality = settings.defaultAudioQuality;
  let previousCompatibility = settings.compatibilityMode;
  settings.$subscribe(() => {
    const compatibilityChanged = previousCompatibility !== settings.compatibilityMode;
    const shouldRefresh =
      compatibilityChanged ||
      (state.currentAudioQualityOverride === null &&
        previousQuality !== settings.defaultAudioQuality);
    previousQuality = settings.defaultAudioQuality;
    previousCompatibility = settings.compatibilityMode;
    syncSettings(
      state,
      settings,
      compatibilityChanged,
      refresh,
      (value) => value.loading,
      shouldRefresh,
    );
  });
  const manager = audio.exports.createAudioManager(state, {}, refresh, settings);
  return { state, settings, manager, calls, refresh };
}

test('player quality selection persists and the settings subscription does not switch twice', async () => {
  const e = setup();
  e.manager.setPreferredAudioQuality('flac');
  await nextTick();
  assert.equal(e.settings.$state.defaultAudioQuality, 'flac');
  assert.equal(e.state.currentAudioQualityOverride, null);
  assert.equal(e.state.currentCatalogSourceOverrideTrackId, 'a');
  assert.deepEqual(e.calls, [{ seamless: true }]);
  assert.equal(e.state.pendingSettingRefresh, false);
  e.state.currentTrackId = 'b';
  e.state.currentCatalogSourceOverrideTrackId = null;
  assert.equal(e.settings.defaultAudioQuality, 'flac');
  e.settings.$dispose();
});

test('settings-page quality changes use the same seamless refresh and queue newer choices', async () => {
  const e = setup();
  e.settings.defaultAudioQuality = 'high';
  await nextTick();
  assert.deepEqual(e.calls, [{ seamless: true }]);
  e.settings.defaultAudioQuality = '320';
  await nextTick();
  assert.equal(e.calls.length, 1);
  assert.equal(e.state.pendingSettingRefresh, true);
  e.settings.$dispose();
});

test('compatibility changes are not swallowed by an in-flight refresh of the same quality', async () => {
  const e = setup();
  e.manager.setPreferredAudioQuality('flac');
  await nextTick();
  e.settings.compatibilityMode = false;
  await nextTick();
  assert.equal(e.state.pendingSettingRefresh, true);
  e.settings.$dispose();
});

test('cloud selection keeps the saved quality preference for subsequent catalog songs', async () => {
  const e = setup();
  e.state.currentResolvedSourceKind = 'cloud';
  e.state.currentCloudSourceOverrideTrackId = 'a';
  e.manager.setPreferredAudioQuality('flac');
  await nextTick();
  assert.equal(e.state.currentCloudSourceOverrideTrackId, null);
  assert.equal(e.state.currentCatalogSourceOverrideTrackId, 'a');
  e.state.audioSourceRefreshRequestSeq = null;
  e.manager.preferCurrentTrackCloudSource();
  assert.equal(e.state.currentCloudSourceOverrideTrackId, 'a');
  assert.equal(e.settings.defaultAudioQuality, 'flac');
  e.settings.$dispose();
});

test('a failed preferred quality can be retried without changing the preference again', async () => {
  const e = setup();
  e.manager.setPreferredAudioQuality('flac');
  await nextTick();
  e.manager.setPreferredAudioQuality('320');
  assert.equal(e.settings.defaultAudioQuality, 'flac', 'controls remain locked during a switch');
  e.state.audioSourceRefreshRequestSeq = null;
  e.manager.setPreferredAudioQuality('flac');
  assert.equal(e.calls.length, 2);
  e.settings.$dispose();
});

const resolverSource = read('../src/renderer/stores/player/resolver.ts');
const resolverStart = resolverSource.indexOf('  const getEffectiveAudioQuality =');
const resolverEnd = resolverSource.indexOf('  const transformAudioSource =', resolverStart);
const qualityResolvers = new Function(
  'state',
  'settingStore',
  'normalizeQuality',
  'normalizeEffect',
  'resolveEffectiveSongQuality',
  `${compile(resolverSource.slice(resolverStart, resolverEnd))}; return { getEffectiveAudioQuality, createPluginAudioSourceContext, getResolvedAudioQuality };`,
);
test('explicit per-track overrides do not leak into next-track or plugin source requests', () => {
  const state = { currentTrackId: 'a', currentAudioQualityOverride: '320', audioEffect: 'none' };
  const settings = { defaultAudioQuality: 'high', compatibilityMode: true };
  const resolver = qualityResolvers(
    state,
    settings,
    (value) => value,
    (value) => value,
    (_track, quality) => quality,
  );
  assert.equal(resolver.getEffectiveAudioQuality(), '320');
  assert.equal(resolver.getEffectiveAudioQuality({ id: 'a' }), '320');
  assert.equal(resolver.getEffectiveAudioQuality({ id: 'b' }), 'high');
  assert.equal(resolver.createPluginAudioSourceContext({ id: 'b' }).quality, 'high');
  assert.equal(resolver.getResolvedAudioQuality({ id: 'b' }), 'high');
  state.currentTrackId = 'b';
  state.currentAudioQualityOverride = null;
  assert.equal(resolver.getEffectiveAudioQuality({ id: 'c' }), 'high');
});

test('a quality preference changed during loading is applied once after loading and seek settle', async () => {
  const e = setup();
  e.state.loading = true;
  e.state.nativeSeekActive = true;
  const start = playerSource.indexOf('      const unsubscribePendingSourceRefresh =');
  const end = playerSource.indexOf('      // 保存取消函数', start);
  const stop = new Function(
    'watch',
    'state',
    'getPlaybackIsLoading',
    'getPlaybackHasFailed',
    'refreshCurrentTrack',
    `${compile(playerSource.slice(start, end))}; return unsubscribePendingSourceRefresh;`,
  )(
    watch,
    e.state,
    (value) => value.loading,
    () => false,
    e.refresh,
  );
  e.manager.setPreferredAudioQuality('flac');
  await nextTick();
  assert.equal(e.calls.length, 0);
  assert.equal(e.state.pendingSettingRefresh, true);
  e.state.loading = false;
  await nextTick();
  assert.equal(e.calls.length, 0);
  e.state.nativeSeekActive = false;
  await nextTick();
  assert.deepEqual(e.calls, [{ seamless: true }]);
  assert.equal(e.state.pendingSettingRefresh, false);
  stop();
  e.settings.$dispose();
});
