import { ipcMain } from 'electron';
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
  ipcMain.handle('storage:playback:get-snapshot', () => getPlaybackQueueStorage().getSnapshot());

  ipcMain.handle('storage:playback:get-queue', (_event, payload: StorageQueueIdPayload) =>
    getPlaybackQueueStorage().getQueue(payload),
  );

  ipcMain.handle('storage:playback:replace-queue', (_event, payload: StorageReplaceQueuePayload) =>
    getPlaybackQueueStorage().replaceQueue(payload),
  );

  ipcMain.handle(
    'storage:playback:append-items',
    (_event, payload: StorageAppendQueueItemsPayload) =>
      getPlaybackQueueStorage().appendQueueItems(payload),
  );

  ipcMain.handle(
    'storage:playback:update-queue-meta',
    (_event, payload: StorageUpdateQueueMetaPayload) =>
      getPlaybackQueueStorage().updateQueueMeta(payload),
  );

  ipcMain.handle('storage:playback:clear-queue', (_event, payload: StorageUpdateQueueMetaPayload) =>
    getPlaybackQueueStorage().clearQueue(payload),
  );

  ipcMain.handle('storage:playback:remove-queue', (_event, payload: StorageQueueIdPayload) =>
    getPlaybackQueueStorage().removeQueue(payload),
  );

  ipcMain.handle('storage:playback:remove-item', (_event, payload: StorageRemoveQueueItemPayload) =>
    getPlaybackQueueStorage().removeQueueItem(payload),
  );

  ipcMain.handle(
    'storage:playback:reorder-items',
    (_event, payload: StorageReorderQueueItemsPayload) =>
      getPlaybackQueueStorage().reorderQueueItems(payload),
  );

  ipcMain.handle(
    'storage:playback:set-current-track',
    (_event, payload: StorageSetQueueCurrentTrackPayload) =>
      getPlaybackQueueStorage().setQueueCurrentTrack(payload),
  );

  ipcMain.handle('storage:playback:set-active-queue', (_event, queueId: string) =>
    getPlaybackQueueStorage().setActiveQueue(queueId),
  );

  ipcMain.handle('storage:kv:get', (_event, key: string) => getKvStorage().get(String(key)));

  ipcMain.handle('storage:kv:set', (_event, key: string, value: unknown) => {
    getKvStorage().set(String(key), value);
    return { ok: true };
  });

  ipcMain.handle('storage:kv:delete', (_event, key: string) => {
    getKvStorage().delete(String(key));
    return { ok: true };
  });

  ipcMain.handle('storage:reset-all', () => {
    getPlaybackQueueStorage().resetAll();
    return { ok: true };
  });
};

export const unregisterStorageHandlers = () => {
  ipcMain.removeHandler('storage:playback:get-snapshot');
  ipcMain.removeHandler('storage:playback:get-queue');
  ipcMain.removeHandler('storage:playback:replace-queue');
  ipcMain.removeHandler('storage:playback:append-items');
  ipcMain.removeHandler('storage:playback:update-queue-meta');
  ipcMain.removeHandler('storage:playback:clear-queue');
  ipcMain.removeHandler('storage:playback:remove-queue');
  ipcMain.removeHandler('storage:playback:remove-item');
  ipcMain.removeHandler('storage:playback:reorder-items');
  ipcMain.removeHandler('storage:playback:set-current-track');
  ipcMain.removeHandler('storage:playback:set-active-queue');
  ipcMain.removeHandler('storage:kv:get');
  ipcMain.removeHandler('storage:kv:set');
  ipcMain.removeHandler('storage:kv:delete');
  ipcMain.removeHandler('storage:reset-all');
};
