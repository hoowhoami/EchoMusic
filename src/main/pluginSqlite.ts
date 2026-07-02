import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import type {
  EchoPluginDescriptor,
  PluginSqliteCloseResult,
  PluginSqliteDatabaseInfo,
  PluginSqliteDeleteResult,
  PluginSqliteExecResult,
  PluginSqliteListResult,
  PluginSqliteMigration,
  PluginSqliteOpenOptions,
  PluginSqliteOpenResult,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteQueryResult,
  PluginSqliteRunResult,
  PluginSqliteStatement,
} from '../shared/plugins';
import { getNativeStorage } from './storage/native';
import log from './logger';

const PLUGIN_SQLITE_ROOT = 'plugin-sqlite';
const DEFAULT_DATABASE_NAME = 'main';
const MAX_DATABASE_NAME_LENGTH = 64;
const MAX_SQL_LENGTH = 256 * 1024;
const DEFAULT_QUERY_LIMIT = 1000;
const MAX_QUERY_LIMIT = 5000;
const MAX_TRANSACTION_STATEMENTS = 500;
const MAX_RESULT_JSON_BYTES = 8 * 1024 * 1024;
const DATABASE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BLOCKED_SQL_RE =
  /\b(?:ATTACH|DETACH)\b|\bVACUUM\s+INTO\b|\bload_extension\s*\(|\bPRAGMA\s+database_list\b/i;

const ok = <T extends object>(value: T): T & { ok: true } => ({ ok: true, ...value });
const fail = (error: unknown, fallback: string) => ({
  ok: false as const,
  error: error instanceof Error ? error.message : fallback,
});

const normalizeDatabaseName = (name?: string) => {
  const normalized = String(name || DEFAULT_DATABASE_NAME).trim();
  if (!normalized) throw new Error('SQLite 数据库名不能为空');
  if (normalized.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error(`SQLite 数据库名不能超过 ${MAX_DATABASE_NAME_LENGTH} 个字符`);
  }
  if (!DATABASE_NAME_RE.test(normalized)) {
    throw new Error('SQLite 数据库名只能包含字母、数字、点、下划线和短横线，且必须以字母或数字开头');
  }
  return normalized;
};

const getPluginSqliteRoot = (pluginId: string) => join(app.getPath('userData'), PLUGIN_SQLITE_ROOT, pluginId);

const getDatabasePath = (pluginId: string, name: string) =>
  join(getPluginSqliteRoot(pluginId), `${name}.sqlite`);

const getDatabaseId = (pluginId: string, name: string) => `${pluginId}:${name}`;

const getNameFromDatabaseId = (pluginId: string, databaseId: string) => {
  const prefix = `${pluginId}:`;
  if (!String(databaseId || '').startsWith(prefix)) {
    throw new Error('SQLite 数据库不属于当前插件');
  }
  return normalizeDatabaseName(databaseId.slice(prefix.length));
};

const validateSql = (sql: string) => {
  const value = String(sql || '');
  if (!value.trim()) throw new Error('SQLite SQL 不能为空');
  if (value.length > MAX_SQL_LENGTH) throw new Error('SQLite SQL 过长');
  if (BLOCKED_SQL_RE.test(value)) {
    throw new Error('SQLite SQL 包含不允许的语句');
  }
  return value;
};

const normalizeParams = (params?: PluginSqliteParams) => {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new Error('SQLite 参数必须是数组');
  return params.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('SQLite 数字参数必须是有限数值');
      }
      return value;
    }
    throw new Error('SQLite 参数仅支持 string、number、boolean 和 null');
  });
};

const normalizeQueryLimit = (options?: PluginSqliteQueryOptions) => {
  const limit = Number(options?.limit ?? DEFAULT_QUERY_LIMIT);
  if (!Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.trunc(Math.min(Math.max(limit, 1), MAX_QUERY_LIMIT));
};

const parseNativeJson = <T>(value: string, maxBytes = MAX_RESULT_JSON_BYTES): T => {
  if (value.length > maxBytes) throw new Error('SQLite 查询结果过大');
  return JSON.parse(value) as T;
};

const toParamsJson = (params?: PluginSqliteParams) => JSON.stringify(normalizeParams(params));

const normalizeMigrations = (migrations?: PluginSqliteMigration[]) => {
  if (migrations === undefined) return [];
  if (!Array.isArray(migrations)) throw new Error('SQLite migrations 必须是数组');
  return migrations
    .map((migration) => {
      const version = Number(migration?.version);
      if (!Number.isInteger(version) || version < 1 || version > 999999) {
        throw new Error('SQLite migration.version 必须是 1 到 999999 的整数');
      }
      const sqlList = Array.isArray(migration.sql) ? migration.sql : [migration.sql];
      const sql = sqlList.map((item) => validateSql(item)).join('\n');
      return { version, sql };
    })
    .sort((left, right) => left.version - right.version);
};

const getCurrentUserVersion = (databaseId: string) => {
  const raw = getNativeStorage().pluginSqliteAll(databaseId, 'PRAGMA user_version', null, 1);
  const result = parseNativeJson<{ rows?: Array<Record<string, unknown>> }>(raw);
  return Number(result.rows?.[0]?.user_version ?? 0) || 0;
};

const applyMigrations = (databaseId: string, migrations?: PluginSqliteMigration[]) => {
  const normalizedMigrations = normalizeMigrations(migrations);
  if (normalizedMigrations.length === 0) return getCurrentUserVersion(databaseId);

  let currentVersion = getCurrentUserVersion(databaseId);
  for (const migration of normalizedMigrations) {
    if (migration.version <= currentVersion) continue;
    const sql = `BEGIN IMMEDIATE;\n${migration.sql}\nPRAGMA user_version = ${migration.version};\nCOMMIT;`;
    try {
      getNativeStorage().pluginSqliteExec(databaseId, sql);
    } catch (error) {
      try {
        getNativeStorage().pluginSqliteExec(databaseId, 'ROLLBACK;');
      } catch {
        // ignore rollback failures; the original migration error is more useful
      }
      throw error;
    }
    currentVersion = migration.version;
  }
  return currentVersion;
};

export const openPluginSqliteDatabase = (
  plugin: EchoPluginDescriptor,
  options?: PluginSqliteOpenOptions,
): PluginSqliteOpenResult => {
  let databaseId = '';
  try {
    const name = normalizeDatabaseName(options?.name);
    databaseId = getDatabaseId(plugin.id, name);
    const root = getPluginSqliteRoot(plugin.id);
    mkdirSync(root, { recursive: true });
    getNativeStorage().pluginSqliteOpen(
      databaseId,
      getDatabasePath(plugin.id, name),
      JSON.stringify({
        readOnly: options?.readOnly === true,
        busyTimeoutMs: Number(options?.busyTimeoutMs) || 3000,
      }),
    );
    const version = options?.readOnly ? getCurrentUserVersion(databaseId) : applyMigrations(databaseId, options?.migrations);
    return ok({ pluginId: plugin.id, databaseId, name, version });
  } catch (error) {
    if (databaseId) {
      try {
        getNativeStorage().pluginSqliteClose(databaseId);
      } catch {
        // ignore cleanup failure after an open/migration error
      }
    }
    log.warn('[PluginSqlite] Open failed', { pluginId: plugin.id, error });
    return fail(error, '插件 SQLite 数据库打开失败');
  }
};

export const execPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
): PluginSqliteExecResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    getNativeStorage().pluginSqliteExec(databaseId, validateSql(sql));
    return { ok: true };
  } catch (error) {
    return fail(error, '插件 SQLite 执行失败');
  }
};

