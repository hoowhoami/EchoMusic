import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the component's actual scheduling code with deterministic rAF timestamps.
const source = readFileSync('src/renderer/views/lyric/AmllMode.vue', 'utf8');
const loopSource = source
  .slice(source.indexOf('const rafLoop ='), source.indexOf('const handleVisibilityChange ='))
  .replace('(timestamp: number)', '(timestamp)');

function harness(highRefreshRate = false) {
  const updates = [];
  const timelineUpdates = [];
  let pending;
  const playerStore = { isPlaying: true, playbackClock: {} };
  const document = { hidden: false };
  const settings = { value: { highRefreshRate } };
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
    FRAME_INTERVAL: 1000 / 60,
    settings,
    nextFrameTime: null,
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
    settings,
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
    const h = harness(true);
    h.start();
    for (let i = 0; i <= hz; i++) h.frame((i * 1000) / hz);
    assert.equal(h.updates.length, hz + 1);
    assert.equal(h.updates[0], 0);
    for (const dt of h.updates.slice(1)) assert.ok(Math.abs(dt - 1000 / hz) < 1e-8);
    assert.ok(h.timelineUpdates.length > 0 && h.timelineUpdates.length <= 30);
  });
}

for (const hz of [60, 120, 144, 165, 240]) {
  test(`default 60fps budget preserves fractional frame time at ${hz} Hz`, () => {
    const h = harness();
    h.start();
    for (let i = 0; i <= hz; i++) h.frame((i * 1000) / hz);
    assert.equal(h.updates.length, 61);
    assert.equal(h.updates[0], 0);
    assert.ok(Math.abs(h.updates.reduce((a, b) => a + b, 0) - 1000) < 1e-8);
    for (const dt of h.updates.slice(1)) assert.ok(dt > 0 && dt <= 1000 / 60 + 1000 / hz + 0.001);
  });
}

test('switching high refresh at runtime changes cadence without restarting playback', () => {
  const h = harness();
  h.start();
  h.frame(0);
  h.frame(7);
  assert.equal(h.updates.length, 1);
  h.settings.value.highRefreshRate = true;
  h.frame(14);
  h.frame(21);
  assert.equal(h.updates.length, 3);
  h.settings.value.highRefreshRate = false;
  h.frame(28);
  h.frame(35);
  h.frame(42);
  assert.equal(h.updates.length, 4);
  h.frame(49);
  assert.equal(h.updates.length, 5);
});

test('legacy settings without the new field retain the default 60fps budget', () => {
  const h = harness();
  delete h.settings.value.highRefreshRate;
  h.start();
  h.frame(0);
  h.frame(7);
  h.frame(14);
  h.frame(21);
  assert.equal(h.updates.length, 2);
});

for (const highRefresh of [false, true]) {
  test(`hidden windows stop and resume without accumulating time (high refresh: ${highRefresh})`, () => {
    const h = harness(highRefresh);
    h.start();
    h.frame(0);
    h.frame(21);
    h.document.hidden = true;
    h.frame(28);
    assert.equal(h.hasPending(), false);
    assert.equal(h.updates.length, 2);
    h.document.hidden = false;
    h.start();
    h.frame(10000);
    assert.equal(h.updates.at(-1), 0);
  });
}

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
