import { app } from 'electron';
import { mkdirSync } from 'fs';
import { createRequire } from 'node:module';
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
  historyGetEntries(payloadJson?: string): string;
  historyRecordPlay(payloadJson: string): string;
  historyRemoveEntries(payloadJson: string): string;
  historyClear(): string;
  pluginSqliteOpen(databaseId: string, databasePath: string, optionsJson?: string | null): string;
  pluginSqliteClose(databaseId: string): string;
  pluginSqliteCloseByPrefix(prefix: string): string;
  pluginSqliteExec(databaseId: string, sql: string): string;
  pluginSqliteRun(databaseId: string, sql: string, paramsJson?: string | null): string;
  pluginSqliteAll(
    databaseId: string,
    sql: string,
    paramsJson?: string | null,
    limit?: number | null,
  ): string;
  pluginSqliteTransaction(databaseId: string, statementsJson: string): string;
}

let addon: NativeStorageAddon | null = null;
let initialized = false;
const nativeRequire = createRequire(join(process.cwd(), 'package.json'));

const loadNativeStorageAddon = (): NativeStorageAddon => {
  if (addon) return addon;

  const primaryPath = app.isPackaged
    ? join(process.resourcesPath, 'native', 'echo-sqlite-store.node')
    : join(__dirname, '../../native/echo-sqlite-store/echo-sqlite-store.node');

  try {
    addon = nativeRequire(primaryPath) as NativeStorageAddon;
    return addon;
  } catch (primaryError) {
    try {
      addon = nativeRequire(join(process.cwd(), 'native/echo-sqlite-store')) as NativeStorageAddon;
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
