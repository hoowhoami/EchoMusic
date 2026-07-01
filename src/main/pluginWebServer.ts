import { app, type WebContents } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type {
  EchoPluginDescriptor,
  PluginWebServerCloseResult,
  PluginWebServerListenOptions,
  PluginWebServerListenResult,
  PluginWebServerRequest,
  PluginWebServerResponsePayload,
  PluginWebServerStatusResult,
} from '../shared/plugins';
import log from './logger';

const DEFAULT_PLUGIN_WEB_SERVER_HOST = '127.0.0.1';
const MAX_PLUGIN_WEB_SERVER_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_WEB_SERVER_RESPONSE_BYTES = 8 * 1024 * 1024;
const PLUGIN_WEB_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_ID_RANDOM = Math.random().toString(36).slice(2);

type PendingRequest = {
  pluginId: string;
  requestId: string;
  response: ServerResponse;
  timeout: NodeJS.Timeout;
};

type PluginWebServerRecord = {
  pluginId: string;
  server: Server;
  webContents: WebContents;
  ownerWebContentsId: number;
  host: string;
  port: number;
  origin: string;
  url: string;
  startedAt: number;
  pendingRequests: Map<string, PendingRequest>;
  onOwnerDestroyed: () => void;
};

const servers = new Map<string, PluginWebServerRecord>();
let requestSeq = 0;

const normalizeListenOptions = (options?: PluginWebServerListenOptions) => {
  const rawPort = Number(options?.port ?? 0);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : NaN;
  if (!Number.isFinite(port)) throw new Error('端口必须是 0-65535 之间的整数');

  const requestedHost = String(options?.host || DEFAULT_PLUGIN_WEB_SERVER_HOST).trim();
  if (
    requestedHost &&
    requestedHost !== DEFAULT_PLUGIN_WEB_SERVER_HOST &&
    requestedHost !== 'localhost'
  ) {
    throw new Error('插件 Web 服务只能监听 127.0.0.1');
  }

  return {
    port,
    host: DEFAULT_PLUGIN_WEB_SERVER_HOST,
  };
};

const toArrayBuffer = (buffer: Buffer) => {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
};

const getRequestBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_PLUGIN_WEB_SERVER_REQUEST_BYTES) {
        reject(new Error('请求体超过插件 Web 服务限制'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });

const normalizeHeaders = (headers: IncomingMessage['headers']) =>
  Object.entries(headers).reduce<Record<string, string | string[]>>((result, [key, value]) => {
    if (value === undefined) return result;
    result[key] = value;
    return result;
  }, {});

const normalizeQuery = (searchParams: URLSearchParams) => {
  const query: Record<string, string | string[]> = {};
  searchParams.forEach((value, key) => {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  });
  return query;
};

const isHeaderNameSafe = (name: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);

const hasContentTypeHeader = (headers: Record<string, string | number | boolean | string[]>) =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');

const sanitizeResponseHeaders = (headers: PluginWebServerResponsePayload['headers']) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};

  return Object.entries(headers).reduce<Record<string, string | string[]>>(
    (result, [name, value]) => {
      const normalizedName = String(name || '').trim();
      const lowerName = normalizedName.toLowerCase();
      if (
        !normalizedName ||
        !isHeaderNameSafe(normalizedName) ||
        lowerName === 'content-length' ||
        lowerName === 'transfer-encoding' ||
        lowerName === 'connection'
      ) {
        return result;
      }
      if (Array.isArray(value)) {
        result[normalizedName] = value.map((item) => String(item));
      } else if (value !== undefined && value !== null) {
        result[normalizedName] = String(value);
      }
      return result;
    },
    {},
  );
};

const toBufferBody = (body: PluginWebServerResponsePayload['body']) => {
  if (body === undefined || body === null) {
    return {
      buffer: Buffer.alloc(0),
      defaultContentType: '',
    };
  }

  if (typeof body === 'string') {
    return {
      buffer: Buffer.from(body),
      defaultContentType: 'text/html; charset=utf-8',
    };
  }

  if (body instanceof ArrayBuffer) {
    return {
      buffer: Buffer.from(body),
      defaultContentType: 'application/octet-stream',
    };
  }

  if (ArrayBuffer.isView(body)) {
    return {
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      defaultContentType: 'application/octet-stream',
    };
  }

  if (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    String((body as { type?: unknown }).type || '') === 'base64'
  ) {
    return {
      buffer: Buffer.from(String((body as { data?: unknown }).data || ''), 'base64'),
      defaultContentType: 'application/octet-stream',
    };
  }

  return {
    buffer: Buffer.from(JSON.stringify(body)),
    defaultContentType: 'application/json; charset=utf-8',
  };
};

