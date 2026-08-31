import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const addon = require('../native/echo-sqlite-store/echo-sqlite-store.node');

test('native online backup captures data committed to an active WAL database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-native-backup-'));
  const source = path.join(root, 'source.sqlite');
  const backup = path.join(root, 'backup.sqlite');
  try {
    addon.pluginSqliteOpen('backup-test:source', source, JSON.stringify({ busyTimeoutMs: 30_000 }));
    addon.pluginSqliteExec(
      'backup-test:source',
      "PRAGMA journal_mode=WAL; CREATE TABLE snapshot_test(value TEXT); INSERT INTO snapshot_test VALUES ('wal-row');",
    );
    addon.pluginSqliteBackup(source, backup);
    addon.pluginSqliteOpen(
      'backup-test:backup',
      backup,
      JSON.stringify({ readOnly: true, busyTimeoutMs: 30_000 }),
    );
    const result = JSON.parse(
      addon.pluginSqliteAll('backup-test:backup', 'SELECT value FROM snapshot_test', null, 10),
    );
    assert.equal(result.rows?.[0]?.value, 'wal-row');
  } finally {
    addon.pluginSqliteCloseByPrefix('backup-test:');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
