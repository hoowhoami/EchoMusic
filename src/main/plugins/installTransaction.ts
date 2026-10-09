import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, ResourceError } from '../downloads/files';
const locks = new Map<string, Promise<void>>();
async function renameDirectory(source: string, target: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 3 ||
        !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, [50, 150, 300][attempt]));
    }
  }
}
export async function withInstallLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => {}).then(() => locked);
  locks.set(id, next);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (locks.get(id) === next) locks.delete(id);
  }
}
interface Journal {
  target: string;
  staged: string;
  rollback: string;
  phase: 'prepared' | 'replacing' | 'committed';
  oldExists: boolean;
  metadata?: unknown;
}
export async function validateProgramDirectory(directory: string, maxBytes = 80 * 1024 * 1024) {
  let total = 0;
  let count = 0;
  const walk = async (dir: string) => {
    const names = new Set<string>();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = entry.name.toLowerCase();
      if (names.has(name)) throw new ResourceError('INVALID_ARGUMENT', '插件包包含大小写冲突路径');
      names.add(name);
      if (++count > 10000) throw new ResourceError('SIZE_LIMIT', '插件包文件数量过多');
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new ResourceError('PATH_OUTSIDE_ROOT', '插件包不能包含链接');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > maxBytes) throw new ResourceError('SIZE_LIMIT', '插件安装包解压后超过 80 MB');
      } else throw new ResourceError('INVALID_ARGUMENT', '插件包含不支持的文件');
    }
  };
  await walk(directory);
}
export async function createInstallTransaction(root: string, target: string, metadata?: unknown) {
  const parent = path.join(root, '.install-transactions');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'txn-'));
  const journal: Journal = {
    target,
    staged: path.join(directory, 'staged'),
    rollback: path.join(directory, 'rollback'),
    phase: 'prepared',
    oldExists: Boolean(await fs.stat(target).catch(() => null)),
    metadata,
  };
  const file = path.join(directory, 'journal.json');
  await atomicJson(file, journal);
  const rollback = async () => {
    const old = await fs.stat(journal.rollback).catch(() => null);
    if (old) {
      await fs.rm(target, { recursive: true, force: true });
      await renameDirectory(journal.rollback, target);
    } else if (!journal.oldExists && journal.phase === 'replacing')
      await fs.rm(target, { recursive: true, force: true });
  };
  return {
    directory,
    staged: journal.staged,
    setMetadata: async (metadata: unknown) => {
      journal.metadata = metadata;
      await atomicJson(file, journal);
    },
    discard: () => fs.rm(directory, { recursive: true, force: true }),
    apply: async (
      mutation: (fn: () => Promise<void>) => Promise<unknown>,
      applyMetadata: () => Promise<void>,
      restoreMetadata: () => Promise<void>,
      validate?: () => void,
    ) => {
      try {
        await mutation(async () => {
          journal.phase = 'replacing';
          await atomicJson(file, journal);
          if (journal.oldExists) await renameDirectory(target, journal.rollback);
          await renameDirectory(journal.staged, target);
          await applyMetadata();
        });
        validate?.();
        journal.phase = 'committed';
        await atomicJson(file, journal);
      } catch (error) {
        try {
          await mutation(async () => {
            await rollback();
            await restoreMetadata();
          });
        } catch (rollbackError) {
          throw new ResourceError(
            'ROLLBACK_FAILED',
            `安装回滚失败，已保留恢复记录：${rollbackError instanceof Error ? rollbackError.message : '未知错误'}`,
          );
        }
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      // Cleanup failure does not undo a successfully committed installation.
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
export async function recoverInstallTransactions(
  root: string,
  restore: (target: string, metadata: unknown) => Promise<void>,
) {
  const parent = path.join(root, '.install-transactions');
  const entries = await fs.readdir(parent).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  for (const name of entries) {
    const directory = path.join(parent, name);
    const file = path.join(directory, 'journal.json');
    const text = await fs.readFile(file, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!text) continue;
    const j = JSON.parse(text) as Journal;
    if (
      path.dirname(j.target) !== root ||
      j.staged !== path.join(directory, 'staged') ||
      j.rollback !== path.join(directory, 'rollback')
    )
      throw new ResourceError('PATH_OUTSIDE_ROOT', '安装恢复路径无效');
    if (j.phase === 'committed' && (await fs.stat(j.target).catch(() => null))) {
      await fs.rm(directory, { recursive: true, force: true });
      continue;
    }
    if (j.phase !== 'prepared') {
      if (await fs.stat(j.rollback).catch(() => null)) {
        await fs.rm(j.target, { recursive: true, force: true });
        await renameDirectory(j.rollback, j.target);
      } else if (!j.oldExists) await fs.rm(j.target, { recursive: true, force: true });
      await restore(j.target, j.metadata);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
