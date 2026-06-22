import type {
  StorageHistoryEntry,
  StorageHistoryGetEntriesPayload,
  StorageHistoryRecordPlayPayload,
  StorageHistoryRemoveEntriesPayload,
  StorageResetResult,
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

export class HistoryStorage {
  getEntries(payload: StorageHistoryGetEntriesPayload = {}): StorageHistoryEntry[] {
    return parseJson<StorageHistoryEntry[]>(
      getNativeStorage().historyGetEntries(JSON.stringify(payload)),
      [],
    );
  }

  recordPlay(payload: StorageHistoryRecordPlayPayload): StorageHistoryEntry | null {
    return parseJson<StorageHistoryEntry | null>(
      getNativeStorage().historyRecordPlay(JSON.stringify(payload)),
      null,
    );
  }

  removeEntries(payload: StorageHistoryRemoveEntriesPayload): StorageResetResult {
    return writeResult(getNativeStorage().historyRemoveEntries(JSON.stringify(payload)));
  }

  clear(): StorageResetResult {
    return writeResult(getNativeStorage().historyClear());
  }
}

let historyStorage: HistoryStorage | null = null;

export const getHistoryStorage = () => {
  if (!historyStorage) historyStorage = new HistoryStorage();
  return historyStorage;
};
