import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldShowPlaybackBuffering } from '../src/renderer/stores/player/progressStatus.ts';

const bufferingState = {
  core: { state: 'buffering', trackSeq: 7, generation: 3, updatedAt: 100, revision: 10 },
  ao: {
    paused: true,
    bufferingState: 42,
    trackSeq: 7,
    generation: 3,
    updatedAt: 101,
    revision: 11,
  },
  isPlaying: true,
  nativePlaybackProgressRevision: 0,
};

test('native output progress supersedes stale buffering diagnostics', () => {
  assert.equal(shouldShowPlaybackBuffering(bufferingState), true);
  assert.equal(
    shouldShowPlaybackBuffering({ ...bufferingState, nativePlaybackProgressRevision: 12 }),
    false,
  );
});

test('a newer buffering episode is not hidden by older native progress', () => {
  assert.equal(
    shouldShowPlaybackBuffering({
      ...bufferingState,
      core: { ...bufferingState.core, updatedAt: 103, revision: 13 },
      nativePlaybackProgressRevision: 12,
    }),
    true,
  );
});

test('paused playback and mismatched playback contexts do not show buffering', () => {
  assert.equal(shouldShowPlaybackBuffering({ ...bufferingState, isPlaying: false }), false);
  assert.equal(
    shouldShowPlaybackBuffering({
      ...bufferingState,
      ao: { ...bufferingState.ao, generation: 4 },
    }),
    false,
  );
});