export const runPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteRunResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteRun(databaseId, validateSql(sql), toParamsJson(params));
    return ok(parseNativeJson<{ changes: number; lastInsertRowid: number }>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 写入失败');
  }
};

export const allPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
  options?: PluginSqliteQueryOptions,
): PluginSqliteQueryResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteAll(
      databaseId,
      validateSql(sql),
      toParamsJson(params),
      normalizeQueryLimit(options),
    );
    return ok(parseNativeJson<Omit<Extract<PluginSqliteQueryResult, { ok: true }>, 'ok'>>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 查询失败');
  }
};

export const getPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteQueryResult => {
  const result = allPluginSqlite(pluginId, databaseId, sql, params, { limit: 1 });
  if (!result.ok) return result;
  return { ...result, rows: result.rows.slice(0, 1), rowCount: result.rows.length > 0 ? 1 : 0 };
};

export const transactionPluginSqlite = (
  pluginId: string,
  databaseId: string,
  statements: PluginSqliteStatement[],
): PluginSqliteExecResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    if (!Array.isArray(statements)) throw new Error('SQLite transaction 参数必须是数组');
    if (statements.length > MAX_TRANSACTION_STATEMENTS) {
      throw new Error(`SQLite transaction 最多包含 ${MAX_TRANSACTION_STATEMENTS} 条语句`);
    }
    const normalizedStatements = statements.map((statement) => ({
      sql: validateSql(statement?.sql),
      params: normalizeParams(statement?.params),
    }));
    getNativeStorage().pluginSqliteTransaction(databaseId, JSON.stringify(normalizedStatements));
    return { ok: true };
  } catch (error) {
    return fail(error, '插件 SQLite 事务执行失败');
  }
};

export const closePluginSqliteDatabase = (
  pluginId: string,
  databaseId: string,
): PluginSqliteCloseResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteClose(databaseId);
    return ok(parseNativeJson<{ closed: boolean }>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 数据库关闭失败');
  }
};

export const closePluginSqliteDatabases = (pluginId?: string) => {
  try {
    getNativeStorage().pluginSqliteCloseByPrefix(pluginId ? `${pluginId}:` : '');
  } catch (error) {
    log.warn('[PluginSqlite] Close failed', { pluginId, error });
  }
};

export const listPluginSqliteDatabases = (pluginId: string): PluginSqliteListResult => {
  try {
    const root = getPluginSqliteRoot(pluginId);
    if (!existsSync(root)) return { ok: true, databases: [] };
    const databases = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
      .map<PluginSqliteDatabaseInfo>((entry) => {
        const name = entry.name.slice(0, -'.sqlite'.length);
        const stats = statSync(join(root, entry.name));
        return { name, size: stats.size, modifiedAt: stats.mtimeMs };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return { ok: true, databases };
  } catch (error) {
    return fail(error, '插件 SQLite 数据库列表读取失败');
  }
};

export const deletePluginSqliteDatabase = (
  pluginId: string,
  name: string | undefined,
): PluginSqliteDeleteResult => {
  try {
    const databaseName = normalizeDatabaseName(name);
    const databaseId = getDatabaseId(pluginId, databaseName);
    getNativeStorage().pluginSqliteClose(databaseId);
    const databasePath = getDatabasePath(pluginId, databaseName);
    const existed = existsSync(databasePath);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      rmSync(path, { force: true });
    }
    return { ok: true, deleted: existed };
  } catch (error) {
    return fail(error, '插件 SQLite 数据库删除失败');
  }
};

export const deletePluginSqliteDatabases = (pluginId: string) => {
  closePluginSqliteDatabases(pluginId);
  rmSync(getPluginSqliteRoot(pluginId), { recursive: true, force: true });
};

app.once('before-quit', () => closePluginSqliteDatabases());
