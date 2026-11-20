import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
// native addon 产物被 .gitignore 忽略，未构建时直接 require 会抛 MODULE_NOT_FOUND，
// 因此先探测文件是否存在，缺失时把用例标记为跳过而不是让整个测试文件失败。
const addonPath = fileURLToPath(
  new URL('../native/echo-sqlite-store/echo-sqlite-store.node', import.meta.url),
);
const addon = fs.existsSync(addonPath) ? require(addonPath) : null;

test('native online backup captures data committed to an active WAL database', (t) => {
  if (!addon) {
    t.skip('需先构建 echo-sqlite-store native addon');
    return;
  }
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
