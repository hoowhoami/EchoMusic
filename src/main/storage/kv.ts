import { getNativeStorage } from './native';

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

  delete(key: string): void {
    getNativeStorage().kvDelete(key);
  }
}

let kvStorage: KvStorage | null = null;

export const getKvStorage = () => {
  if (!kvStorage) kvStorage = new KvStorage();
  return kvStorage;
};
