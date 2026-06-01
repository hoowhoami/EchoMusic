import type {
  StorageAppendQueueItemsPayload,
  StoragePlaybackQueueState,
  StoragePlaybackSnapshot,
  StorageQueueIdPayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageResetResult,
  StorageReplaceQueuePayload,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '../../shared/storage';
import { getNativeStorage } from './native';

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const writeResult = (value: string): StorageResetResult =>
  parseJson<StorageResetResult>(value, { ok: true });

export class PlaybackQueueStorage {
  getSnapshot(options?: { hydrateAllSongs?: boolean }): StoragePlaybackSnapshot {
    return parseJson<StoragePlaybackSnapshot>(
      getNativeStorage().playbackGetSnapshot(options?.hydrateAllSongs === true),
      { queues: [], activeQueueId: 'queue:default', lastNonFmQueueId: 'queue:default' },
    );
  }

  getQueue(payload: StorageQueueIdPayload): StoragePlaybackQueueState | null {
    return parseJson<StoragePlaybackQueueState | null>(
      getNativeStorage().playbackGetQueue(JSON.stringify(payload)),
      null,
    );
  }

  replaceQueue(payload: StorageReplaceQueuePayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackReplaceQueue(JSON.stringify(payload)));
  }

  appendQueueItems(payload: StorageAppendQueueItemsPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackAppendQueueItems(JSON.stringify(payload)));
  }

  updateQueueMeta(payload: StorageUpdateQueueMetaPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackUpdateQueueMeta(JSON.stringify(payload)));
  }

  removeQueue(payload: StorageQueueIdPayload): StoragePlaybackSnapshot {
    return parseJson<StoragePlaybackSnapshot>(
      getNativeStorage().playbackRemoveQueue(JSON.stringify(payload)),
      this.getSnapshot(),
    );
  }

  clearQueue(payload: StorageUpdateQueueMetaPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackClearQueue(JSON.stringify(payload)));
  }

  removeQueueItem(payload: StorageRemoveQueueItemPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackRemoveQueueItem(JSON.stringify(payload)));
  }

  reorderQueueItems(payload: StorageReorderQueueItemsPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackReorderQueueItems(JSON.stringify(payload)));
  }

  setQueueCurrentTrack(payload: StorageSetQueueCurrentTrackPayload): StorageResetResult {
    return writeResult(getNativeStorage().playbackSetQueueCurrentTrack(JSON.stringify(payload)));
  }

  setActiveQueue(queueId: string): StorageResetResult {
    return writeResult(getNativeStorage().playbackSetActiveQueue(queueId));
  }

  resetAll(): void {
    getNativeStorage().resetAll();
  }
}

let playbackQueueStorage: PlaybackQueueStorage | null = null;

export const getPlaybackQueueStorage = () => {
  if (!playbackQueueStorage) playbackQueueStorage = new PlaybackQueueStorage();
  return playbackQueueStorage;
};
