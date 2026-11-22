import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const playbackSource = readFileSync(
  new URL('../src/renderer/stores/player/playback.ts', import.meta.url),
  'utf8',
);
const storeSource = readFileSync(
  new URL('../src/renderer/stores/player.ts', import.meta.url),
  'utf8',
);
const toggleStart = playbackSource.indexOf('  const togglePlay = async () => {');
const toggleEnd = playbackSource.indexOf('  const seek =', toggleStart);
assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
const toggleCode = transformSync(playbackSource.slice(toggleStart, toggleEnd), {
  loader: 'ts',
}).code;
const endedStart = storeSource.indexOf('        ended: (payload) => {');
const endedEnd = storeSource.indexOf('        play: (payload)', endedStart);
assert.ok(endedStart >= 0 && endedEnd > endedStart);
const endedCode = transformSync(`const handlers = {${storeSource.slice(endedStart, endedEnd)}};`, {
  loader: 'ts',
}).code;

function setup() {
  const calls = [];
  const state = {
    currentTrackId: 'finished-song',
    playbackEnded: false,
    isResuming: false,
    playbackRequestSeq: 7,
    playing: false,
  };
  const list = [{ id: 'finished-song' }, { id: 'next-song' }];
  const deps = {
    state,
    PERSONAL_FM_QUEUE_ID: 'queue:personal-fm',
    isCurrentNativePlaybackContext: () => true,
    engine: {
      source: 'existing-source',
      play: async () => calls.push('resume'),
      pause: async () => calls.push('pause'),
      updateMediaPlaybackState: () => {},
    },
    playlistStore: { activeQueue: { id: 'other-queue', songs: [{ id: 'unrelated' }] } },
    settingStore: { syncPreventSleep: () => {} },
    getPlaybackIsPlaying: () => state.playing,
    setPlaybackIntentPlayback: (_state, playing) => {
      state.playing = playing;
    },
    setEnginePlaybackStatus: (_state, status) => {
      state.status = status;
    },
    getPlaybackSourceContext: () => ({ sourceQueueId: 'original-queue', list }),
    playTrack: async (...args) => calls.push(['reload', ...args]),
    buildMediaState: () => ({}),
    sleepTimer: {
      trackEnded: () => {
        state.playing = false;
        state.status = 'paused';
        return true;
      },
    },
    emitPlayerEvent: (event) => calls.push(event),
    handlePlaybackEnded: () => calls.push('auto-next'),
    // showResumeCard 是在 togglePlay 之前的闭包（依赖 resumeHintState / router /
    // maybeShowResumeHint），不在本测试切片的源码区间内，因此以空桩注入：它只负责弹续播卡，
    // 不参与睡眠定时器的暂停 / 重播决策，也不应写入 calls。
    showResumeCard: () => {},
  };
  const toggle = new Function(...Object.keys(deps), `${toggleCode}; return togglePlay;`)(
    ...Object.values(deps),
  );
  const ended = new Function(...Object.keys(deps), `${endedCode}; return handlers.ended;`)(
    ...Object.values(deps),
  );
  return { state, calls, list, toggle, ended };
}

test('timer EOF stops automatic advance and next play reloads the original song and queue', async () => {
  const t = setup();
  t.ended();
  assert.equal(t.state.playbackEnded, true);
  assert.deepEqual(t.calls, ['ended']);
  await t.toggle();
  assert.deepEqual(t.calls[1], [
    'reload',
    'finished-song',
    t.list,
    { sourceQueueId: 'original-queue' },
  ]);
  assert.equal(t.calls.includes('resume'), false);
});

test('timer pause before EOF resumes the existing source without restarting the song', async () => {
  const t = setup();
  await t.toggle();
  assert.deepEqual(t.calls, ['resume']);
  assert.equal(t.state.isResuming, false);
});

test('stale EOF during a new source load does not mark the new song exhausted', async () => {
  const t = setup();
  t.state.awaitingTrackLoad = true;
  t.ended();
  assert.equal(t.state.playbackEnded, false);
  assert.deepEqual(t.calls, []);
});

test('ignored seek EOF does not force replay from the beginning', () => {
  const t = setup();
  t.state.recentSeekIgnoreEnd = true;
  t.ended();
  assert.equal(t.state.playbackEnded, false);
  assert.equal(t.state.recentSeekIgnoreEnd, false);
});
