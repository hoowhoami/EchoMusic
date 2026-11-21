import type {
  StorageHistoryAddListenTimePayload,
  StorageHistoryAddListenTimeResult,
  StorageHistoryEntry,
  StorageHistoryGetEntriesPayload,
  StorageHistoryListenTotalResult,
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

  /** 累加本地实听时长；条目不存在时返回 updated: 0，不重建条目 */
  addListenTime(payload: StorageHistoryAddListenTimePayload): StorageHistoryAddListenTimeResult {
    return parseJson<StorageHistoryAddListenTimeResult>(
      getNativeStorage().historyAddListenTime(JSON.stringify(payload)),
      { ok: false, updated: 0 },
    );
  }

  /** 读取终身累计实听时长（独立于播放历史条目，历史裁剪/删除不影响） */
  getListenTotal(): StorageHistoryListenTotalResult {
    return parseJson<StorageHistoryListenTotalResult>(getNativeStorage().historyGetListenTotal(), {
      ok: false,
      listenedMs: 0,
    });
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
