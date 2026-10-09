import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export class ResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export const resourceError = (error: unknown) => {
  if (error instanceof ResourceError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    code: code === 'ENOSPC' ? 'DISK_FULL' : code === 'ENOENT' ? 'FILE_MISSING' : 'WRITE_FAILED',
    message: error instanceof Error ? error.message : '文件操作失败',
    retryable: true,
  };
};
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal, highWaterMark: 256 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}
export async function safePath(root: string, relative: string, write = false) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\0') ||
    /^[\\/]|^[a-z]:/i.test(relative)
  )
    throw new ResourceError('PATH_OUTSIDE_ROOT', '路径必须为目录内相对路径');
  const parts = relative.replace(/\\/g, '/').split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[:]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
    )
  )
    throw new ResourceError('PATH_OUTSIDE_ROOT', '文件路径无效');
  const base = await fs.realpath(root);
  let target = base;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    const stat = await fs.lstat(target).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (stat?.isSymbolicLink())
      throw new ResourceError('PATH_OUTSIDE_ROOT', '授权路径不能经过链接');
    if (i < parts.length - 1) {
      if (!stat && write) await fs.mkdir(target);
      else if (!stat?.isDirectory())
        throw new ResourceError('DIRECTORY_UNAVAILABLE', '父目录不存在');
    }
  }
  return target;
}
/** link is an atomic no-clobber operation on the same filesystem. Never exists()+rename(). */
export async function commitFile(
  temp: string,
  target: string,
  conflict: 'fail' | 'rename' | 'replace',
  before?: (candidate: string) => Promise<void>,
) {
  if (conflict === 'replace') {
    await before?.(target);
    await fs.rename(temp, target);
    return target;
  }
  for (let i = 0; i < 10000; i++) {
    const ext = path.extname(target);
    const candidate = i ? `${target.slice(0, -ext.length || undefined)} (${i})${ext}` : target;
    try {
      await before?.(candidate);
      await fs.link(temp, candidate);
      await fs.unlink(temp);
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (conflict === 'fail') throw new ResourceError('FILE_EXISTS', '目标文件已存在');
    }
  }
  throw new ResourceError('FILE_EXISTS', '无法分配文件名');
}
