import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(
  new URL('../src/renderer/stores/player/audio.ts', import.meta.url),
  'utf8',
);
const module = { exports: {} };
new Function('require', 'module', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(
  (id) => {
    if (id === './utils') return { normalizeEffect: (value) => value };
    if (id === './stateMachine') return { getPlaybackIsLoading: (state) => state.loading };
    if (id === '../../../shared/playback') return { DEFAULT_PLAYER_VOLUME: 75 };
    throw new Error(id);
  },
  module,
);

test('failed song effect can be retried; an already applied effect does not reload', async () => {
  const state = {
    audioEffect: 'vocal',
    currentResolvedAudioEffect: 'none',
    currentTrackId: '1',
    loading: false,
  };
  let refreshes = 0;
  const manager = module.exports.createAudioManager(state, {}, async () => {
    refreshes++;
  });
  manager.setAudioEffect('vocal');
  assert.equal(refreshes, 1);
  assert.equal(state.currentResolvedAudioEffect, 'none');
  await Promise.resolve();
  state.currentResolvedAudioEffect = 'vocal';
  manager.setAudioEffect('vocal');
  assert.equal(refreshes, 1);
  state.loading = true;
  manager.setAudioEffect('accompaniment');
  assert.equal(state.pendingSettingRefresh, true);
  assert.equal(refreshes, 1);
});

const resolver = readFileSync(
  new URL('../src/renderer/stores/player/resolver.ts', import.meta.url),
  'utf8',
);
const start = resolver.indexOf('    const finalizeResolvedSource =');
const end = resolver.indexOf('    const resolvePluginAt', start);
const finalizeCode = transformSync(resolver.slice(start, end), { loader: 'ts' }).code;
const finalize = new Function(
  'transformAudioSource',
  'audioEffect',
  'track',
  'options',
  `${finalizeCode}; return finalizeResolvedSource;`,
)(async (_track, result) => result, 'vocal', {}, {});
test('ordinary fallback reports an unavailable effect, successful effects and existing notices are retained', async () => {
  assert.equal(
    (await finalize({ effect: 'none', url: 'ordinary' }, 'catalog')).noticeCode,
    'audio-effect-unavailable',
  );
  assert.equal(
    (await finalize({ effect: 'vocal', url: 'effect' }, 'catalog')).noticeCode,
    undefined,
  );
  assert.equal(
    (
      await finalize(
        { effect: 'none', url: 'cloud', noticeCode: 'audio-effect-cloud-fallback' },
        'cloud',
      )
    ).noticeCode,
    'audio-effect-cloud-fallback',
  );
  assert.equal(await finalize(null, 'catalog'), null);
});

test('effect feedback stays inline without setting player or lyric error state', () => {
  const player = readFileSync(new URL('../src/renderer/stores/player.ts', import.meta.url), 'utf8');
  const code = transformSync(
    player.slice(
      player.indexOf('    const showPlaybackNotice ='),
      player.indexOf('    const clearPlaybackNotice ='),
    ),
    { loader: 'ts' },
  ).code;
  const state = { playbackNotice: null };
  const toasts = [];
  const notify = new Function(
    'state',
    'toastStore',
    'useUserStore',
    'settingStore',
    'resolvePlaybackNotice',
    `${code}; return showPlaybackNotice;`,
  )(
    state,
    { warning: (message) => toasts.push(message) },
    () => ({ isLoggedIn: false }),
    {},
    ({ code }) => ({ code, title: '提示', reason: '原因' }),
  );
  for (const code of [
    'audio-effect-unavailable',
    'audio-effect-apply-failed',
    'audio-effect-cloud-fallback',
  ]) {
    notify(code);
    assert.equal(state.playbackNotice, null);
  }
  assert.equal(toasts.length, 0);
  assert.equal(state.audioEffectError, '原因');
  notify('playback-failed');
  assert.equal(state.playbackNotice.code, 'playback-failed');
  notify('audio-effect-unavailable');
  assert.equal(state.playbackNotice.code, 'playback-failed');
});

const playerSource = readFileSync(new URL('../src/renderer/stores/player.ts', import.meta.url), 'utf8');
function refreshHarness(switchSource) {
  const state = {
    currentTrackId: '1', playbackRequestSeq: 0, currentAudioUrl: 'old',
    audioEffect: 'vocal', currentResolvedAudioEffect: 'none', nativeTrackSeq: 10,
    currentTime: 20, duration: 120,
  };
  const code = transformSync(playerSource.slice(
    playerSource.indexOf('    const refreshCurrentTrack ='),
    playerSource.indexOf('    const audioManager ='),
  ), { loader: 'ts' }).code;
  const dependencies = {
    state, getPlaybackIsLoading: () => false, getPlaybackIsPlaying: () => true,
    findTrackById: () => ({}), playlistStore: {},
    resolver: { resolveAudioUrl: async () => ({url: 'new', effect: 'vocal'}), fetchClimaxMarks() {} },
    audioManager: { setVolume() {} },
    engine: { switchSource, applyTrackLoudness() {}, setPlaybackRate() {}, setVolume() {} },
    getResolvedPlaybackSources: () => [{url: 'new'}, {url: 'backup'}],
    clearPlaybackNotice() {}, showPlaybackNotice() {}, logger: { warn() {}, error() {} },
  };
  const refresh = new Function(...Object.keys(dependencies), `${code}; return refreshCurrentTrack;`)(...Object.values(dependencies));
  return { state, refresh };
}
test('seamless switch binds the new native sequence so progress ticks are accepted', async () => {
  const {state, refresh} = refreshHarness(async () => 11);
  await refresh({seamless: true});
  assert.equal(state.nativeTrackSeq, 11);
  assert.equal(state.currentAudioUrl, 'new');
  assert.equal(state.currentTime, 20);
});
test('superseded failed switch does not retry backup sources or overwrite the new track', async () => {
  let rejectSwitch;
  let calls = 0;
  const {state, refresh} = refreshHarness(() => {
    calls++;
    return new Promise((_, reject) => { rejectSwitch = reject; });
  });
  const pending = refresh({seamless: true});
  await Promise.resolve();
  state.playbackRequestSeq++;
  state.nativeTrackSeq = 12;
  rejectSwitch(new Error('cancelled'));
  await pending;
  assert.equal(calls, 1);
  assert.equal(state.nativeTrackSeq, 12);
});
test('repeated clicks while an effect is applying do not start another switch', async () => {
  const state = { audioEffect: 'none', currentResolvedAudioEffect: 'none', currentTrackId: '1' };
  let finish;
  let calls = 0;
  const manager = module.exports.createAudioManager(state, {}, () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  manager.setAudioEffect('vocal');
  manager.setAudioEffect('vocal');
  manager.setAudioEffect('accompaniment');
  assert.equal(calls, 1);
  assert.equal(state.audioEffect, 'vocal');
  assert.equal(state.audioEffectApplying, true);
  finish();
  await Promise.resolve();
  assert.equal(state.audioEffectApplying, false);
  manager.setAudioEffect('vocal');
  assert.equal(calls, 2);
  finish();
});
