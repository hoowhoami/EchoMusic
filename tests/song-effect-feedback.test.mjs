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
    if (id === './utils')
      return { normalizeEffect: (value) => value, normalizeQuality: (value) => value };
    if (id === './stateMachine') return { getPlaybackIsLoading: (state) => state.loading };
    if (id === '../../../shared/playback') return { DEFAULT_PLAYER_VOLUME: 75 };
    if (id === '../playlist/constants') return { PERSONAL_FM_QUEUE_ID: 'fm' };
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

const playerSource = readFileSync(
  new URL('../src/renderer/stores/player.ts', import.meta.url),
  'utf8',
);
function refreshHarness(
  switchSource,
  resolveAudioUrl = async () => ({ url: 'new', effect: 'vocal' }),
) {
  const state = {
    currentTrackId: '1',
    playbackRequestSeq: 0,
    currentAudioUrl: 'old',
    audioEffect: 'vocal',
    currentResolvedAudioEffect: 'none',
    currentAudioQualityOverride: null,
    currentResolvedAudioQuality: '128',
    nativeTrackSeq: 10,
    currentTime: 20,
    duration: 120,
  };
  const code = transformSync(
    playerSource.slice(
      playerSource.indexOf('    const refreshCurrentTrack ='),
      playerSource.indexOf('    const audioManager ='),
    ),
    { loader: 'ts' },
  ).code;
  const preloads = [];
  const settings = { defaultAudioQuality: '128' };
  const dependencies = {
    state,
    getPlaybackIsLoading: () => false,
    getPlaybackIsPlaying: () => true,
    findTrackById: (id) => ({ id }),
    playlistStore: {},
    resolver: { resolveAudioUrl, fetchClimaxMarks() {} },
    settingStore: settings,
    playbackManager: {
      clearGaplessPreparedSource() {},
      prepareGaplessNext() {
        preloads.push(settings.defaultAudioQuality);
      },
    },
    audioManager: { setVolume() {} },
    engine: { switchSource, applyTrackLoudness() {}, setPlaybackRate() {}, setVolume() {} },
    getResolvedPlaybackSources: () => [{ url: 'new' }, { url: 'backup' }],
    clearPlaybackNotice() {},
    showPlaybackNotice() {},
    logger: { info() {}, warn() {}, error() {} },
  };
  const refresh = new Function(
    ...Object.keys(dependencies),
    `${code}; return refreshCurrentTrack;`,
  )(...Object.values(dependencies));
  return { state, refresh, settings, preloads };
}
test('seamless switch binds the new native sequence so progress ticks are accepted', async () => {
  const { state, refresh } = refreshHarness(async () => 11);
  await refresh({ seamless: true });
  assert.equal(state.nativeTrackSeq, 11);
  assert.equal(state.currentAudioUrl, 'new');
  assert.equal(state.currentTime, 20);
});
test('superseded failed switch does not retry backup sources or overwrite the new track', async () => {
  let rejectSwitch;
  let calls = 0;
  const { state, refresh } = refreshHarness(() => {
    calls++;
    return new Promise((_, reject) => {
      rejectSwitch = reject;
    });
  });
  const pending = refresh({ seamless: true });
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
    return new Promise((resolve) => {
      finish = resolve;
    });
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

test('automatic track change during URL resolution cancels the old quality refresh', async () => {
  let resolve;
  let calls = 0;
  const { state, refresh } = refreshHarness(
    async () => {
      calls++;
      return 10;
    },
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = refresh({ seamless: true });
  state.currentTrackId = '2';
  state.currentAudioUrl = 'next-song';
  resolve({ url: 'old-song-high-quality' });
  await pending;
  assert.equal(calls, 0);
  assert.equal(state.currentAudioUrl, 'next-song');
  assert.equal(state.audioSourceRefreshRequestSeq, null);
});

test('transport cancellation does not retry another quality URL', async () => {
  for (const message of [
    'source switch cancelled: track changed',
    'source switch cancelled: insufficient prepared audio at hand-off; old source kept',
    'source switch preparation timed out',
    'Source switch was superseded',
  ]) {
    let calls = 0;
    const { state, refresh } = refreshHarness(async () => {
      calls++;
      throw new Error(message);
    });
    await refresh({ seamless: true });
    assert.equal(calls, 1);
    assert.equal(state.currentAudioUrl, 'old');
    assert.equal(state.audioSourceRefreshRequestSeq, null);
  }
});

test('a failed audio source still tries its backup URL', async () => {
  let calls = 0;
  const { state, refresh } = refreshHarness(async () => {
    if (++calls === 1) throw new Error('failed to decode audio source');
    return 10;
  });
  await refresh({ seamless: true });
  assert.equal(calls, 2);
  assert.equal(state.currentAudioUrl, 'backup');
});

test('quality refresh reports loading immediately and a stale completion cannot clear the latest indicator', async () => {
  const pending = [];
  const { state, refresh } = refreshHarness(
    async () => 10,
    (_track, options) => {
      assert.equal(options.forceReload, true);
      assert.equal(options.reuseRelateGoods, true);
      return new Promise((resolve) => pending.push(resolve));
    },
  );
  const old = refresh({ seamless: true });
  assert.equal(state.audioSourceRefreshRequestSeq, 1);
  const current = refresh({ seamless: true });
  pending[0]({ url: 'vpt', quality: 'viper_tape' });
  await old;
  assert.equal(state.audioSourceRefreshRequestSeq, 2);
  pending[1]({ url: '' });
  await current;
  assert.equal(state.audioSourceRefreshRequestSeq, null);
  assert.equal(state.currentAudioUrl, 'old');
});

test('quality refresh waits for a user seek before resolving another source', async () => {
  let resolutions = 0;
  const { state, refresh } = refreshHarness(
    async () => 10,
    async () => {
      resolutions++;
      return { url: 'new', quality: '320' };
    },
  );
  state.nativeSeekActive = true;
  state.seekTargetTime = 45;
  await refresh({ seamless: true });
  assert.equal(resolutions, 0);
  assert.equal(state.pendingSettingRefresh, true);
  state.nativeSeekActive = false;
  await refresh({ seamless: true });
  assert.equal(resolutions, 0);
  state.seekTargetTime = null;
  await refresh({ seamless: true });
  assert.equal(resolutions, 1);
  assert.equal(state.pendingSettingRefresh, false);
});

test('quality URL failures release the loading indicator and keep the audible source', async () => {
  const { state, refresh } = refreshHarness(
    async () => 10,
    async () => {
      throw new Error('offline');
    },
  );
  await refresh({ seamless: true });
  assert.equal(state.audioSourceRefreshRequestSeq, null);
  assert.equal(state.currentAudioUrl, 'old');
  assert.equal(state.nativeTrackSeq, 10);
});

test('quality selection stays locked until completion and a failed selection can be retried', () => {
  const state = {
    currentTrackId: '1',
    currentAudioQualityOverride: null,
    currentResolvedAudioQuality: '128',
    audioSourceRefreshRequestSeq: null,
    playbackRequestSeq: 1,
  };
  let calls = 0;
  const manager = module.exports.createAudioManager(state, {}, async () => {
    calls++;
    state.audioSourceRefreshRequestSeq = ++state.playbackRequestSeq;
  });
  manager.setCurrentAudioQualityOverride('viper_tape');
  manager.setCurrentAudioQualityOverride('viper_tape');
  assert.equal(calls, 1);
  manager.setCurrentAudioQualityOverride('128');
  manager.preferCurrentTrackCatalogQuality('320');
  manager.preferCurrentTrackCloudSource();
  manager.setAudioEffect('vocal');
  assert.equal(calls, 1);
  assert.equal(state.currentAudioQualityOverride, 'viper_tape');
  assert.equal(state.currentCloudSourceOverrideTrackId, undefined);
  assert.equal(state.currentCatalogSourceOverrideTrackId, undefined);
  assert.equal(state.audioEffect, undefined);
  manager.setCurrentAudioQualityOverride('viper_tape');
  assert.equal(calls, 1);
  state.audioSourceRefreshRequestSeq = null;
  manager.setCurrentAudioQualityOverride('viper_tape');
  assert.equal(calls, 2);
  state.audioSourceRefreshRequestSeq = null;
  manager.setCurrentAudioQualityOverride('128');
  assert.equal(calls, 3);
  assert.equal(state.currentAudioQualityOverride, '128');
});

test('a queued old-quality B boundary receives the persistent preference without restarting the song', async () => {
  const resolutions = [];
  const switches = [];
  const e = refreshHarness(
    async (source) => {
      switches.push(source);
      return 12;
    },
    (track) => new Promise((resolve) => resolutions.push({ id: track.id, resolve })),
  );
  e.settings.defaultAudioQuality = 'high';
  const old = e.refresh({ seamless: true });
  e.state.currentTrackId = '2';
  e.state.currentTime = 3.2;
  e.state.currentResolvedAudioQuality = '320';
  resolutions[0].resolve({ url: 'old-song-high', quality: 'high' });
  await old;
  assert.deepEqual(
    resolutions.map((item) => item.id),
    ['1', '2'],
  );
  assert.equal(switches.length, 0);
  assert.equal(e.preloads.length, 0);
  resolutions[1].resolve({ url: 'new-song-high', quality: 'high' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(switches.length, 1);
  assert.equal(e.state.currentTime, 3.2);
  assert.equal(e.state.currentResolvedAudioQuality, 'high');
  assert.equal(e.state.audioSourceRefreshRequestSeq, null);
  assert.deepEqual(e.preloads, ['high']);
});

test('a newer queued preference is applied even if the first source resolution fails', async () => {
  const resolutions = [];
  const e = refreshHarness(
    async () => 10,
    () => new Promise((resolve, reject) => resolutions.push({ resolve, reject })),
  );
  e.settings.defaultAudioQuality = 'high';
  const old = e.refresh({ seamless: true });
  e.settings.defaultAudioQuality = 'flac';
  e.state.pendingSettingRefresh = true;
  resolutions[0].reject(new Error('first resolution failed'));
  await old;
  assert.equal(resolutions.length, 2);
  assert.equal(e.state.audioSourceRefreshQuality, 'flac');
  assert.deepEqual(e.preloads, []);
  resolutions[1].resolve({ url: 'flac', quality: 'flac' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(e.state.currentResolvedAudioQuality, 'flac');
  assert.equal(e.state.audioSourceRefreshQuality, null);
  assert.deepEqual(e.preloads, ['flac']);
});

test('an old track refresh cannot lock the new track quality controls', () => {
  const state = {
    currentTrackId: '2',
    currentAudioQualityOverride: null,
    currentResolvedAudioQuality: '128',
    audioSourceRefreshRequestSeq: 1,
    playbackRequestSeq: 2,
  };
  let calls = 0;
  const manager = module.exports.createAudioManager(state, {}, async () => {
    calls++;
  });
  manager.setCurrentAudioQualityOverride('320');
  assert.equal(calls, 1);
  assert.equal(state.currentAudioQualityOverride, '320');
});
