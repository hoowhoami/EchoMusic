import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../db/connection';
import { ensureStorageSchema } from '../db/schema';

export class KvStorage {
  private db: DatabaseSync;

  constructor(database = getDatabase()) {
    ensureStorageSchema(database);
    this.db = database;
  }

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `
          INSERT INTO app_kv (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_kv WHERE key = ?').run(key);
  }
}

let kvStorage: KvStorage | null = null;

export const getKvStorage = () => {
  if (!kvStorage) kvStorage = new KvStorage();
  return kvStorage;
};
