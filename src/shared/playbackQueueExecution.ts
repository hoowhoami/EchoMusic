export type QueuedNextPlaybackActions = {
  consumeQueuedNextTrackId: (trackId: string | number, queueId?: string | number) => void;
  syncQueuedNextTrackIds: (queueId?: string | number) => void;
};

export const consumePlayedQueuedNextTrack = (
  actions: QueuedNextPlaybackActions,
  trackId: string | number,
  sourceQueueId: string | number | null | undefined,
): void => {
  const queueId = String(sourceQueueId ?? '') || undefined;
  actions.consumeQueuedNextTrackId(trackId, queueId);
  actions.syncQueuedNextTrackIds(queueId);
};
