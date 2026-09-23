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
import { PassThrough, type Readable } from 'node:stream';

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

function listIpv4Addresses(provider?: () => string[]): string[] {
  if (provider) {
    try {
      return provider().filter((addr) => /\d+\.\d+\.\d+\.\d+/.test(addr));
    } catch {
      return [];
    }
  }
  const addrs: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces() ?? {})) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4') addrs.push(iface.address);
    }
  }
  return addrs;
}

export function pickLanIpv4(provider?: () => string[]): string {
  const candidates = listIpv4Addresses(provider);
  const privateV4 = candidates.find((addr) => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) &&
      !addr.startsWith('127.')
    );
  });
  return privateV4 ?? '127.0.0.1';
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
  const out = new PassThrough();
  let toSkip = skip;
  let remaining = length;
  stream.on('data', (chunk: Buffer) => {
    if (toSkip > 0) {
      if (chunk.length <= toSkip) {
        toSkip -= chunk.length;
        return;
      }
      chunk = chunk.subarray(toSkip);
      toSkip = 0;
    }
    if (remaining <= 0) return;
    if (chunk.length <= remaining) {
      out.write(chunk);
      remaining -= chunk.length;
      return;
    }
    out.write(chunk.subarray(0, remaining));
    remaining = 0;
  });
  stream.on('end', () => out.end());
  stream.on('error', (err) => out.destroy(err));
  // 放行完目标区间后立即终止上游读取，避免多余流量与悬挂连接。
  out.on('close', () => {
    if (remaining <= 0) stream.destroy();
  });
  return out;
}

export class MediaServer {
  private readonly tokenBytes: number;
  private readonly highWaterMark: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly resources = new Map<string, MediaResource>();
  private readonly tokens = new Map<string, string>();
  private server: http.Server | null = null;
  private boundPort = 0;
  private readonly bindHost: string;

  constructor(options: MediaServerOptions = {}) {
    this.tokenBytes = options.tokenBytes ?? 32;
    this.highWaterMark = options.highWaterMark ?? 64 * 1024;
    this.log = options.log ?? (() => {});
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
    if (this.server) return this.boundPort;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.log('error', `[MediaServer] serve failed: ${String(error)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else {
          res.destroy();
        }
      });
    });
    this.server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        // 尽力。
      }
    });
    // 短 keep-alive：设备一般每次请求新连接；也让 stop() 不再被空闲连接拖住。
    this.server.keepAliveTimeout = 2000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, this.bindHost, () => resolve());
    });
    const address = this.server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : 0;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.tokens.clear();
    this.resources.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        cleared += 1;
      }
    }
    if (cleared > 0)
      this.log('info', `[MediaServer] revoke session ${sessionId} (${cleared} resources)`);
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
    await this.serveResource(req, res, resource);
  }

  private async serveResource(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    resource: MediaResource,
  ): Promise<void> {
    const { length, mime } = await this.statResource(resource);
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
    const upstream = await fetchUpstream(url, upstreamHeaders);
    const status = upstream.statusCode ?? 0;
    if (status >= 500 && status < 600) {
      res.statusCode = status;
      res.end();
      return;
    }
    if (status !== 200 && status !== 206) {
      res.statusCode = 502;
      res.end();
      return;
    }
    let stream: Readable = upstream;
    // 上游忽略 Range 时（200 全量）回落到本机前端以满足请求：跳过前缀并只放行目标宽度。
    if (range && status === 200) {
      stream = sliceBytes(upstream, range.start, range.end - range.start + 1);
    }
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
      stream.on('end', () => resolve());
    });
  }
}

function inferMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}
