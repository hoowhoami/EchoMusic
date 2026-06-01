import type { DatabaseSync } from 'node:sqlite';

export const ensureStorageSchema = (db: DatabaseSync) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_queues (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      last_non_fm INTEGER NOT NULL DEFAULT 0,
      current_track_id TEXT,
      filtered_invalid_count INTEGER NOT NULL DEFAULT 0,
      queued_next_track_ids_json TEXT NOT NULL DEFAULT '[]',
      dynamic INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS songs (
      song_key TEXT PRIMARY KEY,
      source_id TEXT,
      hash TEXT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_items (
      queue_id TEXT NOT NULL,
      song_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (queue_id, position),
      FOREIGN KEY (queue_id) REFERENCES playback_queues(id) ON DELETE CASCADE,
      FOREIGN KEY (song_key) REFERENCES songs(song_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_queue_items_queue_position
      ON queue_items(queue_id, position);

    CREATE INDEX IF NOT EXISTS idx_queue_items_song_key
      ON queue_items(song_key);
  `);
};
