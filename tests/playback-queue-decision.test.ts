import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNextTrackDecisionKey,
  canPrepareGaplessTransition,
  findPlaybackSourceQueue,
  hasPlaybackQueueOrderChanged,
  reconcileQueuedNextForQueueReplacement,
  resolveOrderedPlaybackMode,
  resolvePlaybackSourceQueueId,
  resolveQueuedNextTrackDecision,
  resolveQueueAdvanceAuthority,
  resolveNextTrackDecision,
} from '../src/shared/playback-queue-decision.ts';
import {
  LISTEN_TOGETHER_QUEUE_ID,
  PERSONAL_FM_QUEUE_ID,
} from '../src/renderer/stores/playlist/constants.ts';

type Track = { id: string; playable?: boolean };

const tracks: Track[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

const resolve = (options: {
  currentTrackId: string;
  queuedNextTrackIds?: string[];
  mode?: 'list' | 'sequential';
  source?: Track[];
}) =>
  resolveNextTrackDecision({
    tracks: options.source ?? tracks,
    currentTrackId: options.currentTrackId,
    queuedNextTrackIds: options.queuedNextTrackIds,
    mode: options.mode ?? 'list',
    getTrackId: (track) => track.id,
    isPlayable: (track) => track.playable !== false,
  });

test('ordered next-track decisions follow the visible queue and sequential mode stops at the end', () => {
  assert.equal(resolve({ currentTrackId: 'a' })?.targetTrackId, 'b');
  assert.equal(resolve({ currentTrackId: 'd' })?.targetTrackId, 'a');
  assert.equal(resolve({ currentTrackId: 'd', mode: 'sequential' }), null);
});

test('ordered playback recovers from a removed current track at the first playable queue entry', () => {
  const source = [
    { id: 'unavailable', playable: false },
    { id: 'first-playable' },
    { id: 'later' },
  ];

  for (const mode of ['list', 'sequential'] as const) {
    const decision = resolve({ currentTrackId: 'removed', mode, source });
    assert.equal(decision?.reason, 'queue-order');
    assert.equal(decision?.targetTrackId, 'first-playable');
    assert.equal(decision?.targetIndex, 1);
  }
});

test('queued-next decisions skip invalid heads and report every marker to consume atomically', () => {
  const decision = resolve({
    currentTrackId: 'a',
    queuedNextTrackIds: ['missing', 'a', 'c'],
  });

  assert.equal(decision?.reason, 'queued-next');
  assert.equal(decision?.targetTrackId, 'c');
  assert.deepEqual(decision?.queuedNextTrackIdsToConsume, ['missing', 'a', 'c']);
});

test('unplayable queued-next entries fall back to the same physical next track used by normal playback', () => {
  const source = tracks.map((track) => (track.id === 'c' ? { ...track, playable: false } : track));
  const decision = resolve({
    currentTrackId: 'a',
    queuedNextTrackIds: ['c'],
    source,
  });

  assert.equal(decision?.reason, 'queue-order');
  assert.equal(decision?.targetTrackId, 'b');
  assert.deepEqual(decision?.queuedNextTrackIdsToConsume, ['c']);
});

test('queue replacement detects order changes against the previous queue', () => {
  assert.equal(
    hasPlaybackQueueOrderChanged(tracks, tracks.slice(), (track) => track.id),
    false,
  );
  assert.equal(
    hasPlaybackQueueOrderChanged(
      tracks,
      [tracks[0]!, tracks[2]!, tracks[1]!, tracks[3]!],
      (track) => track.id,
    ),
    true,
  );
  assert.equal(
    hasPlaybackQueueOrderChanged(tracks, tracks.slice(0, 3), (track) => track.id),
    true,
  );
});

test('queue replacement clears stale queued-next markers but preserves intentional repositioning and append-only updates', () => {
  const replacement = (nextTracks: Track[], preserveQueuedNext = false) =>
    reconcileQueuedNextForQueueReplacement({
      previousTracks: tracks,
      nextTracks,
      queuedNextTrackIds: ['b', 'c'],
      preserveQueuedNext,
      getTrackId: (track) => track.id,
    });

  assert.deepEqual(
    replacement([tracks[0]!, tracks[2]!, tracks[1]!, tracks[3]!]).queuedNextTrackIds,
    [],
  );
  assert.deepEqual(
    replacement([tracks[0]!, tracks[2]!, tracks[1]!, tracks[3]!], true).queuedNextTrackIds,
    ['b', 'c'],
  );
  assert.deepEqual(replacement([...tracks, { id: 'e' }]).queuedNextTrackIds, ['b', 'c']);
});

test('decision keys are invalidated by queue revisions without changing the selected track', () => {
  const base = {
    queueId: 'album:1',
    currentTrackId: 'a',
    targetTrackId: 'b',
    mode: 'list' as const,
    reason: 'queue-order' as const,
  };

  assert.notEqual(
    buildNextTrackDecisionKey({ ...base, queueRevision: 1 }),
    buildNextTrackDecisionKey({ ...base, queueRevision: 2 }),
  );
});

test('gapless preparation stays under the correct queue authority', () => {
  const authority = (queueId: string) =>
    resolveQueueAdvanceAuthority({
      queueId,
      personalFmQueueId: PERSONAL_FM_QUEUE_ID,
      listenTogetherQueueId: LISTEN_TOGETHER_QUEUE_ID,
    });

  assert.equal(authority('album:1'), 'local');
  assert.equal(authority(PERSONAL_FM_QUEUE_ID), 'dynamic-provider');
  assert.equal(authority(LISTEN_TOGETHER_QUEUE_ID), 'remote-session');
  assert.equal(
    canPrepareGaplessTransition({ authority: authority('album:1'), autoNextSuppressed: false }),
    true,
  );
  assert.equal(
    canPrepareGaplessTransition({ authority: authority('album:1'), autoNextSuppressed: true }),
    false,
  );
  assert.equal(
    canPrepareGaplessTransition({
      authority: authority(PERSONAL_FM_QUEUE_ID),
      autoNextSuppressed: false,
    }),
    false,
  );
  assert.equal(
    canPrepareGaplessTransition({
      authority: authority(LISTEN_TOGETHER_QUEUE_ID),
      autoNextSuppressed: false,
    }),
    false,
  );
});

test('playback decisions bind to the current source queue instead of the active UI queue', () => {
  const queues = [
    {
      id: 'queue:active',
      songs: [{ id: 'a' }, { id: 'wrong' }],
      queuedNextTrackIds: ['wrong'],
    },
    {
      id: 'queue:source',
      songs: [{ id: 'a' }, { id: 'right' }],
      queuedNextTrackIds: ['right'],
    },
  ];

  const sourceQueue = findPlaybackSourceQueue({
    queues,
    currentSourceQueueId: 'queue:source',
    getQueueId: (queue) => queue.id,
  });
  assert.equal(sourceQueue, queues[1]);
  assert.equal(
    resolve({
      currentTrackId: 'a',
      source: sourceQueue?.songs,
      queuedNextTrackIds: sourceQueue?.queuedNextTrackIds,
    })?.targetTrackId,
    'right',
  );
  assert.equal(
    findPlaybackSourceQueue({
      queues,
      currentSourceQueueId: 'queue:missing',
      getQueueId: (queue) => queue.id,
    }),
    null,
  );
  assert.equal(
    resolvePlaybackSourceQueueId({
      currentSourceQueueId: PERSONAL_FM_QUEUE_ID,
      activeQueueId: 'queue:active',
    }),
    PERSONAL_FM_QUEUE_ID,
  );
  assert.equal(
    resolvePlaybackSourceQueueId({ currentSourceQueueId: null, activeQueueId: 'queue:active' }),
    'queue:active',
  );
});

test('cleanup-only decisions remove invalid queued-next markers even without a target', () => {
  const atSequentialEnd = resolve({
    currentTrackId: 'd',
    queuedNextTrackIds: ['missing', 'd'],
    mode: 'sequential',
  });
  assert.equal(atSequentialEnd?.reason, 'cleanup');
  assert.equal(atSequentialEnd?.track, null);
  assert.deepEqual(atSequentialEnd?.queuedNextTrackIdsToConsume, ['missing', 'd']);

  const noPlayableTarget = resolve({
    currentTrackId: 'a',
    queuedNextTrackIds: ['c'],
    source: [
      { id: 'a', playable: false },
      { id: 'b', playable: false },
      { id: 'c', playable: false },
    ],
  });
  assert.equal(noPlayableTarget?.reason, 'cleanup');
  assert.deepEqual(noPlayableTarget?.queuedNextTrackIdsToConsume, ['c']);
});

test('single mode advances only for an explicit next action', () => {
  assert.equal(resolveOrderedPlaybackMode('single', false), null);
  const explicitMode = resolveOrderedPlaybackMode('single', true);
  assert.equal(explicitMode, 'list');
  assert.equal(
    resolveNextTrackDecision({
      tracks,
      currentTrackId: 'a',
      mode: explicitMode!,
      getTrackId: (track) => track.id,
      isPlayable: (track) => track.playable !== false,
    })?.targetTrackId,
    'b',
  );
  assert.equal(resolveOrderedPlaybackMode('random', true), null);
  assert.equal(resolveOrderedPlaybackMode('sequential', false), 'sequential');
});

test('random playback resolves queued-next before choosing a random track', () => {
  const queued = resolveQueuedNextTrackDecision({
    tracks,
    currentTrackId: 'a',
    queuedNextTrackIds: ['missing', 'a', 'c'],
    getTrackId: (track) => track.id,
    isPlayable: (track) => track.playable !== false,
  });
  assert.equal(queued?.reason, 'queued-next');
  assert.equal(queued?.targetTrackId, 'c');
  assert.deepEqual(queued?.queuedNextTrackIdsToConsume, ['missing', 'a', 'c']);

  const cleanup = resolveQueuedNextTrackDecision({
    tracks: tracks.map((track) => (track.id === 'c' ? { ...track, playable: false } : track)),
    currentTrackId: 'a',
    queuedNextTrackIds: ['c'],
    getTrackId: (track) => track.id,
    isPlayable: (track) => track.playable !== false,
  });
  assert.equal(cleanup?.reason, 'cleanup');
  assert.deepEqual(cleanup?.queuedNextTrackIdsToConsume, ['c']);
});
