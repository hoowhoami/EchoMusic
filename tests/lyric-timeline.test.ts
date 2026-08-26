import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLyricTimeline } from '../src/renderer/composables/useLyricTimeline.ts';

test('stale engine progress freezes instead of flashing back to its anchor', (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);

  for (const currentTime of [0, 37, 125]) {
    const timeline = createLyricTimeline();
    const playback = { currentTime, isPlaying: true };
    timeline.sync(playback, true);
    const start = now;
    now = start + 1800;
    const lastFreshPosition = timeline.getPlaybackMs(playback);
    assert.equal(lastFreshPosition, currentTime * 1000 + 1800);

    for (const elapsed of [1801, 2500, 10_000]) {
      now = start + elapsed;
      timeline.sync(playback);
      assert.equal(timeline.getPlaybackMs(playback), lastFreshPosition);
    }
  }
});

test('fresh samples extend the deadline even when drift does not move the anchor', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timeline = createLyricTimeline();
  const playback = { currentTime: 10, isPlaying: true };
  timeline.sync(playback, true);
  now = 1500;
  playback.currentTime = 11.5;
  timeline.sync(playback);
  now = 3300;
  assert.equal(timeline.getPlaybackMs(playback), 13_300);
  now = 5000;
  assert.equal(timeline.getPlaybackMs(playback), 13_300);
});

test('stale interpolation honors playback rate and still permits an explicit seek', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timeline = createLyricTimeline();
  const playback = { currentTime: 20, isPlaying: true, playbackRate: 2 };
  timeline.sync(playback, true);
  now = 10_000;
  assert.equal(timeline.getPlaybackMs(playback), 23_600);

  playback.currentTime = 5;
  timeline.sync(playback, true);
  assert.equal(timeline.getPlaybackMs(playback), 5000);
  playback.isPlaying = false;
  timeline.sync(playback);
  now += 5000;
  assert.equal(timeline.getPlaybackMs(playback), 5000);
});
