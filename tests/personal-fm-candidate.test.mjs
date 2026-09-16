import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants, createFmStore, queuePolicy } from './helpers/personal-fm.mjs';

test('FM peek is read-only, commit consumes and persists exactly once', () => {
  const { store, requests, persisted } = createFmStore();
  const before = JSON.stringify(store);
  const candidate = store.peekNextPersonalFmCandidate('a', '1:1:a');
  assert.equal(candidate.track.id, 'b');
  assert.deepEqual(store.peekNextPersonalFmCandidate('a', '1:1:a'), candidate);
  assert.equal(JSON.stringify(store), before);
  assert.equal(requests.length, 0);
  assert.equal(persisted.length, 0);
  assert.deepEqual(
    store.commitPersonalFmCandidate(candidate).map((s) => s.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    store.personalFmBuffer.map((s) => s.id),
    ['c'],
  );
  assert.equal(store.commitPersonalFmCandidate(candidate), null);
  assert.deepEqual(
    persisted.map((s) => s.id),
    ['b'],
  );
});

test('FM forward history precedes buffer and does not wrap', () => {
  const { store, persisted } = createFmStore();
  store.activeQueue.songs.push({ id: 'history', hash: 'history' });
  const candidate = store.peekNextPersonalFmCandidate('a', 'history-1');
  assert.equal(candidate.origin, 'history');
  store.commitPersonalFmCandidate(candidate);
  assert.deepEqual(
    store.personalFmBuffer.map((s) => s.id),
    ['b', 'c'],
  );
  assert.equal(persisted.length, 0);
  assert.equal(store.peekNextPersonalFmCandidate('history', 'history-2').track.id, 'b');
});

test('append-only replenishment retains candidate; reset invalidates it', async () => {
  const { store } = createFmStore({ fetch: async () => [{ id: 'd' }] });
  const candidate = store.peekNextPersonalFmCandidate('a', '1');
  await store.replenishPersonalFmBuffer();
  assert.deepEqual(store.peekNextPersonalFmCandidate('a', '1'), candidate);
  store.updatePersonalFmMode('small');
  assert.equal(store.commitPersonalFmCandidate(candidate), null);
  assert.deepEqual(
    store.personalFmBuffer.map((s) => s.id),
    ['b', 'c', 'd'],
  );
});

test('replenishment deduplicates requests, adds no playback feedback, and discards late sessions', async () => {
  let finish;
  const { store, requests } = createFmStore({
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = store.replenishPersonalFmBuffer();
  const second = store.replenishPersonalFmBuffer();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { mode: 'normal', song_pool_id: 0 });
  store.personalFmSessionEpoch++;
  store.personalFmBuffer = [{ id: 'new' }];
  finish([{ id: 'old' }]);
  await Promise.all([first, second]);
  assert.deepEqual(
    store.personalFmBuffer.map((s) => s.id),
    ['new'],
  );
});

test('feedback is occurrence-scoped and late feedback cannot replace a new pool', async () => {
  let finish;
  const { store, requests } = createFmStore({
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const options = {
    track: { id: '42', hash: 'hash42' },
    playtime: 12.9,
    action: 'garbage',
    isOverplay: false,
  };
  const pending = store.reportPersonalFmAdvance('1:1:42', options);
  await store.reportPersonalFmAdvance('1:1:42', { ...options, action: 'play' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playtime, 12);
  assert.equal(requests[0].action, 'garbage');
  assert.equal(requests[0].is_overplay, 0);
  store.updatePersonalFmSongPool(2);
  finish([{ id: 'old' }]);
  await pending;
  assert.deepEqual(
    store.personalFmBuffer.map((s) => s.id),
    ['b', 'c'],
  );
});

test('stalled FM request times out and repeated preparation ticks cannot busy-loop', async () => {
  const callbacks = new Map();
  let id = 0;
  const timers = {
    setTimeout: (callback, ms) => {
      assert.equal(ms, 10000);
      callbacks.set(++id, callback);
      return id;
    },
    clearTimeout: (id) => callbacks.delete(id),
  };
  const { store, requests } = createFmStore({ fetch: () => new Promise(() => {}), timers });
  const pending = store.replenishPersonalFmBuffer();
  callbacks.values().next().value();
  assert.equal(await pending, 0);
  for (let i = 0; i < 100; i++) await store.replenishPersonalFmBuffer();
  assert.equal(requests.length, 1);
  assert.equal(callbacks.size, 0);
});

test('confirmed failed candidates leave the buffer without history or garbage feedback', () => {
  const { store, requests, persisted } = createFmStore();
  const candidate = store.peekNextPersonalFmCandidate('a', '1');
  store.skipFailedPersonalFmCandidate(candidate);
  assert.equal(store.peekNextPersonalFmCandidate('b', '2').track.id, 'c');
  assert.equal(store.commitPersonalFmCandidate(candidate), null);
  assert.equal(persisted.length, 0);
  assert.equal(requests.length, 0);
  assert.deepEqual(
    store.activeQueue.songs.map((s) => s.id),
    ['a'],
  );
});

test('FM capability is explicit; listen-together and suppressed queues remain excluded', () => {
  assert.equal(
    queuePolicy.getQueueAdvanceAuthority(constants.PERSONAL_FM_QUEUE_ID),
    'dynamic-provider',
  );
  assert.equal(queuePolicy.canPrepareGaplessForQueue(constants.PERSONAL_FM_QUEUE_ID, false), true);
  assert.equal(queuePolicy.canPrepareGaplessForQueue(constants.PERSONAL_FM_QUEUE_ID, true), false);
  assert.equal(
    queuePolicy.canPrepareGaplessForQueue(constants.LISTEN_TOGETHER_QUEUE_ID, false),
    false,
  );
  assert.equal(queuePolicy.canPrepareGaplessForQueue('queue:local', false), true);
});

test('unplayable recommendations do not prevent low-watermark replenishment', async () => {
  const { store, requests } = createFmStore({
    buffer: Array.from({ length: 6 }, (_, index) => ({ id: `unavailable-${index}` })),
    fetch: async () => [{ id: 'new', hash: 'new' }],
  });
  assert.equal(store.peekNextPersonalFmCandidate('a', '1'), null);
  await store.replenishPersonalFmBuffer();
  assert.equal(requests.length, 1);
  assert.equal(store.peekNextPersonalFmCandidate('a', '1').track.id, 'new');
});
