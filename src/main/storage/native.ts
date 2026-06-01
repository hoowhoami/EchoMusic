import { app } from 'electron';
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface NativeStorageAddon {
  initialize(databasePath: string): void;
  close(): void;
  kvGet(key: string): string | null;
  kvSet(key: string, valueJson: string): void;
  kvDelete(key: string): void;
  resetAll(): void;
  playbackGetSnapshot(hydrateAllSongs?: boolean): string;
  playbackGetQueue(payloadJson: string): string | null;
  playbackReplaceQueue(payloadJson: string): string;
  playbackAppendQueueItems(payloadJson: string): string;
  playbackUpdateQueueMeta(payloadJson: string): string;
  playbackClearQueue(payloadJson: string): string;
  playbackRemoveQueue(payloadJson: string): string;
  playbackRemoveQueueItem(payloadJson: string): string;
  playbackReorderQueueItems(payloadJson: string): string;
  playbackSetQueueCurrentTrack(payloadJson: string): string;
  playbackSetActiveQueue(queueId: string): string;
}

let addon: NativeStorageAddon | null = null;
let initialized = false;

const loadNativeStorageAddon = (): NativeStorageAddon => {
  if (addon) return addon;

  const primaryPath = app.isPackaged
    ? join(process.resourcesPath, 'native', 'echo-storage.node')
    : join(__dirname, '../../native/echo-storage/echo-storage.node');

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(primaryPath) as NativeStorageAddon;
    return addon;
  } catch (primaryError) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      addon = require('../../native/echo-storage') as NativeStorageAddon;
      return addon;
    } catch (fallbackError) {
      console.error('[Storage] Native storage addon is unavailable', primaryError, fallbackError);
      throw fallbackError;
    }
  }
};

export const getNativeStorage = (): NativeStorageAddon => {
  const nativeStorage = loadNativeStorageAddon();
  if (!initialized) {
    const userDataPath = app.getPath('userData');
    mkdirSync(userDataPath, { recursive: true });
    nativeStorage.initialize(join(userDataPath, 'echomusic.sqlite'));
    initialized = true;
  }
  return nativeStorage;
};
