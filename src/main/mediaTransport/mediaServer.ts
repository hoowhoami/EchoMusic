/**
 * EchoMusic DLNA 媒体中转 —— 宿主会话范围的 LAN HTTP 服务。
 *
 * 职责（design §5、§7）：
 * - GET/HEAD、Range、206/416、Content-Length/Content-Range、正确 Content-Type、背压。
 * - 不可猜测、可撤销的会话 token；活动会话内支持重连与重复 Range。
 * - 仅暴露当前歌曲与确有需要的下一首资源；无目录遍历、无任意 URL 代理、无整库公开。
 * - 选定出口网卡；局域网连接不走公网 HTTP 代理。
 * - 本地文件、loopback URL、需要请求头/凭证的源 → 宿主原样中转；允许按设备能力直连。
 * - 不改变媒体数据内容、编码与前级音效。
 *
 * 设计为无 Electron 依赖，便于 node --test 直接验证 Range/取消/清理。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type MediaSource =
  | {
      kind: 'file';
      path: string;
    }
  | {
      kind: 'http';
      url: string;
      headers?: Record<string, string>;
    };

export interface MediaResource {
  resourceId: string;
  source: MediaSource;
  mime: string | null;
  length: number | null;
  /** 会话绑定的输出会话标识；session 结束后令牌随之下线 */
  sessionId: string;
  title?: string;
  artist?: string;
  album?: string;
}

export interface MediaServerOptions {
  /** LAN 绑定地址（选定网卡）。默认读取首个私有 IPv4。 */
  bindHost?: string;
  port?: number;
  /** 单资源 token 长度字节数 */
  tokenBytes?: number;
  /** 流高位水位 */
  highWaterMark?: number;
  /** 日志 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 可注入的网卡地址提供者（测试/多网卡） */
  addressProvider?: () => string[];
  /** 上游 401/403/410：音源可能已过期，宿主提示按既有流程重取，不在这里改写媒体。 */
  onUpstreamStatus?: (status: number, url: string) => void;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.ape': 'audio/x-ape',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
};

interface Ipv4Candidate {
  address: string;
  /** 网卡名。注入 provider 时为空，表示调用方已自行选定。 */
  name: string;
}

/**
 * 虚拟网卡名特征。Hyper-V / WSL / VMware / VirtualBox / Docker 的适配器常带私网段
 * 地址且在 `os.networkInterfaces()` 中排在物理网卡之前，选中它们会让中转地址对
 * 局域网内的设备不可达。仅按名字排除，不靠顺序或地址段猜测。
 */
const VIRTUAL_IFACE_PATTERNS =
  /vEthernet|hyper-v|hyperv|vmware|virtualbox|vbox|^loopback|^ws-?l|wsl|docker|virbr|zerotier|tailscale|^tap-|^tun\d|tunnel/i;

function listIpv4Addresses(provider?: () => string[]): Ipv4Candidate[] {
  if (provider) {
    try {
      return provider()
        .filter((addr) => /\d+\.\d+\.\d+\.\d+/.test(addr))
        .map((address) => ({ address, name: '' }));
    } catch {
      return [];
    }
  }
  const addrs: Ipv4Candidate[] = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces() ?? {})) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4') addrs.push({ address: iface.address, name });
    }
  }
  return addrs;
}

