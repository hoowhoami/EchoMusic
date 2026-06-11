import { ipcRegistry } from './registry';
import type {
  StorageAppendQueueItemsPayload,
  StorageQueueIdPayload,
  StorageReplaceQueuePayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '../../shared/storage';
import { getPlaybackQueueStorage } from '../storage/playbackQueues';
import { getKvStorage } from '../storage/kv';

export const registerStorageHandlers = () => {
  ipcRegistry.registerHandler('storage:playback:get-snapshot', () =>
    getPlaybackQueueStorage().getSnapshot(),
  );

  ipcRegistry.registerHandler(
    'storage:playback:get-queue',
    (_event, payload: StorageQueueIdPayload) => getPlaybackQueueStorage().getQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:replace-queue',
    (_event, payload: StorageReplaceQueuePayload) =>
      getPlaybackQueueStorage().replaceQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:append-items',
    (_event, payload: StorageAppendQueueItemsPayload) =>
      getPlaybackQueueStorage().appendQueueItems(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:update-queue-meta',
    (_event, payload: StorageUpdateQueueMetaPayload) =>
      getPlaybackQueueStorage().updateQueueMeta(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:clear-queue',
    (_event, payload: StorageUpdateQueueMetaPayload) =>
      getPlaybackQueueStorage().clearQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:remove-queue',
    (_event, payload: StorageQueueIdPayload) => getPlaybackQueueStorage().removeQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:remove-item',
    (_event, payload: StorageRemoveQueueItemPayload) =>
      getPlaybackQueueStorage().removeQueueItem(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:reorder-items',
    (_event, payload: StorageReorderQueueItemsPayload) =>
      getPlaybackQueueStorage().reorderQueueItems(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:set-current-track',
    (_event, payload: StorageSetQueueCurrentTrackPayload) =>
      getPlaybackQueueStorage().setQueueCurrentTrack(payload),
  );

  ipcRegistry.registerHandler('storage:playback:set-active-queue', (_event, queueId: string) =>
    getPlaybackQueueStorage().setActiveQueue(queueId),
  );

  ipcRegistry.registerHandler('storage:kv:get', (_event, key: string) =>
    getKvStorage().get(String(key)),
  );

  ipcRegistry.registerHandler('storage:kv:set', (_event, key: string, value: unknown) => {
    getKvStorage().set(String(key), value);
    return { ok: true };
  });

  ipcRegistry.registerHandler('storage:kv:delete', (_event, key: string) => {
    getKvStorage().delete(String(key));
    return { ok: true };
  });

  ipcRegistry.registerHandler('storage:reset-all', () => {
    getPlaybackQueueStorage().resetAll();
    return { ok: true };
  });
};
