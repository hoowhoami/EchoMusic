import { getNativeStorage } from './native';

type KvBatchMutation =
  | { key: string; value: unknown; delete?: never }
  | { key: string; delete: true; value?: never };

export class KvStorage {
  get<T>(key: string): T | null {
    const valueJson = getNativeStorage().kvGet(key);
    if (!valueJson) return null;
    try {
      return JSON.parse(valueJson) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    getNativeStorage().kvSet(key, JSON.stringify(value));
  }

  applyBatch(mutations: KvBatchMutation[]): void {
    const payload = mutations.map((mutation) => {
      if (mutation.delete) return { key: mutation.key, valueJson: null };
      const valueJson = JSON.stringify(mutation.value);
      if (valueJson === undefined)
        throw new Error(`KV value is not JSON serializable: ${mutation.key}`);
      return { key: mutation.key, valueJson };
    });
    getNativeStorage().kvApplyBatch(JSON.stringify(payload));
  }

  delete(key: string): void {
    getNativeStorage().kvDelete(key);
  }
}

let kvStorage: KvStorage | null = null;

export const getKvStorage = () => {
  if (!kvStorage) kvStorage = new KvStorage();
  return kvStorage;
};
