import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type {
  DownloadOptions,
  DownloadSnapshot,
  DownloadSource,
} from '../../shared/pluginDownloads';
import type { DownloadTarget, FileRef } from '../../shared/pluginFiles';
import { atomicJson, commitFile, hashFile, ResourceError, resourceError } from './files';

export interface ResolvedTarget {
  path: string;
  validate(): Promise<void>;
  commit<T>(fn: () => Promise<T>): Promise<T>;
}
interface RecordData {
  version: 1;
  owner: string;
  snapshot: DownloadSnapshot;
  options: Omit<DownloadOptions, 'url' | 'headers'>;
  temp?: string;
  final?: string;
  inode?: string;
  etag?: string;
  modified?: string;
  localFile?: string;
  localRef?: FileRef;
}
const terminal = new Set(['completed', 'failed', 'canceled', 'interrupted']);
const size = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
export class DownloadEngine {
  private records = new Map<string, RecordData>();
  private admitting = new Set<string>();
  private sources = new Map<string, DownloadSource>();
  private active = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  private intents = new Map<string, 'paused' | 'canceled' | 'interrupted'>();
  private listeners = new Set<(owner: string, snapshot: DownloadSnapshot) => void>();
  private writes = new Map<string, Promise<void>>();
  private commands = new Map<string, Promise<unknown>>();
  private ready: Promise<void>;
  private stopped = false;
  private recoveredCopies = new Set<string>();
  constructor(
    private deps: {
      root: string;
      fetch: (url: string, init: RequestInit) => Promise<Response>;
      resolve: (owner: string, target: DownloadTarget) => Promise<ResolvedTarget>;
      resolveSource?: (owner: string, ref: FileRef) => Promise<string>;
    },
  ) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load() {
    await fs.mkdir(this.deps.root, { recursive: true });
    for (const file of await fs.readdir(this.deps.root)) {
      if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
      const r = JSON.parse(
        await fs.readFile(path.join(this.deps.root, file), 'utf8'),
      ) as RecordData;
      if (r.version !== 1 || file !== `${r.snapshot.id}.json`)
        throw new ResourceError('INVALID_ARGUMENT', '下载任务记录损坏');
      if (r.snapshot.state === 'committing' && r.final && r.inode) {
        const stat = await fs.stat(r.final).catch(() => null);
        if (stat && size(stat) === r.inode && stat.size === r.snapshot.receivedBytes) {
          r.snapshot.state = 'completed';
          r.snapshot.result = {
            taskId: r.snapshot.id,
            file: {
              kind: 'directory-file',
              directoryId: r.options.target.directoryId,
              relativePath: path.join(
                path.dirname(r.options.target.relativePath),
                path.basename(r.final),
              ),
            },
            bytes: stat.size,
          };
        }
      }
      if (!terminal.has(r.snapshot.state) && r.snapshot.state !== 'paused')
        r.snapshot.state = 'interrupted';
      if (r.localFile && !['completed', 'canceled'].includes(r.snapshot.state)) {
        r.snapshot.state = 'interrupted';
        this.recoveredCopies.add(r.snapshot.id);
      }
      this.records.set(r.snapshot.id, r);
      this.update(r, {}, true);
      await this.persist(r);
    }
  }
  subscribe(listener: (owner: string, snapshot: DownloadSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private update(r: RecordData, patch: Partial<DownloadSnapshot>, silent = false) {
    Object.assign(r.snapshot, patch);
    const s = r.snapshot;
    s.revision++;
    s.updatedAt = Date.now();
    s.canPause = ['queued', 'connecting', 'downloading', 'verifying'].includes(s.state);
    s.canResume = ['paused', 'interrupted'].includes(s.state) && !this.recoveredCopies.has(s.id);
    s.canRetry = s.state === 'failed' && !this.recoveredCopies.has(s.id);
    if (!silent)
      for (const fn of this.listeners) {
        try {
          fn(r.owner, structuredClone(s));
        } catch {
          /* subscriber cannot break transfer */
        }
      }
  }
  private persist(r: RecordData) {
    const id = r.snapshot.id;
    const data = structuredClone(r);
    const next = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => atomicJson(path.join(this.deps.root, `${id}.json`), data));
    this.writes.set(id, next);
    return next;
  }
  private record(owner: string, id: string) {
    const r = this.records.get(id);
    if (!r || r.owner !== owner) throw new ResourceError('GRANT_REQUIRED', '下载任务不属于此插件');
    return r;
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.commands.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.commands.set(id, next);
    void next
      .finally(() => {
        if (this.commands.get(id) === next) this.commands.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private async clearPartial(r: RecordData) {
    if (!r.temp) return;
    const stat = await fs.lstat(r.temp).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (stat && (stat.isSymbolicLink() || size(stat) !== r.inode))
      throw new ResourceError('PATH_OUTSIDE_ROOT', '临时文件身份改变，未删除该文件');
    await fs.rm(r.temp, { force: true });
    r.temp = undefined;
  }
  async get(owner: string, id: string) {
    await this.ready;
    return structuredClone(this.record(owner, id).snapshot);
  }
  async isLocalCopy(owner: string, id: string) {
    await this.ready;
    return Boolean(this.record(owner, id).localFile);
  }
  async list(owner: string, offset = 0, limit = 50) {
    await this.ready;
    return [...this.records.values()]
      .filter((r) => r.owner === owner && !this.admitting.has(r.snapshot.id))
      .sort((a, b) => b.snapshot.createdAt - a.snapshot.createdAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit)))
      .map((r) => structuredClone(r.snapshot));
  }
  private validateSource(source: DownloadSource) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new ResourceError('INVALID_ARGUMENT', '下载地址无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new ResourceError('INVALID_ARGUMENT', '仅支持 HTTP/HTTPS 下载地址');
    if (
      source.headers &&
      (typeof source.headers !== 'object' ||
        Object.values(source.headers).some((v) => typeof v !== 'string'))
    )
      throw new ResourceError('INVALID_ARGUMENT', '下载请求头无效');
    try {
      new Headers(source.headers);
    } catch {
      throw new ResourceError('INVALID_ARGUMENT', '下载请求头无效');
    }
  }
  async create(owner: string, options: DownloadOptions, localFile?: string, localRef?: FileRef) {
    return this.serial('create', () => this.createTask(owner, options, localFile, localRef));
  }
  private async createTask(
    owner: string,
    options: DownloadOptions,
    localFile?: string,
    localRef?: FileRef,
  ) {
    await this.ready;
    if (this.stopped) throw new ResourceError('PLUGIN_UNAVAILABLE', '下载服务正在关闭');
    for (const value of [options.name, options.sourceKey, options.idempotencyKey])
      if (value !== undefined && typeof value !== 'string')
        throw new ResourceError('INVALID_ARGUMENT', '任务名称和业务键必须是字符串');
    if (options.resume !== undefined && typeof options.resume !== 'boolean')
      throw new ResourceError('INVALID_ARGUMENT', '续传选项必须是布尔值');
    if (
      !options.target ||
      typeof options.target.directoryId !== 'string' ||
      typeof options.target.relativePath !== 'string'
    )
      throw new ResourceError('INVALID_ARGUMENT', '下载目标无效');
    if (!localFile) this.validateSource(options);
    for (const n of [
      options.expectedBytes,
      options.maxBytes,
      options.connectTimeoutMs,
      options.idleTimeoutMs,
    ])
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
        throw new ResourceError('INVALID_ARGUMENT', '下载预算必须是非负整数');
    if (
      options.checksum &&
      (options.checksum.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/i.test(options.checksum.value))
    )
      throw new ResourceError('INVALID_ARGUMENT', 'SHA-256 无效');
    if (options.conflict && !['fail', 'rename', 'replace'].includes(options.conflict))
      throw new ResourceError('INVALID_ARGUMENT', '文件冲突策略无效');
    await this.deps.resolve(owner, options.target);
    const { url, headers } = options;
    const safe: RecordData['options'] = {
      target: {
        directoryId: options.target.directoryId,
        relativePath: options.target.relativePath,
      },
      name: options.name,
      sourceKey: options.sourceKey,
      idempotencyKey: options.idempotencyKey,
      conflict: options.conflict,
      resume: options.resume,
      expectedBytes: options.expectedBytes,
      maxBytes: options.maxBytes,
      checksum: options.checksum
        ? { algorithm: 'sha256', value: options.checksum.value.toLowerCase() }
        : undefined,
      connectTimeoutMs: options.connectTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    };
    if (options.idempotencyKey) {
      const old = [...this.records.values()].find(
        (r) => r.owner === owner && r.options.idempotencyKey === options.idempotencyKey,
      );
      if (old) {
        if (JSON.stringify(old.options) !== JSON.stringify(safe))
          throw new ResourceError('INVALID_ARGUMENT', '重复任务参数不一致');
        if (old.snapshot.state === 'completed') {
          const stat = await fs.stat(old.final!).catch(() => null);
          if (!stat) throw new ResourceError('FILE_MISSING', '已下载的文件不存在');
          const hash = old.snapshot.result?.sha256 ?? old.options.checksum?.value;
          if (
            stat.size !== old.snapshot.receivedBytes ||
            (hash && (await hashFile(old.final!)) !== hash.toLowerCase())
          )
            throw new ResourceError('SOURCE_CHANGED', '已下载的文件已改变，请重新创建任务');
        }
        return structuredClone(old.snapshot);
      }
    }
    const queued = [...this.records.values()].filter((r) => !terminal.has(r.snapshot.state));
    if (queued.length >= 100 || queued.filter((r) => r.owner === owner).length >= 50)
      throw new ResourceError('QUEUE_FULL', '下载队列已满');
    const now = Date.now(),
      id = randomUUID();
    const r: RecordData = {
      version: 1,
      owner,
      options: safe,
      localFile,
      localRef,
      snapshot: {
        id,
        runId: 1,
        revision: 0,
        state: 'queued',
        name: options.name ?? path.basename(options.target.relativePath),
        sourceKey: options.sourceKey,
        target: options.target,
        receivedBytes: 0,
        createdAt: now,
        updatedAt: now,
        canPause: true,
        canResume: false,
        canRetry: false,
      },
    };
    this.records.set(id, r);
    this.admitting.add(id);
    if (!localFile) this.sources.set(id, { url, headers });
    try {
      await this.persist(r);
    } catch (error) {
      this.records.delete(id);
      this.sources.delete(id);
      this.writes.delete(id);
      await fs.rm(path.join(this.deps.root, `${id}.json`), { force: true }).catch(() => {});
      throw error;
    } finally {
      this.admitting.delete(id);
    }
    this.update(r, {});
    this.schedule();
    return structuredClone(r.snapshot);
  }
  private lastScheduledOwner?: string;
  private schedule() {
    if (this.stopped) return;
    const counts = new Map<string, number>();
    for (const id of this.active.keys()) {
      const owner = this.records.get(id)!.owner;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    while (this.active.size < 3) {
      const queued = [...this.records.values()].filter(
        (r) =>
          r.snapshot.state === 'queued' &&
          !this.active.has(r.snapshot.id) &&
          !this.admitting.has(r.snapshot.id),
      );
      const owners = [...new Set(queued.map((r) => r.owner))];
      const previous = owners.indexOf(this.lastScheduledOwner ?? '');
      const ordered = [...owners.slice(previous + 1), ...owners.slice(0, previous + 1)];
      const owner = ordered.find((id) => (counts.get(id) ?? 0) < 2);
      if (!owner) break;
      const r = queued.find((record) => record.owner === owner)!;
      this.lastScheduledOwner = owner;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      const id = r.snapshot.id;
      const work = this.run(r).finally(() => {
        this.active.delete(id);
        this.aborts.delete(id);
        this.intents.delete(id);
        this.schedule();
      });
      this.active.set(id, work);
      void work.catch(() => {});
    }
  }
  async control(
    owner: string,
    id: string,
    command: 'pause' | 'resume' | 'retry' | 'cancel' | 'interrupt',
    source?: DownloadSource,
  ) {
    return this.serial(id, () => this.controlTask(owner, id, command, source));
  }
  private async controlTask(
    owner: string,
    id: string,
    command: 'pause' | 'resume' | 'retry' | 'cancel' | 'interrupt',
    source?: DownloadSource,
  ) {
    await this.ready;
    if (this.stopped && ['resume', 'retry'].includes(command))
      throw new ResourceError('PLUGIN_UNAVAILABLE', '下载服务正在关闭');
    const r = this.record(owner, id);
    const s = r.snapshot;
    if (command === 'pause' && !s.canPause && s.state !== 'paused')
      throw new ResourceError('INVALID_STATE', '此状态不能暂停');
    if (['pause', 'cancel', 'interrupt'].includes(command)) {
      if (s.state === 'committing') {
        await this.active.get(id);
        return structuredClone(s);
      }
      const state =
        command === 'pause' ? 'paused' : command === 'cancel' ? 'canceled' : 'interrupted';
      if (s.state === 'completed' || s.state === 'canceled' || s.state === state)
        return structuredClone(s);
      this.intents.set(id, state);
      // A queued task must stop being eligible before waiting on an active transfer.
      if (!this.active.has(id)) this.update(r, { state });
      this.aborts.get(id)?.abort();
      await this.active.get(id);
      this.update(r, {
        state,
        error: undefined,
        bytesPerSecond: undefined,
        remainingSeconds: undefined,
      });
      if (state === 'canceled') {
        await this.clearPartial(r);
        this.sources.delete(id);
      }
      await this.persist(r);
      this.intents.delete(id);
      return structuredClone(s);
    }
    if (command === 'retry' ? s.state !== 'failed' : !['paused', 'interrupted'].includes(s.state))
      throw new ResourceError('INVALID_STATE', '此状态不能恢复');
    if (this.recoveredCopies.has(id))
      throw new ResourceError('INVALID_STATE', '复制任务在重启后需要重新创建');
    const queued = [...this.records.values()].filter(
      (record) => record.snapshot.id !== id && !terminal.has(record.snapshot.state),
    );
    if (queued.length >= 100 || queued.filter((record) => record.owner === owner).length >= 50)
      throw new ResourceError('QUEUE_FULL', '下载队列已满');
    if (source) {
      this.validateSource(source);
      this.sources.set(id, source);
    }
    if (!r.localFile && !this.sources.has(id))
      throw new ResourceError('SOURCE_AUTH_REQUIRED', '请重新提供下载地址');
    await this.deps.resolve(owner, r.options.target);
    if (command === 'retry') s.runId++;
    this.update(r, { state: 'queued', error: undefined });
    await this.persist(r);
    this.schedule();
    return structuredClone(s);
  }
  async remove(owner: string, id: string) {
    return this.serial(id, () => this.removeTask(owner, id));
  }
  private async removeTask(owner: string, id: string) {
    await this.ready;
    const r = this.record(owner, id);
    if (!terminal.has(r.snapshot.state) || r.snapshot.state === 'interrupted')
      throw new ResourceError('INVALID_STATE', '请先取消任务');
    await this.active.get(id);
    await this.clearPartial(r);
    await this.writes.get(id);
    await fs.rm(path.join(this.deps.root, `${id}.json`), { force: true });
    this.records.delete(id);
    this.sources.delete(id);
    this.writes.delete(id);
  }
  async interruptOwner(owner: string) {
    await this.ready;
    await Promise.all(
      [...this.records.values()]
        .filter(
          (r) =>
            r.owner === owner && !['completed', 'failed', 'canceled'].includes(r.snapshot.state),
        )
        .map((r) => this.control(owner, r.snapshot.id, 'interrupt')),
    );
  }
  async interruptDirectory(id: string) {
    await this.ready;
    await Promise.all(
      [...this.records.values()]
        .filter(
          (r) =>
            (r.options.target.directoryId === id ||
              (r.localRef?.kind === 'selected-file'
                ? r.localRef.fileId === id
                : r.localRef?.directoryId === id)) &&
            !['completed', 'failed', 'canceled'].includes(r.snapshot.state),
        )
        .map((r) => this.control(r.owner, r.snapshot.id, 'interrupt')),
    );
  }
  async removeOwner(owner: string) {
    await this.ready;
    for (const r of [...this.records.values()].filter((r) => r.owner === owner)) {
      if (!['completed', 'canceled'].includes(r.snapshot.state))
        await this.control(owner, r.snapshot.id, 'cancel');
      await this.remove(owner, r.snapshot.id);
    }
  }
  async shutdown() {
    this.stopped = true;
    await this.ready;
    await Promise.all(
      [...new Set([...this.records.values()].map((r) => r.owner))].map((owner) =>
        this.interruptOwner(owner),
      ),
    );
    await Promise.all(this.active.values());
    await Promise.all(this.writes.values());
  }
  async wait(owner: string, id: string) {
    await this.ready;
    const initial = this.record(owner, id).snapshot;
    const run = initial.runId;
    return new Promise<DownloadSnapshot>((resolve, reject) => {
      const check = (_owner: string, s: DownloadSnapshot) => {
        if (_owner !== owner || s.id !== id) return;
        if (s.runId !== run || terminal.has(s.state)) {
          stop();
          if (s.state === 'completed' && s.runId === run) resolve(s);
          else
            reject(
              new ResourceError(
                s.error?.code ?? 'NETWORK_INTERRUPTED',
                s.error?.message ?? '下载已中断',
                true,
              ),
            );
        }
      };
      const stop = this.subscribe(check);
      check(owner, initial);
    });
  }
  private async response(r: RecordData, offset: number, controller: AbortController) {
    if (r.localFile) {
      if (r.localRef && (await this.deps.resolveSource?.(r.owner, r.localRef)) !== r.localFile)
        throw new ResourceError('GRANT_REQUIRED', '复制来源授权已失效');
      const stat = await fs.stat(r.localFile);
      return new Response(
        Readable.toWeb(
          createReadStream(r.localFile, { signal: controller.signal }),
        ) as ReadableStream,
        { headers: { 'content-length': String(stat.size) } },
      );
    }
    const source = this.sources.get(r.snapshot.id);
    if (!source) throw new ResourceError('SOURCE_AUTH_REQUIRED', '请重新提供下载地址');
    let url = source.url;
    let headers = new Headers(source.headers);
    headers.delete('Range');
    headers.delete('If-Range');
    headers.delete('Host');
    headers.delete('Content-Length');
    headers.set('Accept-Encoding', 'identity');
    if (offset) {
      headers.set('Range', `bytes=${offset}-`);
      const validator = r.etag ?? r.modified;
      if (validator) headers.set('If-Range', validator);
    }
    for (let i = 0; i <= 5; i++) {
      const response = await this.deps.fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'manual',
        credentials: 'omit',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new ResourceError('HTTP_ERROR', '重定向地址缺失');
      const next = new URL(location, url);
      this.validateSource({ url: next.href });
      if (next.origin !== new URL(url).origin) {
        const clean = new Headers();
        for (const key of ['accept', 'accept-encoding', 'range', 'if-range'])
          if (headers.has(key)) clean.set(key, headers.get(key)!);
        headers = clean;
      }
      url = next.href;
    }
    throw new ResourceError('HTTP_ERROR', '重定向次数过多');
  }
  private async run(r: RecordData) {
    const s = r.snapshot,
      o = r.options,
      id = s.id,
      controller = new AbortController();
    this.aborts.set(id, controller);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = await this.deps.resolve(r.owner, o.target);
      await target.validate();
      if (controller.signal.aborted) throw new ResourceError('NETWORK_INTERRUPTED', '下载中断');
      if (
        r.temp &&
        !(await fs.lstat(r.temp).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        }))
      )
        r.temp = undefined;
      if (!r.temp) {
        r.temp = path.join(path.dirname(target.path), `.echo-${id}.part`);
        const file = await fs.open(r.temp, 'wx');
        r.inode = size(await file.stat());
        await file.close();
        await this.persist(r);
      }
      const tempStat = await fs.lstat(r.temp);
      if (tempStat.isSymbolicLink() || size(tempStat) !== r.inode)
        throw new ResourceError('PATH_OUTSIDE_ROOT', '临时文件身份改变');
      let offset =
        o.resume !== false && !r.localFile && (r.etag || r.modified || o.checksum)
          ? tempStat.size
          : 0;
      this.update(r, { state: 'connecting', receivedBytes: offset });
      timer = setTimeout(
        () => controller.abort(new ResourceError('NETWORK_TIMEOUT', '连接超时', true)),
        o.connectTimeoutMs ?? 30000,
      );
      response = await this.response(r, offset, controller);
      clearTimeout(timer);
      if (offset && response.status === 416 && !(o.checksum && tempStat.size === o.expectedBytes)) {
        await response.body?.cancel();
        offset = 0;
        timer = setTimeout(
          () => controller.abort(new ResourceError('NETWORK_TIMEOUT', '连接超时', true)),
          o.connectTimeoutMs ?? 30000,
        );
        response = await this.response(r, 0, controller);
        clearTimeout(timer);
      }
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity')
        throw new ResourceError('HTTP_ERROR', '下载端点必须返回未压缩文件');
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (offset && response.status === 416 && o.checksum && tempStat.size === o.expectedBytes) {
        await response.body?.cancel();
        response = undefined;
      } else {
        if (response.status === 200) offset = 0;
        else if (
          response.status === 206 &&
          offset &&
          range &&
          Number(range[1]) === offset &&
          Number(range[2]) >= offset &&
          Number(range[3]) > Number(range[2])
        ) {
          if (s.totalBytes !== undefined && s.totalBytes !== Number(range[3]))
            throw new ResourceError('SOURCE_CHANGED', '文件大小已改变');
          if (
            (r.etag && response.headers.get('etag') !== r.etag) ||
            (!r.etag && r.modified && response.headers.get('last-modified') !== r.modified)
          )
            throw new ResourceError('SOURCE_CHANGED', '续传文件校验标识已改变');
        } else
          throw new ResourceError(
            response.status === 401 || response.status === 403
              ? 'SOURCE_AUTH_REQUIRED'
              : 'HTTP_ERROR',
            `下载响应错误 (${response.status})`,
            true,
          );
        const rawLength = response.headers.get('content-length');
        const total =
          response.status === 206
            ? Number(range![3])
            : rawLength === null
              ? undefined
              : Number(rawLength);
        if (total !== undefined && (!Number.isSafeInteger(total) || total < 0))
          throw new ResourceError('HTTP_ERROR', '文件长度无效');
        if (o.maxBytes !== undefined && total !== undefined && total > o.maxBytes)
          throw new ResourceError('SIZE_LIMIT', '下载文件超过大小限制');
        const etag = response.headers.get('etag');
        r.etag = etag && !etag.startsWith('W/') ? etag : undefined;
        r.modified = response.headers.get('last-modified') ?? undefined;
        this.update(r, { state: 'downloading', totalBytes: total, receivedBytes: offset });
        handle = await fs.open(r.temp, offset ? 'a' : 'w');
        await this.persist(r);
        const reader = response.body?.getReader();
        if (!reader) throw new ResourceError('HTTP_ERROR', '响应体为空');
        let lastEvent = Date.now(),
          lastSave = Date.now(),
          progressAt = Date.now(),
          progressBytes = offset;
        try {
          while (true) {
            timer = setTimeout(
              () => controller.abort(new ResourceError('NETWORK_TIMEOUT', '传输超时', true)),
              o.idleTimeoutMs ?? 60000,
            );
            const chunk = await reader.read();
            clearTimeout(timer);
            if (controller.signal.aborted) throw controller.signal.reason;
            if (chunk.done) break;
            if (o.maxBytes !== undefined && s.receivedBytes + chunk.value.byteLength > o.maxBytes)
              throw new ResourceError('SIZE_LIMIT', '下载文件超过大小限制');
            await handle.writeFile(chunk.value);
            s.receivedBytes += chunk.value.byteLength;
            const now = Date.now();
            if (now - lastEvent >= 200) {
              const speed =
                ((s.receivedBytes - progressBytes) * 1000) / Math.max(1, now - progressAt);
              this.update(r, {
                bytesPerSecond: speed,
                remainingSeconds:
                  total !== undefined && speed
                    ? Math.max(0, total - s.receivedBytes) / speed
                    : undefined,
              });
              lastEvent = now;
            }
            if (now - lastSave >= 1000) {
              await this.persist(r);
              lastSave = now;
              progressAt = now;
              progressBytes = s.receivedBytes;
            }
          }
        } finally {
          clearTimeout(timer);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (total !== undefined && s.receivedBytes !== total)
          throw new ResourceError('SIZE_MISMATCH', '下载文件长度不匹配', true);
      }
      if (o.expectedBytes !== undefined && s.receivedBytes !== o.expectedBytes)
        throw new ResourceError('SIZE_MISMATCH', '文件大小与预期不一致');
      this.update(r, { state: 'verifying' });
      await this.persist(r);
      const hash = await hashFile(r.temp, controller.signal);
      if (o.checksum && hash !== o.checksum.value.toLowerCase()) {
        await this.clearPartial(r);
        throw new ResourceError('CHECKSUM_MISMATCH', '文件校验失败', true);
      }
      await target.commit(async () => {
        if (controller.signal.aborted) throw new ResourceError('NETWORK_INTERRUPTED', '下载中断');
        await target.validate();
        this.update(r, { state: 'committing' });
        r.final = await commitFile(
          r.temp!,
          target.path,
          o.conflict ?? 'fail',
          async (candidate) => {
            r.final = candidate;
            await this.persist(r);
          },
        );
        r.temp = undefined;
        const file = {
          kind: 'directory-file' as const,
          directoryId: o.target.directoryId,
          relativePath: path.join(path.dirname(o.target.relativePath), path.basename(r.final)),
        };
        this.update(r, {
          state: 'completed',
          result: { taskId: id, file, bytes: s.receivedBytes, sha256: hash },
          bytesPerSecond: undefined,
          remainingSeconds: undefined,
        });
        await this.persist(r);
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = undefined;
      await response?.body?.cancel().catch(() => {});
      response = undefined;
      const intent = this.intents.get(id);
      const cause =
        controller.signal.aborted && controller.signal.reason instanceof ResourceError
          ? controller.signal.reason
          : error;
      if (cause instanceof ResourceError && cause.code === 'SOURCE_CHANGED') {
        await this.clearPartial(r);
        r.etag = undefined;
        r.modified = undefined;
      }
      if (s.state === 'completed') return; // File commit succeeded; a later checkpoint failure must not report a failed transfer.
      this.update(r, {
        state: intent ?? 'failed',
        error: intent ? undefined : resourceError(cause),
        bytesPerSecond: undefined,
        remainingSeconds: undefined,
      });
      await this.persist(r);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => {});
      await handle?.close().catch(() => {});
    }
  }
}
