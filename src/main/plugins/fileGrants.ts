import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DirectoryRef, FileRef, FileGrantInfo } from '../../shared/pluginFiles';
import { atomicJson, ResourceError, safePath } from '../downloads/files';

interface Grant {
  id: string;
  owner: string;
  path: string;
  access: 'read' | 'read-write';
  kind: 'user' | 'data' | 'cache' | 'file';
  persist: boolean;
  revoked: boolean;
  revision: number;
}
export class FileGrants {
  private grants = new Map<string, Grant>();
  private queue = Promise.resolve();
  private ready: Promise<void>;
  private listeners = new Set<(id: string) => Promise<void>>();
  constructor(private root: string) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load() {
    const data = await fs.readFile(path.join(this.root, 'grants.json'), 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '[]';
      throw e;
    });
    for (const grant of JSON.parse(data) as Grant[]) this.grants.set(grant.id, grant);
  }
  private save(grants = [...this.grants.values()]) {
    return atomicJson(
      path.join(this.root, 'grants.json'),
      grants.filter((g) => g.persist),
    );
  }
  private async put(grant: Grant) {
    const candidate = new Map(this.grants);
    candidate.set(grant.id, grant);
    await this.save([...candidate.values()]);
    this.grants.set(grant.id, grant);
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready;
    const next = this.queue.then(fn);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  onRevoke(fn: (id: string) => Promise<void>) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async create(
    owner: string,
    input: string,
    access: 'read' | 'read-write',
    persist = true,
    file = false,
    previous?: string,
  ): Promise<DirectoryRef | FileRef> {
    return this.locked(async () => {
      const real = await fs.realpath(input);
      const stat = await fs.stat(real);
      if (file ? !stat.isFile() : !stat.isDirectory())
        throw new ResourceError('INVALID_ARGUMENT', '选择的文件类型无效');
      const old = previous ? this.grants.get(previous) : undefined;
      if (old && old.owner !== owner) throw new ResourceError('GRANT_REQUIRED', '授权不属于此插件');
      const grant: Grant = {
        id: old?.path === real ? old.id : randomUUID(),
        owner,
        path: real,
        access,
        kind: file ? 'file' : 'user',
        persist,
        revoked: false,
        revision: (old?.revision ?? 0) + 1,
      };
      await this.put(grant);
      return file ? { kind: 'selected-file', fileId: grant.id } : this.ref(grant);
    });
  }
  private async ref(g: Grant): Promise<DirectoryRef> {
    return {
      id: g.id,
      name: path.basename(g.path),
      access: g.access,
      kind: g.kind as DirectoryRef['kind'],
      displayPath: g.path,
      available: !g.revoked && Boolean(await fs.stat(g.path).catch(() => null)),
    };
  }
  async list(owner: string) {
    await this.ready;
    return Promise.all(
      [...this.grants.values()]
        .filter((g) => g.owner === owner && g.kind !== 'file')
        .map((g) => this.ref(g)),
    );
  }
  async listAll(owner: string): Promise<FileGrantInfo[]> {
    await this.ready;
    return Promise.all(
      [...this.grants.values()]
        .filter((g) => g.owner === owner)
        .map(async (g) => ({ ...(await this.ref(g)), kind: g.kind, revoked: g.revoked })),
    );
  }
  async privateDirectory(owner: string, kind: 'data' | 'cache') {
    if (kind !== 'data' && kind !== 'cache')
      throw new ResourceError('INVALID_ARGUMENT', '私有目录类型无效');
    return this.locked(async () => {
      const old = [...this.grants.values()].find(
        (g) => g.owner === owner && g.kind === kind && !g.revoked,
      );
      if (old) return this.ref(old);
      const directory = path.join(this.root, '..', `plugin-${kind}`, owner);
      await fs.mkdir(directory, { recursive: true });
      const g: Grant = {
        id: randomUUID(),
        owner,
        kind,
        path: await fs.realpath(directory),
        access: 'read-write',
        persist: true,
        revoked: false,
        revision: 1,
      };
      await this.put(g);
      return this.ref(g);
    });
  }
  async resolve(owner: string, ref: FileRef, write = false) {
    await this.ready;
    if (!ref || typeof ref !== 'object')
      throw new ResourceError('INVALID_ARGUMENT', '文件引用无效');
    const id = ref.kind === 'selected-file' ? ref.fileId : ref.directoryId;
    const g = this.grants.get(id);
    if (!g || g.owner !== owner) throw new ResourceError('GRANT_REQUIRED', '未授权此文件');
    if (g.revoked) throw new ResourceError('GRANT_REVOKED', '目录授权已撤销');
    const rootStat = await fs.lstat(g.path);
    if (rootStat.isSymbolicLink())
      throw new ResourceError('PATH_OUTSIDE_ROOT', '授权路径不能经过链接');
    if (write && (g.access !== 'read-write' || g.kind === 'file'))
      throw new ResourceError('GRANT_REQUIRED', '此授权仅可读取');
    const file =
      ref.kind === 'selected-file' ? g.path : await safePath(g.path, ref.relativePath, write);
    return { path: file, root: g.path, id: g.id, revision: g.revision };
  }
  async directory(owner: string, id: string) {
    await this.ready;
    const g = this.grants.get(id);
    if (!g || g.owner !== owner || g.kind === 'file' || g.revoked)
      throw new ResourceError('GRANT_REQUIRED', '目录未授权');
    if ((await fs.lstat(g.path)).isSymbolicLink())
      throw new ResourceError('PATH_OUTSIDE_ROOT', '授权路径不能经过链接');
    return g.path;
  }
  async revoke(owner: string, id: string) {
    let revoked = false;
    try {
      await this.locked(async () => {
        const g = this.grants.get(id);
        if (!g || g.owner !== owner) throw new ResourceError('GRANT_REQUIRED', '授权不属于此插件');
        g.revoked = true;
        g.revision++;
        revoked = true;
        await this.save();
      });
    } finally {
      if (revoked) await Promise.all([...this.listeners].map((fn) => fn(id)));
    }
  }
  private revokedGrant(owner: string, id: string) {
    const grant = this.grants.get(id);
    if (!grant || grant.owner !== owner || !['user', 'file'].includes(grant.kind))
      throw new ResourceError('GRANT_REQUIRED', '该文件或目录不属于用户授权');
    if (!grant.revoked) throw new ResourceError('INVALID_ARGUMENT', '授权尚未撤销');
    return grant;
  }
  async revokedSelection(owner: string, id: string) {
    return this.locked(async () => {
      const grant = this.revokedGrant(owner, id);
      return {
        kind: grant.kind,
        access: grant.access,
        persist: grant.persist,
        revision: grant.revision,
      };
    });
  }
  async reauthorizeRevoked(
    owner: string,
    id: string,
    input: string,
    revision: number,
    validate: () => void,
  ) {
    return this.locked(async () => {
      validate();
      const grant = this.revokedGrant(owner, id);
      if (grant.revision !== revision)
        throw new ResourceError('GRANT_REVOKED', '授权记录已变化，请刷新后重试');
      const real = await fs.realpath(input);
      const stat = await fs.stat(real);
      if (grant.kind === 'file' ? !stat.isFile() : !stat.isDirectory())
        throw new ResourceError('INVALID_ARGUMENT', '选择的文件类型无效');
      validate();
      await this.put({
        ...grant,
        id: grant.path === real ? grant.id : randomUUID(),
        path: real,
        revoked: false,
        revision: grant.revision + 1,
      });
    });
  }
  async removeRevoked(owner: string, id: string) {
    await this.locked(async () => {
      const grant = this.grants.get(id);
      if (!grant || grant.owner !== owner || !['user', 'file'].includes(grant.kind))
        throw new ResourceError('GRANT_REQUIRED', '该文件或目录不属于用户授权');
      if (!grant.revoked) throw new ResourceError('INVALID_ARGUMENT', '请先撤销授权，再移除记录');
      const remaining = new Map(this.grants);
      remaining.delete(id);
      await this.save([...remaining.values()]);
      this.grants.delete(id);
    });
  }
  async removeOwner(owner: string) {
    for (const g of [...this.grants.values()].filter((g) => g.owner === owner))
      await this.revoke(owner, g.id);
    await this.locked(async () => {
      for (const [id, g] of this.grants) if (g.owner === owner) this.grants.delete(id);
      await this.save();
    });
  }
}