const sendSimpleResponse = (
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
};

const getStatusFromRecord = (record: PluginWebServerRecord): PluginWebServerStatusResult => ({
  ok: true,
  pluginId: record.pluginId,
  running: true,
  host: record.host,
  port: record.port,
  origin: record.origin,
  url: record.url,
  startedAt: record.startedAt,
  pendingRequests: record.pendingRequests.size,
});

const getListenResultFromRecord = (record: PluginWebServerRecord): PluginWebServerListenResult => ({
  ok: true,
  pluginId: record.pluginId,
  host: record.host,
  port: record.port,
  origin: record.origin,
  url: record.url,
  startedAt: record.startedAt,
});

const closeRecord = async (record: PluginWebServerRecord) => {
  servers.delete(record.pluginId);
  record.webContents.removeListener('destroyed', record.onOwnerDestroyed);

  for (const pending of record.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    sendSimpleResponse(pending.response, 503, 'Plugin web server closed');
  }
  record.pendingRequests.clear();

  await new Promise<void>((resolve) => {
    record.server.close((error) => {
      if (error) {
        log.warn('[PluginWebServer] Close failed', { pluginId: record.pluginId, error });
      }
      resolve();
    });
  });
};

export const closePluginWebServer = async (
  pluginId: string,
  webContents?: WebContents,
): Promise<PluginWebServerCloseResult> => {
  const record = servers.get(pluginId);
  if (!record) return { ok: true, pluginId, closed: false };
  if (webContents && record.ownerWebContentsId !== webContents.id) {
    return { ok: false, error: '插件 Web 服务不属于当前运行上下文' };
  }

  await closeRecord(record);
  return { ok: true, pluginId, closed: true };
};

export const closePluginWebServers = async (pluginId?: string): Promise<void> => {
  const records = Array.from(servers.values()).filter(
    (record) => !pluginId || record.pluginId === pluginId,
  );
  await Promise.all(records.map((record) => closeRecord(record)));
};

export const getPluginWebServerStatus = (pluginId: string): PluginWebServerStatusResult => {
  const record = servers.get(pluginId);
  if (!record) {
    return {
      ok: true,
      pluginId,
      running: false,
      host: DEFAULT_PLUGIN_WEB_SERVER_HOST,
      port: 0,
      origin: '',
      url: '',
      startedAt: 0,
      pendingRequests: 0,
    };
  }
  return getStatusFromRecord(record);
};

export const respondPluginWebServerRequest = (
  pluginId: string,
  payload: PluginWebServerResponsePayload,
  webContents?: WebContents,
) => {
  const record = servers.get(pluginId);
  if (record && webContents && record.ownerWebContentsId !== webContents.id) {
    return { ok: false, error: '插件 Web 请求不属于当前运行上下文' };
  }
  const requestId = String(payload?.requestId || '');
  const pending = requestId ? record?.pendingRequests.get(requestId) : null;
  if (!record || !pending) return { ok: false, error: '插件 Web 请求不存在或已超时' };

  record.pendingRequests.delete(requestId);
  clearTimeout(pending.timeout);

  try {
    const status = Math.trunc(Number(payload.status || 200));
    const safeStatus = status >= 100 && status <= 599 ? status : 200;
    const headers = sanitizeResponseHeaders(payload.headers);
    const { buffer, defaultContentType } = toBufferBody(payload.body);

    if (buffer.byteLength > MAX_PLUGIN_WEB_SERVER_RESPONSE_BYTES) {
      sendSimpleResponse(pending.response, 413, 'Plugin web response is too large');
      return { ok: false, error: '响应体超过插件 Web 服务限制' };
    }

    if (defaultContentType && !hasContentTypeHeader(headers)) {
      headers['content-type'] = defaultContentType;
    }
    headers['content-length'] = String(buffer.byteLength);

    if (!pending.response.destroyed && !pending.response.writableEnded) {
      pending.response.writeHead(safeStatus, headers);
      pending.response.end(buffer);
    }
    return { ok: true };
  } catch (error) {
    sendSimpleResponse(pending.response, 500, 'Plugin web response failed');
    return {
      ok: false,
      error: error instanceof Error ? error.message : '插件 Web 响应失败',
    };
  }
};

