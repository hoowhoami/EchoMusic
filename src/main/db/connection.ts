import { app } from 'electron';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync | null = null;

const applyPragmas = (database: DatabaseSync) => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
  `);
};

export const getDatabase = (): DatabaseSync => {
  if (db) return db;
  const databasePath = join(app.getPath('userData'), 'echomusic.sqlite');
  db = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    allowBareNamedParameters: true,
    timeout: 5000,
  });
  applyPragmas(db);
  return db;
};

export const runInTransaction = <T>(database: DatabaseSync, callback: () => T): T => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

export const closeDatabase = () => {
  if (!db) return;
  db.close();
  db = null;
};
