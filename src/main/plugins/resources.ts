import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  EchoPluginDescriptor,
  PluginListFilesOptions,
  PluginReadTextFileOptions,
  PluginReadFileBytesOptions,
  PluginWriteFileOptions,
  PluginWriteFileData,
} from '../../shared/plugins';
import type {
  DirectoryRef,
  DirectoryRequest,
  FilesRequest,
  FileRef,
  DownloadTarget,
  ResourceMethod,
  PluginFileGrantGroup,
} from '../../shared/pluginFiles';
import type { DownloadOptions, DownloadSource } from '../../shared/pluginDownloads';
import { FileGrants } from './fileGrants';
import { DownloadEngine } from '../downloads/engine';
import { atomicJson, commitFile, ResourceError, safePath } from '../downloads/files';
import { readAudioMetadata } from '../media/audioMetadata';

const pluginOrigin = (plugin: EchoPluginDescriptor) =>
  JSON.stringify(
    plugin.installSource?.kind === 'marketplace'
      ? {
          kind: 'marketplace',
          source: plugin.installSource.id,
          origin: plugin.installSource.origin ?? plugin.installSource.url,
        }
      : { kind: 'local', directory: plugin.directory },
  );

export class PluginResources {
  readonly grants: FileGrants;
  readonly downloads: DownloadEngine;
  private identities: Record<string, { origin: string; owner: string }> = {};
  private identityQueue = Promise.resolve();
  private ready: Promise<void>;
  private packagesReady: Promise<void>;
  private media = new Map<
    string,
    {
      owner: string;
      pluginId: string;
      contextKey?: string;
      ref: FileRef;
      validate: () => void;
      aborts: Set<AbortController>;
    }
  >();
  constructor(
    private deps: {
      root: string;
      fetch: (url: string, init: RequestInit) => Promise<Response>;
      find: (id: string) => EchoPluginDescriptor | null;
      current: (p: EchoPluginDescriptor) => boolean;
      selectDirectory: (
        plugin: EchoPluginDescriptor,
        request: DirectoryRequest,
      ) => Promise<string | undefined>;
      selectFiles: (plugin: EchoPluginDescriptor, request: FilesRequest) => Promise<string[]>;
    },
  ) {
    this.grants = new FileGrants(path.join(deps.root, 'plugin-file-grants'));
    this.ready = fs
      .readFile(path.join(deps.root, 'plugin-file-grants', 'identities.json'), 'utf8')
      .then((text) => {
        this.identities = JSON.parse(text);
      })
      .catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    void this.ready.catch(() => {});
    this.downloads = new DownloadEngine({
      root: path.join(deps.root, 'plugin-transfers'),
      fetch: deps.fetch,
      resolveSource: async (owner, ref) => (await this.grants.resolve(owner, ref)).path,
      resolve: async (owner, target) => {
        if (owner === 'host:plugin-installer') {
          const root = path.join(deps.root, 'plugin-package-downloads');
          await fs.mkdir(root, { recursive: true });
          const file = await safePath(root, target.relativePath, true);
          return { path: file, validate: async () => {}, commit: (fn) => fn() };
        }
        const identity = Object.entries(this.identities).find(([, entry]) => entry.owner === owner);
        if (!identity) throw new ResourceError('PLUGIN_UNAVAILABLE', '插件安装身份失效');
        const capture = await this.capture(identity[0]);
        if (capture.owner !== owner)
          throw new ResourceError('PLUGIN_UNAVAILABLE', '插件来源已经变化');
        const file = { kind: 'directory-file' as const, ...target };
        const resolved = await this.grants.resolve(owner, file, true);
        return {
          path: resolved.path,
          validate: async () => {
            capture.validate();
            await this.grants.resolve(owner, file, true);
          },
          commit: (fn) => this.grants.locked(fn),
        };
      },
    });
    this.packagesReady = this.cleanPackages();
    void this.packagesReady.catch(() => {});
    this.grants.onRevoke(async (id) => {
      this.releaseMatching((m) =>
        m.ref.kind === 'selected-file' ? m.ref.fileId === id : m.ref.directoryId === id,
      );
      await this.downloads.interruptDirectory(id);
    });
  }
  async capture(id: string, download = false) {
    await this.ready;
    const plugin = this.deps.find(id);
    if (!plugin || plugin.id !== id || !this.deps.current(plugin))
      throw new ResourceError('PLUGIN_UNAVAILABLE', '插件未启用或已失效');
    if (
      plugin.manifest.capabilities?.localFiles !== true ||
      (download && plugin.manifest.capabilities?.downloads !== true)
    )
      throw new ResourceError('CAPABILITY_REQUIRED', '插件未声明所需文件/下载能力');
    const origin = pluginOrigin(plugin);
    const allocation = this.identityQueue.then(async () => {
      if (!this.deps.current(plugin))
        throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
      let identity = this.identities[id];
      if (!identity || identity.origin !== origin) {
        identity = { origin, owner: randomUUID() };
        const candidate = { ...this.identities, [id]: identity };
        await atomicJson(
          path.join(this.deps.root, 'plugin-file-grants', 'identities.json'),
          candidate,
        );
        this.identities = candidate;
      }
      return identity;
    });
    this.identityQueue = allocation.then(
      () => {},
      () => {},
    );
    const identity = await allocation;
    if (!this.deps.current(plugin))
      throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
    return {
      plugin,
      owner: identity.owner,
      validate: () => {
        if (!this.deps.current(plugin))
          throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
      },
    };
  }
  async revoke(ids: string[]) {
    await this.ready;
    for (const id of ids) {
      this.releaseMatching((m) => m.pluginId === id);
      const owner = this.identities[id]?.owner;
      if (owner) await this.downloads.interruptOwner(owner);
    }
  }
  async uninstall(id: string, removeData = false) {
    await this.ready;
    await this.identityQueue;
    const owner = this.identities[id]?.owner;
    if (owner) {
      await this.downloads.removeOwner(owner);
      await this.grants.removeOwner(owner);
      await fs.rm(path.join(this.deps.root, 'plugin-cache', owner), {
        recursive: true,
        force: true,
      });
    }
    if (removeData && owner) {
      await fs.rm(path.join(this.deps.root, 'plugin-data', owner), {
        recursive: true,
        force: true,
      });
      delete this.identities[id];
    }
    await atomicJson(
      path.join(this.deps.root, 'plugin-file-grants', 'identities.json'),
      this.identities,
    );
  }
  async manageGrants(id: string) {
    await this.ready;
    if (!this.identities[id]) return [];
    const grants = await this.grants.listAll(this.identities[id].owner);
    return grants.filter((grant) => grant.kind === 'user' || grant.kind === 'file');
  }
  async manageAllGrants(): Promise<PluginFileGrantGroup[]> {
    await this.ready;
    const groups = await Promise.all(
      Object.keys(this.identities).map(async (pluginId) => {
        const plugin = this.deps.find(pluginId);
        if (!plugin) return null;
        const grants = await this.manageGrants(pluginId);
        return grants.length ? { pluginId, pluginName: plugin.name, grants } : null;
      }),
    );
    return groups.filter((group): group is PluginFileGrantGroup => group !== null);
  }
  async manageRevoke(id: string, grantId: string) {
    await this.ready;
    const owner = this.identities[id]?.owner;
    if (!owner) throw new ResourceError('GRANT_REQUIRED', '授权不存在');
    if (!(await this.manageGrants(id)).some((grant) => grant.id === grantId))
      throw new ResourceError('GRANT_REQUIRED', '该文件或目录不属于用户授权');
    await this.grants.revoke(owner, grantId);
  }
  async manageRemove(id: string, grantId: string) {
    await this.ready;
    const owner = this.identities[id]?.owner;
    if (!owner) throw new ResourceError('GRANT_REQUIRED', '授权不存在');
    await this.grants.removeRevoked(owner, grantId);
  }
  async manageReauthorize(id: string, grantId: string) {
    await this.ready;
    const identity = this.identities[id];
    const plugin = this.deps.find(id);
    const validate = () => {
      if (
        !plugin ||
        plugin.id !== id ||
        this.deps.find(id) !== plugin ||
        this.identities[id] !== identity ||
        (identity && identity.origin !== pluginOrigin(plugin))
      )
        throw new ResourceError('PLUGIN_UNAVAILABLE', '插件已变化，请刷新后重试');
      if (plugin.manifest.capabilities?.localFiles !== true)
        throw new ResourceError('CAPABILITY_REQUIRED', '插件未声明本地文件能力');
    };
    validate();
    if (!identity) throw new ResourceError('GRANT_REQUIRED', '授权不存在');
    const grant = await this.grants.revokedSelection(identity.owner, grantId);
    const purpose = '重新授权';
    const chosen =
      grant.kind === 'file'
        ? (
            await this.deps.selectFiles(plugin!, {
              purpose,
              persist: grant.persist,
              multiple: false,
            })
          )[0]
        : await this.deps.selectDirectory(plugin!, {
            purpose,
            persist: grant.persist,
            access: grant.access,
          });
    if (!chosen) return;
    validate();
    await this.grants.reauthorizeRevoked(identity.owner, grantId, chosen, grant.revision, validate);
  }
  private async cleanPackages() {
    const owner = 'host:plugin-installer';
    for (;;) {
      const tasks = await this.downloads.list(owner);
      if (!tasks.length) return;
      for (const task of tasks) {
        await this.downloads.control(owner, task.id, 'cancel');
        const file = await safePath(
          path.join(this.deps.root, 'plugin-package-downloads'),
          task.target.relativePath,
        ).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (file) await fs.rm(file, { force: true });
        await this.downloads.remove(owner, task.id);
      }
    }
  }
  async downloadPackage(
    url: string,
    pluginId: string,
    destination: string,
    maxBytes: number,
    checksum?: string,
  ) {
    await this.packagesReady;
    const owner = 'host:plugin-installer';
    const expected = checksum
      ?.replace(/^sha256:/i, '')
      .trim()
      .toLowerCase();
    if (expected && !/^[a-f0-9]{64}$/.test(expected))
      throw new ResourceError('INVALID_ARGUMENT', '插件校验和无效');
    const s = await this.downloads.create(owner, {
      url,
      headers: {
        Accept: 'application/zip,application/octet-stream,*/*',
        'User-Agent': 'EchoMusic-Plugin-Marketplace',
      },
      name: `安装 ${pluginId}`,
      sourceKey: pluginId,
      target: { directoryId: owner, relativePath: `${randomUUID()}.zip` },
      maxBytes,
      checksum: expected ? { algorithm: 'sha256', value: expected } : undefined,
    });
    let file: string | undefined;
    try {
      const result = await this.downloads.wait(owner, s.id);
      file = await safePath(
        path.join(this.deps.root, 'plugin-package-downloads'),
        result.result!.file.kind === 'directory-file' ? result.result!.file.relativePath : '',
      );
      await fs.copyFile(file, destination);
      await fs.rm(file, { force: true });
      return destination;
    } finally {
      if (file) await fs.rm(file, { force: true });
      await this.downloads.remove(owner, s.id);
    }
  }
  private releaseMatching(
    predicate: (lease: {
      owner: string;
      pluginId: string;
      ref: FileRef;
      contextKey?: string;
    }) => boolean,
  ) {
    for (const [id, m] of this.media)
      if (predicate(m)) {
        for (const a of m.aborts) a.abort();
        this.media.delete(id);
      }
  }
  releaseContext(contextKey: string) {
    this.releaseMatching((lease) => lease.contextKey === contextKey);
  }
  async mediaResponse(request: Request) {
    const id = new URL(request.url).hostname;
    const lease = this.media.get(id);
    if (!lease || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    try {
      lease.validate();
      const file = await this.grants.resolve(lease.owner, lease.ref);
      const stat = await fs.stat(file.path);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      let start = 0,
        end = stat.size - 1,
        partial = false;
      const raw = request.headers.get('range');
      if (raw) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
        if (!match || (!match[1] && !match[2]))
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          });
        start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        partial = true;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= stat.size
        )
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          });
      }
      const mime: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
      };
      const headers: Record<string, string> = {
        'Content-Type': mime[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(Math.max(0, end - start + 1)),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      if (request.method === 'HEAD' || !stat.size)
        return new Response(null, { status: partial ? 206 : 200, headers });
      const controller = new AbortController();
      lease.aborts.add(controller);
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      const stream = createReadStream(file.path, {
        start,
        end,
        signal: controller.signal,
        highWaterMark: 256 * 1024,
      });
      stream.once('close', () => {
        lease.aborts.delete(controller);
        request.signal.removeEventListener('abort', abort);
      });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: partial ? 206 : 200,
        headers,
      });
    } catch {
      return new Response(null, { status: 403 });
    }
  }
  async call(
    id: string,
    method: ResourceMethod,
    input: unknown = {},
    expectedPlugin?: EchoPluginDescriptor,
    contextKey?: string,
  ) {
    const c = await this.capture(id, method === 'download');
    if (expectedPlugin && c.plugin !== expectedPlugin)
      throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
    const p = input as Record<string, unknown>;
    const ref = p.ref as FileRef;
    if (
      ['downloadResume', 'downloadRetry'].includes(method) &&
      !(await this.downloads.isLocalCopy(c.owner, p.id as string))
    )
      await this.capture(id, true);
    const operation = async () => {
      switch (method) {
        case 'requestDirectory':
        case 'reauthorizeDirectoryGrant': {
          const request = (p.request ?? p) as unknown as DirectoryRequest;
          if (
            !['read', 'read-write'].includes(request.access) ||
            typeof request.purpose !== 'string' ||
            !request.purpose.trim()
          )
            throw new ResourceError('INVALID_ARGUMENT', '请选择访问模式并提供用途');
          const chosen = await this.deps.selectDirectory(c.plugin, request);
          c.validate();
          if (!chosen) return { canceled: true };
          const directory = await this.grants.create(
            c.owner,
            chosen,
            request.access,
            request.persist !== false,
            false,
            p.id as string | undefined,
          );
          return { canceled: false, directory };
        }
        case 'requestFiles': {
          const request = p as unknown as FilesRequest;
          if (!request.purpose?.trim()) throw new ResourceError('INVALID_ARGUMENT', '请选择用途');
          const chosen = await this.deps.selectFiles(c.plugin, request);
          c.validate();
          if (!chosen.length) return { canceled: true };
          const files = await Promise.all(
            chosen.map((file) =>
              this.grants.create(c.owner, file, 'read', request.persist !== false, true),
            ),
          );
          return { canceled: false, files };
        }
        case 'listDirectoryGrants':
          return this.grants.list(c.owner);
        case 'revokeDirectoryGrant':
        case 'revokeFileGrant':
          await this.grants.revoke(c.owner, p.id as string);
          return true;
        case 'getPrivateDirectory':
          return this.grants.privateDirectory(c.owner, p.kind as 'data' | 'cache');
        case 'download':
          return this.downloads.create(c.owner, p as unknown as DownloadOptions);
        case 'downloadList':
          return this.downloads.list(c.owner, p.offset as number, p.limit as number);
        case 'downloadGet':
          return this.downloads.get(c.owner, p.id as string);
        case 'downloadPause':
        case 'downloadResume':
        case 'downloadRetry':
        case 'downloadCancel':
          return this.downloads.control(
            c.owner,
            p.id as string,
            method.slice(8).toLowerCase() as 'pause' | 'resume' | 'retry' | 'cancel',
            p.source as DownloadSource | undefined,
          );
        case 'downloadRemove':
          await this.downloads.remove(c.owner, p.id as string);
          return true;
        case 'releaseMedia': {
          const lease = this.media.get(p.id as string);
          if (lease?.owner === c.owner) this.releaseMatching((m) => m === lease);
          return true;
        }
        case 'openMedia': {
          await this.grants.resolve(c.owner, ref);
          const leaseId = randomUUID();
          this.media.set(leaseId, {
            owner: c.owner,
            pluginId: id,
            contextKey,
            ref,
            validate: c.validate,
            aborts: new Set(),
          });
          return { id: leaseId, url: `echo-plugin-media://${leaseId}/media` };
        }
        case 'copyFile': {
          const source = await this.grants.resolve(c.owner, p.source as FileRef);
          return this.downloads.create(
            c.owner,
            {
              url: '',
              target: p.target as DownloadTarget,
              conflict: (p.conflict ?? 'fail') as 'fail' | 'rename' | 'replace',
              resume: false,
              name: path.basename(source.path),
            },
            source.path,
            p.source as FileRef,
          );
        }
        case 'listFiles': {
          const root = await this.grants.directory(c.owner, (p.directory as DirectoryRef).id);
          const options = (p.options ?? {}) as PluginListFilesOptions;
          const files: {
            name: string;
            relativePath: string;
            file: FileRef;
            size: number;
            modifiedAt: number;
            kind: string;
            extension: string;
          }[] = [];
          const max = Math.min(10000, Math.max(1, options.limit ?? 1000));
          let reached = false;
          const walk = async (relative: string, depth: number) => {
            for (const item of await fs.readdir(path.join(root, relative), {
              withFileTypes: true,
            })) {
              c.validate();
              if (files.length >= max) {
                reached = true;
                return;
              }
              if (item.isSymbolicLink() || (!options.includeHidden && item.name.startsWith('.')))
                continue;
              const name = path.join(relative, item.name);
              if (item.isDirectory()) {
                if (options.recursive && depth < Math.min(options.maxDepth ?? 32, 64))
                  await walk(name, depth + 1);
                continue;
              }
              if (!item.isFile()) continue;
              const stat = await fs.stat(
                await this.grants
                  .resolve(c.owner, {
                    kind: 'directory-file',
                    directoryId: (p.directory as DirectoryRef).id,
                    relativePath: name,
                  })
                  .then((x) => x.path),
              );
              const extension = path.extname(name).toLowerCase();
              const kind = /\.(mp4|webm|mov|mkv|m4v)$/i.test(name)
                ? 'video'
                : /\.(png|jpg|jpeg|webp|gif)$/i.test(name)
                  ? 'image'
                  : /\.(mp3|flac|wav|m4a|ogg|aac|opus)$/i.test(name)
                    ? 'audio'
                    : 'other';
              if (
                options.extensions?.length &&
                !options.extensions.some(
                  (e) => `.${e.replace(/^\./, '').toLowerCase()}` === extension,
                )
              )
                continue;
              if (options.kinds?.length && !options.kinds.includes(kind as never)) continue;
              files.push({
                name: item.name,
                relativePath: name,
                file: {
                  kind: 'directory-file',
                  directoryId: (p.directory as DirectoryRef).id,
                  relativePath: name,
                },
                size: stat.size,
                modifiedAt: stat.mtimeMs,
                kind,
                extension,
              });
            }
          };
          await walk('', 0);
          return { files, limitReached: reached };
        }
        default: {
          const write = ['writeFile', 'deleteFile', 'mkdir'].includes(method);
          const resolved = await this.grants.resolve(c.owner, ref, write);
          const file = resolved.path;
          if (method === 'stat') {
            const s = await fs.stat(file);
            return {
              file: ref,
              name: path.basename(file),
              size: s.size,
              modifiedAt: s.mtimeMs,
              directory: s.isDirectory(),
            };
          }
          if (method === 'mkdir') {
            await fs.mkdir(file, { recursive: true });
            return true;
          }
          if (method === 'deleteFile') {
            const s = await fs.lstat(file).catch((e) => {
              if (e.code === 'ENOENT') return null;
              throw e;
            });
            if (s && !s.isFile()) throw new ResourceError('INVALID_ARGUMENT', '只能删除文件');
            await fs.rm(file, { force: true });
            return true;
          }
          if (method === 'readAudioMetadata') return readAudioMetadata(file);
          if (method === 'readTextFile' || method === 'readFileBytes') {
            const options = (p.options ?? {}) as PluginReadFileBytesOptions &
              PluginReadTextFileOptions;
            for (const n of [options.offset, options.length, options.maxBytes])
              if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
                throw new ResourceError('INVALID_ARGUMENT', '读取范围必须为非负安全整数');
            const stat = await fs.stat(file);
            const offset = Math.max(0, Math.min(stat.size, Math.trunc(options.offset ?? 0)));
            const length = Math.max(
              0,
              Math.min(
                stat.size - offset,
                options.length ?? Infinity,
                options.maxBytes ?? 1024 * 1024,
                4 * 1024 * 1024,
              ),
            );
            const bytes = Buffer.alloc(length);
            const handle = await fs.open(file, 'r');
            let read;
            try {
              read = await handle.read(bytes, 0, length, offset);
            } finally {
              await handle.close();
            }
            const data = bytes.subarray(0, read.bytesRead);
            return {
              file: ref,
              size: stat.size,
              bytesRead: read.bytesRead,
              truncated: offset + read.bytesRead < stat.size,
              ...(method === 'readTextFile'
                ? { content: data.toString((options.encoding ?? 'utf8') as BufferEncoding) }
                : { data: Uint8Array.from(data).buffer }),
            };
          }
          if (method === 'writeFile') {
            const options = (p.options ?? {}) as PluginWriteFileOptions;
            const data = p.data as PluginWriteFileData;
            const buffer =
              typeof data === 'string'
                ? Buffer.from(data, (options.encoding ?? 'utf8') as BufferEncoding)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : ArrayBuffer.isView(data)
                    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                    : data?.type === 'base64'
                      ? Buffer.from(data.data, 'base64')
                      : null;
            if (!buffer || buffer.length > 8 * 1024 * 1024)
              throw new ResourceError('SIZE_LIMIT', '单次写入最多 8 MiB');
            const temp = path.join(path.dirname(file), `.echo-${randomUUID()}.part`);
            await fs.writeFile(temp, buffer, { flag: 'wx' });
            try {
              c.validate();
              await this.grants.resolve(c.owner, ref, true);
              await commitFile(temp, file, options.overwrite ? 'replace' : 'fail');
            } finally {
              await fs.rm(temp, { force: true });
            }
            return { file: ref, bytesWritten: buffer.length };
          }
          throw new ResourceError('INVALID_ARGUMENT', '未知插件资源操作');
        }
      }
    };
    // Long-lived operations manage their own commit locks; small mutations serialize with revoke.
    return ['writeFile', 'deleteFile', 'mkdir'].includes(method)
      ? this.grants.locked(operation)
      : operation();
  }
}

let service: PluginResources | undefined;
export const setPluginResources = (value: PluginResources) => {
  service = value;
};
export const getPluginResources = () => {
  if (!service) throw new ResourceError('PLUGIN_UNAVAILABLE', '文件服务尚未初始化');
  return service;
};
export const peekPluginResources = () => service;