export const listenPluginWebServer = async (
  plugin: EchoPluginDescriptor,
  options: PluginWebServerListenOptions | undefined,
  webContents: WebContents,
): Promise<PluginWebServerListenResult> => {
  const normalizedOptions = normalizeListenOptions(options);
  const existing = servers.get(plugin.id);
  if (existing) {
    if (
      existing.ownerWebContentsId === webContents.id &&
      existing.host === normalizedOptions.host &&
      (normalizedOptions.port === 0 || existing.port === normalizedOptions.port)
    ) {
      return getListenResultFromRecord(existing);
    }
    await closeRecord(existing);
  }

  if (webContents.isDestroyed()) return { ok: false, error: '插件运行上下文已销毁' };

  const server = createServer(async (request, response) => {
    const record = servers.get(plugin.id);
    if (!record || record.server !== server) {
      sendSimpleResponse(response, 503, 'Plugin web server is not running');
      return;
    }

    try {
      const body = await getRequestBody(request);
      if (response.destroyed || response.writableEnded) return;

      const rawUrl = request.url || '/';
      const parsedUrl = new URL(rawUrl, record.origin);
      const requestId = `${Date.now()}-${++requestSeq}-${REQUEST_ID_RANDOM}`;
      const payload: PluginWebServerRequest = {
        requestId,
        pluginId: plugin.id,
        method: String(request.method || 'GET').toUpperCase(),
        url: `${parsedUrl.pathname}${parsedUrl.search}`,
        path: parsedUrl.pathname,
        query: normalizeQuery(parsedUrl.searchParams),
        headers: normalizeHeaders(request.headers),
        body: toArrayBuffer(body),
        remoteAddress: request.socket.remoteAddress || '',
      };

      const timeout = setTimeout(() => {
        const pending = record.pendingRequests.get(requestId);
        if (!pending) return;
        record.pendingRequests.delete(requestId);
        sendSimpleResponse(response, 504, 'Plugin web request timed out');
      }, PLUGIN_WEB_SERVER_REQUEST_TIMEOUT_MS);
      const pending: PendingRequest = {
        pluginId: plugin.id,
        requestId,
        response,
        timeout,
      };
      record.pendingRequests.set(requestId, pending);
      response.once('close', () => {
        if (response.writableEnded) return;
        const current = record.pendingRequests.get(requestId);
        if (!current) return;
        clearTimeout(current.timeout);
        record.pendingRequests.delete(requestId);
      });

      if (record.webContents.isDestroyed()) {
        clearTimeout(timeout);
        record.pendingRequests.delete(requestId);
        sendSimpleResponse(response, 503, 'Plugin web owner is unavailable');
        return;
      }

      record.webContents.send('plugins:web-server:request', payload);
    } catch (error) {
      const status = error instanceof Error && error.message.includes('请求体超过') ? 413 : 500;
      sendSimpleResponse(
        response,
        status,
        error instanceof Error ? error.message : 'Plugin web request failed',
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(normalizedOptions.port, normalizedOptions.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : normalizedOptions.port;
  const host = normalizedOptions.host;
  const origin = `http://${host}:${port}`;
  const onOwnerDestroyed = () => void closePluginWebServer(plugin.id);
  const record: PluginWebServerRecord = {
    pluginId: plugin.id,
    server,
    webContents,
    ownerWebContentsId: webContents.id,
    host,
    port,
    origin,
    url: `${origin}/`,
    startedAt: Date.now(),
    pendingRequests: new Map(),
    onOwnerDestroyed,
  };
  webContents.once('destroyed', onOwnerDestroyed);
  servers.set(plugin.id, record);

  log.info('[PluginWebServer] Listening', { pluginId: plugin.id, url: record.url });
  return getListenResultFromRecord(record);
};

app.once('before-quit', () => void closePluginWebServers());
