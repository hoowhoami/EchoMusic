import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumePlayedQueuedNextTrack } from '../src/shared/playback-queue-execution.ts';

test('playing from a non-active source queue consumes only that queue marker', () => {
  const activeQueueId = 'queue:active';
  const sourceQueueId = 'queue:source';
  const queuedNextByQueue = new Map([
    [activeQueueId, ['next']],
    [sourceQueueId, ['next']],
  ]);
  const syncedQueueIds: string[] = [];

  consumePlayedQueuedNextTrack(
    {
      consumeQueuedNextTrackId(trackId, queueId = activeQueueId) {
        const queuedIds = queuedNextByQueue.get(String(queueId)) ?? [];
        queuedNextByQueue.set(
          String(queueId),
          queuedIds.filter((id) => id !== String(trackId)),
        );
      },
      syncQueuedNextTrackIds(queueId = activeQueueId) {
        syncedQueueIds.push(String(queueId));
      },
    },
    'next',
    sourceQueueId,
  );

  assert.deepEqual(queuedNextByQueue.get(sourceQueueId), []);
  assert.deepEqual(queuedNextByQueue.get(activeQueueId), ['next']);
  assert.deepEqual(syncedQueueIds, [sourceQueueId]);
});