function isPrivateIpv4(addr: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (addr.startsWith('127.')) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 选定用于媒体中转与 GENA 回调的局域网地址。
 *
 * 排序策略：物理网卡优先于虚拟网卡；同类候选中取私网段地址。物理网卡一个都没有
 * 时才退回虚拟网卡，避免多网卡机器（如 Hyper-V 默认交换机 172.26.x.x 抢在 WLAN
 * 192.168.x.x 之前）产出局域网设备无法访问的中转地址。
 */
export function pickLanIpv4(provider?: () => string[]): string {
  const candidates = listIpv4Addresses(provider).filter((c) => isPrivateIpv4(c.address));
  const physical = candidates.find((c) => !VIRTUAL_IFACE_PATTERNS.test(c.name));
  return (physical ?? candidates[0])?.address ?? '127.0.0.1';
}

export interface RangeRequest {
  start: number;
  end: number;
}

/** 解析单段 Range：bytes=start-end / bytes=start- / bytes=-suffix。 */
export function parseRange(
  header: string | undefined,
  length: number | null,
): { range: RangeRequest | null; unsatisfiable: boolean } {
  if (!header) return { range: null, unsatisfiable: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { range: null, unsatisfiable: false };
  const [, startRaw, endRaw] = match;
  if (length === null) return { range: null, unsatisfiable: false };
  if (startRaw === '' && endRaw === '') return { range: null, unsatisfiable: false };
  if (startRaw === '') {
    // 后缀长度 bytes=-N：取最后 N 字节。
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { range: null, unsatisfiable: false };
    const start = Math.max(0, length - suffix);
    return { range: { start, end: length - 1 }, unsatisfiable: start >= length };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return { range: null, unsatisfiable: false };
  if (start >= length) return { range: null, unsatisfiable: true };
  const end = endRaw === '' ? length - 1 : Math.min(Number(endRaw), length - 1);
  if (end < start) return { range: null, unsatisfiable: true };
  return { range: { start, end }, unsatisfiable: false };
}

export function writeRangeError(res: http.ServerResponse, length: number | null): void {
  res.statusCode = 416;
  res.setHeader('Content-Range', `bytes */${length ?? 0}`);
  res.setHeader('Content-Length', '0');
  res.end();
}

async function fetchUpstream(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const lib = url.startsWith('https:') ? await import('node:https') : await import('node:http');
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        signal,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从流中取出 [skip, skip+length) 区间字节：丢弃前 `skip` 字节，之后只放行 `length`
 * 字节并立即结束（上游忽略 Range 时回落到本机前端以满足请求）。
 */
function sliceBytes(stream: Readable, skip: number, length: number): Readable {
  const iterator = (async function* () {
    let toSkip = skip;
    let remaining = length;
    for await (const value of stream) {
      let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (toSkip > 0) {
        const skipped = Math.min(chunk.length, toSkip);
        toSkip -= skipped;
        chunk = chunk.subarray(skipped);
      }
      if (chunk.length === 0) continue;
      const count = Math.min(chunk.length, remaining);
      remaining -= count;
      yield chunk.subarray(0, count);
      if (remaining === 0) return;
    }
    if (remaining > 0) throw new Error('Upstream ended before the requested range was complete');
  })();
  const cancellableIterator: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => iterator.next(),
    return: () => {
      stream.destroy();
      return iterator.return(undefined);
    },
    throw: (error: unknown) => {
      stream.destroy();
      return iterator.throw(error);
    },
  };
  const out = Readable.from(cancellableIterator, { objectMode: false });
  // Cancel a pending iterator read as well as reads paused by downstream backpressure.
  out.once('close', () => stream.destroy());
  return out;
}

export class MediaServer {
  private readonly tokenBytes: number;
  private readonly highWaterMark: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly onUpstreamStatus?: (status: number, url: string) => void;
  private readonly resources = new Map<string, MediaResource>();
  private readonly tokens = new Map<string, string>();
  private server: http.Server | null = null;
  private startFlight: Promise<number> | null = null;
  private stopFlight: Promise<void> | null = null;
  private readonly activeResponses = new Map<string, Set<http.ServerResponse>>();
  private boundPort = 0;
  private readonly bindHost: string;

  constructor(options: MediaServerOptions = {}) {
    this.tokenBytes = options.tokenBytes ?? 32;
    this.highWaterMark = options.highWaterMark ?? 64 * 1024;
    this.log = options.log ?? (() => {});
    this.onUpstreamStatus = options.onUpstreamStatus;
    this.bindHost = options.bindHost ?? pickLanIpv4(options.addressProvider);
  }

  get host(): string {
    return this.bindHost;
  }

  get port(): number {
    return this.boundPort;
  }

  get urlBase(): string {
    if (!this.boundPort) return '';
    return `http://${this.bindHost}:${this.boundPort}`;
  }

  get activeResourceCount(): number {
    return this.resources.size;
  }

  async start(port = 0): Promise<number> {
    if (this.stopFlight) await this.stopFlight;
    if (this.startFlight) return this.startFlight;
    if (this.server) return this.boundPort;
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        if (
          res.destroyed &&
          (error?.code === 'ABORT_ERR' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE')
        )
          return;
        this.log('error', `[MediaServer] serve failed: ${String(error)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.removeHeader('Content-Range');
          res.setHeader('Content-Length', '0');
          res.end();
        } else {
          res.destroy();
        }
      });
    });
    this.server = server;
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        // 尽力。
      }
    });
    // 短 keep-alive：设备一般每次请求新连接；也让 stop() 不再被空闲连接拖住。
    server.keepAliveTimeout = 2000;
    server.headersTimeout = 10_000;
    this.startFlight = new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server = null;
        this.boundPort = 0;
        reject(error);
      };
      server.once('error', onError);
      try {
        server.listen(port, this.bindHost, () => {
          server.removeListener('error', onError);
          const address = server.address();
          this.boundPort = typeof address === 'object' && address ? address.port : 0;
          resolve(this.boundPort);
        });
      } catch (error) {
        server.removeListener('error', onError);
        onError(error as Error);
      }
    }).finally(() => {
      this.startFlight = null;
    });
    return this.startFlight;
  }

  async stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    this.stopFlight = (async () => {
      await this.startFlight?.catch(() => undefined);
      const server = this.server;
      this.server = null;
      this.boundPort = 0;
      this.tokens.clear();
      this.resources.clear();
      for (const responses of this.activeResponses.values()) {
        for (const response of responses) response.destroy();
      }
      this.activeResponses.clear();
      if (!server) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    })().finally(() => {
      this.stopFlight = null;
    });
    return this.stopFlight;
  }

  /** 登记资源，返回受控 token 与 URL；会话结束/撤销后立即失效。 */
  registerResource(
    partial: Omit<MediaResource, 'resourceId'>,
    sessionId = 'session',
  ): { token: string; url: string } | null {
    if (!this.server || !this.boundPort) return null;
    const resourceId = randomBytes(16).toString('hex');
    const token = randomBytes(this.tokenBytes).toString('hex');
    const resource: MediaResource = { ...partial, resourceId, sessionId };
    this.resources.set(resourceId, resource);
    this.tokens.set(token, resourceId);
    const url = `${this.urlBase}/res/${token}`;
    return { token, url };
  }

  resolveToken(token: string): MediaResource | null {
    const resourceId = this.tokens.get(token);
    if (!resourceId) return null;
    return this.resources.get(resourceId) ?? null;
  }

  /** 撤销单个 token（资源替换时）。 */
  revokeToken(token: string): void {
    const resourceId = this.tokens.get(token);
    if (!resourceId) return;
    this.tokens.delete(token);
    this.resources.delete(resourceId);
    this.cancelResourceRequests(resourceId);
    this.log('info', `[MediaServer] revoke token=${token.slice(0, 8)}…`);
  }

  /** 撤销某输出会话的全部资源（会话结束、断连时幂等清理）。 */
  revokeSession(sessionId: string): void {
    let cleared = 0;
    for (const [token, resourceId] of this.tokens.entries()) {
      const resource = this.resources.get(resourceId);
      if (resource && resource.sessionId === sessionId) {
        this.tokens.delete(token);
        this.resources.delete(resourceId);
        this.cancelResourceRequests(resourceId);
        cleared += 1;
      }
    }
    if (cleared > 0)
      this.log('info', `[MediaServer] revoke session ${sessionId} (${cleared} resources)`);
  }

  private cancelResourceRequests(resourceId: string): void {
    for (const response of this.activeResponses.get(resourceId) ?? []) response.destroy();
    this.activeResponses.delete(resourceId);
  }

  async statResource(
    resource: MediaResource,
  ): Promise<{ length: number | null; mime: string | null }> {
    let length = resource.length ?? null;
    const mime = resource.mime;
    if (resource.source.kind === 'file' && length === null) {
      try {
        const stat = await fs.promises.stat(resource.source.path);
        length = stat.size;
      } catch {
        length = null;
      }
    }
    return { length, mime };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/res\/([a-f0-9]+)$/.exec(url.pathname);
    if (!match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const token = match[1];
    const resource = this.resolveToken(token);
    if (!resource) {
      res.statusCode = 403;
      res.end();
      return;
    }
    const responses = this.activeResponses.get(resource.resourceId) ?? new Set();
    this.activeResponses.set(resource.resourceId, responses);
    responses.add(res);
    const release = () => {
      responses.delete(res);
      if (responses.size === 0) this.activeResponses.delete(resource.resourceId);
    };
    res.once('close', release);
    await this.serveResource(req, res, resource);
  }

  private async serveResource(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    resource: MediaResource,
  ): Promise<void> {
    const { length, mime } = await this.statResource(resource);
    if (res.destroyed) return;
    const parsed = parseRange(req.headers.range, length);
    if (parsed.unsatisfiable) {
      writeRangeError(res, length);
      return;
    }
    const range = parsed.range;
    const partial = range !== null;
    const contentLength = range ? range.end - range.start + 1 : length;

    res.statusCode = partial ? 206 : 200;
    if (mime || resource.source.kind === 'file') {
      res.setHeader(
        'Content-Type',
        mime ??
          inferMime(resource.source.kind === 'file' ? resource.source.path : '') ??
          'application/octet-stream',
      );
    }
    if (length !== null) {
      res.setHeader('Accept-Ranges', 'bytes');
      if (partial) {
        res.setHeader('Content-Range', `bytes ${range!.start}-${range!.end}/${length}`);
      }
    }
    if (contentLength !== null) {
      res.setHeader('Content-Length', String(contentLength));
    }
    res.setHeader('Content-Disposition', 'inline');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.removeHeader('Content-Range');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    if (resource.source.kind === 'file') {
      await this.serveFile(res, resource.source.path, range);
      return;
    }
    await this.serveHttpRelay(res, resource.source.url, resource.source.headers, range);
  }

  private async serveFile(
    res: http.ServerResponse,
    filePath: string,
    range: RangeRequest | null,
  ): Promise<void> {
    const options: fs.ReadStreamOptions = { highWaterMark: this.highWaterMark };
    if (range) {
      options.start = range.start;
      options.end = range.end;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, options);
      stream.on('error', reject);
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      stream.on('end', () => resolve());
      res.on('close', () => resolve());
    });
  }

  private async serveHttpRelay(
    res: http.ServerResponse,
    url: string,
    headers: Record<string, string> | undefined,
    range: RangeRequest | null,
  ): Promise<void> {
    const upstreamHeaders: Record<string, string> = { ...headers };
    if (range) {
      upstreamHeaders['Range'] = `bytes=${range.start}-${range.end}`;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      if (res.destroyed) return;
      const upstream = await fetchUpstream(url, upstreamHeaders, controller.signal);
      const status = upstream.statusCode ?? 0;
      if (status >= 500 && status < 600) {
        res.statusCode = status;
        res.removeHeader('Content-Range');
        res.setHeader('Content-Length', '0');
        upstream.destroy();
        res.end();
        return;
      }
      if (status !== 200 && status !== 206) {
        if (status === 401 || status === 403 || status === 410)
          this.onUpstreamStatus?.(status, url);
        res.statusCode = 502;
        res.removeHeader('Content-Range');
        res.setHeader('Content-Length', '0');
        upstream.destroy();
        res.end();
        return;
      }
      let stream: Readable = upstream;
      // 上游忽略 Range 时（200 全量）回落到本机前端以满足请求：跳过前缀并只放行目标宽度。
      if (range && status === 200) {
        stream = sliceBytes(upstream, range.start, range.end - range.start + 1);
      }
      await pipeline(stream, res);
    } finally {
      res.removeListener('close', cancel);
    }
  }
}

function inferMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}
