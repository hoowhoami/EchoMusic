import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the component's actual scheduling code with deterministic rAF timestamps.
const source = readFileSync('src/renderer/views/lyric/AmllMode.vue', 'utf8');
const loopSource = source
  .slice(source.indexOf('const rafLoop ='), source.indexOf('const handleVisibilityChange ='))
  .replace('(timestamp: number)', '(timestamp)');

function harness() {
  const updates = [];
  const timelineUpdates = [];
  let pending;
  const playerStore = { isPlaying: true, playbackClock: {} };
  const document = { hidden: false };
  let now = 0;
  const context = {
    document,
    playerStore,
    playerRef: {
      value: { update: (dt) => updates.push(dt), setCurrentTime: (t) => timelineUpdates.push(t) },
    },
    timeline: { getTimelineMs: () => now },
    lyricStore: { currentTimeOffset: 0 },
    performance: { now: () => now },
    requestAnimationFrame: (callback) => {
      pending = callback;
      return 1;
    },
    SET_TIME_INTERVAL: 1000 / 30,
    rafId: null,
    lastFrameTime: null,
    lastSetTimeAt: 0,
    settleUntil: 0,
    lastAppliedTimeMs: NaN,
    openingLayoutPending: false,
  };
  const start = runInNewContext(`${loopSource}\nrequestFrame;`, context);
  return {
    updates,
    timelineUpdates,
    playerStore,
    document,
    start,
    frame(timestamp) {
      now = timestamp;
      const callback = pending;
      pending = undefined;
      callback?.(timestamp);
    },
    hasPending: () => pending !== undefined,
  };
}

for (const hz of [60, 120, 144, 165, 240]) {
  test(`animation updates on every rAF callback at ${hz} Hz while timeline stays throttled`, () => {
    const h = harness();
    h.start();
    for (let i = 0; i <= hz; i++) h.frame((i * 1000) / hz);
    assert.equal(h.updates.length, hz + 1);
    assert.equal(h.updates[0], 0);
    for (const dt of h.updates.slice(1)) assert.ok(Math.abs(dt - 1000 / hz) < 1e-8);
    assert.ok(h.timelineUpdates.length > 0 && h.timelineUpdates.length <= 30);
  });
}

test('hidden windows stop scheduling and resume without accumulating hidden time', () => {
  const h = harness();
  h.start();
  h.frame(0);
  h.frame(7);
  h.document.hidden = true;
  h.frame(14);
  assert.equal(h.hasPending(), false);
  assert.equal(h.updates.length, 2);
  h.document.hidden = false;
  h.start();
  h.frame(10000);
  assert.equal(h.updates.at(-1), 0);
});

test('long frames clamp animation delta and paused playback stops after settling', () => {
  const h = harness();
  h.start();
  h.frame(0);
  h.frame(100);
  assert.equal(h.updates.at(-1), 50);
  h.playerStore.isPlaying = false;
  h.frame(1001);
  assert.equal(h.hasPending(), false);
  h.start();
  h.frame(1010);
  assert.equal(h.updates.at(-1), 0);
});
