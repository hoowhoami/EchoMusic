import type { WebContents } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  EchoPluginDescriptor,
  PluginWebServerCloseResult,
  PluginWebServerListenOptions,
  PluginWebServerListenResult,
  PluginWebServerRequest,
  PluginWebServerResponsePayload,
  PluginWebServerStatusResult,
  PluginWebSocketClosePayload,
  PluginWebSocketData,
  PluginWebSocketNativeCloseEvent,
  PluginWebSocketNativeErrorEvent,
  PluginWebSocketNativeMessageEvent,
  PluginWebSocketOpenEvent,
  PluginWebSocketSendPayload,
  PluginWebSocketUpgradeRequest,
  PluginWebSocketUpgradeResponse,
} from '../../shared/plugins';

const DEFAULT_PLUGIN_WEB_SERVER_HOST = '127.0.0.1';
const MAX_PLUGIN_WEB_SERVER_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_WEB_SERVER_RESPONSE_BYTES = 8 * 1024 * 1024;
const PLUGIN_WEB_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const PLUGIN_WEB_SOCKET_UPGRADE_TIMEOUT_MS = 10_000;
const DEFAULT_PLUGIN_WEB_SOCKET_CONNECTIONS = 16;
const MAX_PLUGIN_WEB_SOCKET_CONNECTIONS = 64;
const DEFAULT_PLUGIN_WEB_SOCKET_MESSAGE_BYTES = 1 * 1024 * 1024;
const MAX_PLUGIN_WEB_SOCKET_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_WEB_SOCKET_BUFFERED_BYTES = 32 * 1024 * 1024;
const REQUEST_ID_RANDOM = Math.random().toString(36).slice(2);
const UPGRADE_PROTOCOL = Symbol('pluginWebSocketProtocol');

type PendingRequest = {
  pluginId: string;
  requestId: string;
  response: ServerResponse;
  timeout: NodeJS.Timeout;
};

type PendingUpgrade = {
  connectionId: string;
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  timeout: NodeJS.Timeout;
  parsedUrl: URL;
  headers: Record<string, string | string[]>;
  protocols: string[];
  remoteAddress: string;
};

type ActiveWebSocket = {
  connectionId: string;
  pluginId: string;
  socket: WebSocket;
  protocol: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  remoteAddress: string;
  closed: boolean;
  maxMessageBytes: number;
  maxBufferedBytes: number;
};

type PluginWebServerRecord = {
  pluginId: string;
  server: Server;
  socketsServer: WebSocketServer;
  webContents: WebContents;
  ownerWebContentsId: number;
  host: string;
  port: number;
  origin: string;
  url: string;
  startedAt: number;
  pendingRequests: Map<string, PendingRequest>;
  pendingUpgrades: Map<string, PendingUpgrade>;
  sockets: Map<string, ActiveWebSocket>;
  maxConnections: number;
  maxMessageBytes: number;
  maxBufferedBytes: number;
  allowCrossOrigin: boolean;
  onOwnerDestroyed: () => void;
};

type UpgradeRequestWithProtocol = IncomingMessage & {
  [UPGRADE_PROTOCOL]?: string;
};

const servers = new Map<string, PluginWebServerRecord>();
let requestSeq = 0;

const clampLimit = (value: unknown, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`限制必须是 ${min}-${max} 之间的整数`);
  }
  return numeric;
};

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

  const maxConnections = clampLimit(
    options?.maxConnections,
    DEFAULT_PLUGIN_WEB_SOCKET_CONNECTIONS,
    1,
    MAX_PLUGIN_WEB_SOCKET_CONNECTIONS,
  );
  const maxMessageBytes = clampLimit(
    options?.maxMessageBytes,
    DEFAULT_PLUGIN_WEB_SOCKET_MESSAGE_BYTES,
    1024,
    MAX_PLUGIN_WEB_SOCKET_MESSAGE_BYTES,
  );
  const maxBufferedBytes = clampLimit(
    options?.maxBufferedBytes,
    Math.min(maxMessageBytes * 4, MAX_PLUGIN_WEB_SOCKET_BUFFERED_BYTES),
    maxMessageBytes,
    MAX_PLUGIN_WEB_SOCKET_BUFFERED_BYTES,
  );

  return {
    port,
    host: DEFAULT_PLUGIN_WEB_SERVER_HOST,
    maxConnections,
    maxMessageBytes,
    maxBufferedBytes,
    allowCrossOrigin: options?.allowCrossOrigin === true,
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

const toWebSocketPayload = (data: PluginWebSocketData | undefined) => {
  if (data === undefined || data === null) {
    return { payload: Buffer.alloc(0), binary: true };
  }
  if (typeof data === 'string') return { payload: data, binary: false };
  if (data instanceof ArrayBuffer) return { payload: Buffer.from(data), binary: true };
  if (ArrayBuffer.isView(data)) {
    return {
      payload: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      binary: true,
    };
  }
  if (
    typeof data === 'object' &&
    !Array.isArray(data) &&
    String((data as { type?: unknown }).type || '') === 'base64'
  ) {
    return {
      payload: Buffer.from(String((data as { data?: unknown }).data || ''), 'base64'),
      binary: true,
    };
  }
  throw new Error('不支持的 WebSocket 数据格式');
};

const parseSecWebSocketProtocol = (value: string | string[] | undefined) => {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const getHeaderValue = (headers: IncomingMessage['headers'], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const isSameOriginWebSocket = (originHeader: string, record: PluginWebServerRecord) => {
  const origin = originHeader.trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return port === String(record.port);
  } catch {
    return false;
  }
};

const rejectUpgradeSocket = (socket: Duplex, status: number) => {
  const reason =
    status === 400
      ? 'Bad Request'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 429
            ? 'Too Many Requests'
            : status === 503
              ? 'Service Unavailable'
              : 'Error';
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
};

const emitWebSocketEvent = (
  record: PluginWebServerRecord,
  channel:
    | 'plugins:web-server:ws-open'
    | 'plugins:web-server:ws-message'
    | 'plugins:web-server:ws-close'
    | 'plugins:web-server:ws-error',
  payload:
    | PluginWebSocketOpenEvent
    | PluginWebSocketNativeMessageEvent
    | PluginWebSocketNativeCloseEvent
    | PluginWebSocketNativeErrorEvent,
) => {
  if (record.webContents.isDestroyed()) return;
  record.webContents.send(channel, payload);
};

const closeActiveWebSocket = (
  record: PluginWebServerRecord,
  active: ActiveWebSocket,
  code: number,
  reason: string,
  terminate = false,
) => {
  if (active.closed) return;
  active.closed = true;
  record.sockets.delete(active.connectionId);
  try {
    if (terminate || active.socket.readyState !== WebSocket.OPEN) {
      active.socket.terminate();
    } else {
      active.socket.close(code, reason);
    }
  } catch {
    try {
      active.socket.terminate();
    } catch {
      // ignore
    }
  }
  emitWebSocketEvent(record, 'plugins:web-server:ws-close', {
    connectionId: active.connectionId,
    pluginId: record.pluginId,
    code,
    reason,
  });
};

const attachWebSocket = (
  record: PluginWebServerRecord,
  pending: PendingUpgrade,
  socket: WebSocket,
  protocol: string,
) => {
  const active: ActiveWebSocket = {
    connectionId: pending.connectionId,
    pluginId: record.pluginId,
    socket,
    protocol,
    url: `${pending.parsedUrl.pathname}${pending.parsedUrl.search}`,
    path: pending.parsedUrl.pathname,
    query: normalizeQuery(pending.parsedUrl.searchParams),
    headers: pending.headers,
    remoteAddress: pending.remoteAddress,
    closed: false,
    maxMessageBytes: record.maxMessageBytes,
    maxBufferedBytes: record.maxBufferedBytes,
  };
  record.sockets.set(active.connectionId, active);

  socket.on('message', (data, isBinary) => {
    if (active.closed) return;
    const buffer = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(String(data));
    emitWebSocketEvent(record, 'plugins:web-server:ws-message', {
      connectionId: active.connectionId,
      pluginId: record.pluginId,
      data: isBinary ? toArrayBuffer(buffer) : buffer.toString('utf8'),
      binary: isBinary,
    });
  });
  socket.on('error', (error) => {
    emitWebSocketEvent(record, 'plugins:web-server:ws-error', {
      connectionId: active.connectionId,
      pluginId: record.pluginId,
      error: error instanceof Error ? error.message : 'WebSocket 连接异常',
    });
    closeActiveWebSocket(record, active, 1011, 'socket error', true);
  });
  socket.on('close', (code, reason) => {
    if (active.closed) return;
    active.closed = true;
    record.sockets.delete(active.connectionId);
    emitWebSocketEvent(record, 'plugins:web-server:ws-close', {
      connectionId: active.connectionId,
      pluginId: record.pluginId,
      code: code || 1005,
      reason: Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || ''),
    });
  });

  emitWebSocketEvent(record, 'plugins:web-server:ws-open', {
    connectionId: active.connectionId,
    pluginId: record.pluginId,
    protocol,
    url: active.url,
    path: active.path,
    query: active.query,
    headers: active.headers,
    remoteAddress: active.remoteAddress,
  });
};

const acceptPendingUpgrade = (
  record: PluginWebServerRecord,
  pending: PendingUpgrade,
  protocol: string,
) => {
  const request = pending.request as UpgradeRequestWithProtocol;
  request[UPGRADE_PROTOCOL] = protocol;
  record.socketsServer.handleUpgrade(pending.request, pending.socket, pending.head, (socket) => {
    attachWebSocket(record, pending, socket, protocol);
  });
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
  connections: record.sockets.size,
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

  for (const pending of record.pendingUpgrades.values()) {
    clearTimeout(pending.timeout);
    rejectUpgradeSocket(pending.socket, 503);
  }
  record.pendingUpgrades.clear();

  for (const active of record.sockets.values()) {
    closeActiveWebSocket(record, active, 1001, 'server shutdown', true);
  }

  await new Promise<void>((resolve) => {
    record.socketsServer.close(() => resolve());
  });

  await new Promise<void>((resolve) => {
    record.server.close((error) => {
      if (error) {
        if (!process.env.NODE_TEST_CONTEXT) {
          void import('../logger')
            .then((module) => {
              module.default.warn('[PluginWebServer] Close failed', {
                pluginId: record.pluginId,
                error,
              });
            })
            .catch(() => undefined);
        }
      }
      resolve();
    });
  });
};

const requireOwnedRecord = (pluginId: string, webContents?: WebContents) => {
  const record = servers.get(pluginId);
  if (!record) return { ok: false as const, error: '插件 Web 服务未运行' };
  if (webContents && record.ownerWebContentsId !== webContents.id) {
    return { ok: false as const, error: '插件 Web 服务不属于当前运行上下文' };
  }
  return { ok: true as const, record };
};

const sendOnActiveSocket = (
  active: ActiveWebSocket,
  data: PluginWebSocketData | undefined,
  kind: 'message' | 'ping',
) => {
  if (active.closed || active.socket.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'WebSocket 已关闭' };
  }
  const { payload, binary } = toWebSocketPayload(data);
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
  if (size > active.maxMessageBytes) {
    return { ok: false, error: 'WebSocket 消息超过插件限制' };
  }
  if (active.socket.bufferedAmount + size > active.maxBufferedBytes) {
    return { ok: false, error: 'WebSocket 发送缓冲已满' };
  }
  if (kind === 'ping') {
    const pingSize = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
    if (pingSize > 125) {
      return { ok: false, error: 'WebSocket ping 载荷不能超过 125 字节' };
    }
    active.socket.ping(payload);
    return { ok: true };
  }
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    active.socket.send(payload, { binary }, (error) => {
      if (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : 'WebSocket 发送失败',
        });
        return;
      }
      resolve({ ok: true });
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
      connections: 0,
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

export const respondPluginWebSocketUpgrade = (
  pluginId: string,
  payload: PluginWebSocketUpgradeResponse,
  webContents?: WebContents,
) => {
  const owned = requireOwnedRecord(pluginId, webContents);
  if (!owned.ok) return owned;
  const connectionId = String(payload?.connectionId || '');
  const pending = connectionId ? owned.record.pendingUpgrades.get(connectionId) : null;
  if (!pending) {
    if (owned.record.sockets.has(connectionId)) return { ok: true };
    return { ok: false, error: 'WebSocket 升级请求不存在或已超时' };
  }

  owned.record.pendingUpgrades.delete(connectionId);
  clearTimeout(pending.timeout);

  if (!payload.accept) {
    rejectUpgradeSocket(pending.socket, 403);
    return { ok: true };
  }
  if (owned.record.sockets.size >= owned.record.maxConnections) {
    rejectUpgradeSocket(pending.socket, 429);
    return { ok: false, error: 'WebSocket 连接数量已达到上限' };
  }

  const requested = String(payload.protocol || '').trim();
  if (requested && !pending.protocols.includes(requested)) {
    rejectUpgradeSocket(pending.socket, 400);
    return { ok: false, error: 'WebSocket 子协议不被客户端支持' };
  }
  const protocol = requested || pending.protocols[0] || '';
  try {
    acceptPendingUpgrade(owned.record, pending, protocol);
    return { ok: true };
  } catch (error) {
    rejectUpgradeSocket(pending.socket, 400);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'WebSocket 升级失败',
    };
  }
};

export const sendPluginWebSocket = (
  pluginId: string,
  payload: PluginWebSocketSendPayload,
  webContents?: WebContents,
) => {
  const owned = requireOwnedRecord(pluginId, webContents);
  if (!owned.ok) return owned;
  const active = owned.record.sockets.get(String(payload?.connectionId || ''));
  if (!active) return { ok: false, error: 'WebSocket 连接不存在' };
  try {
    return sendOnActiveSocket(active, payload.data, 'message');
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'WebSocket 发送失败',
    };
  }
};

export const pingPluginWebSocket = (
  pluginId: string,
  payload: PluginWebSocketSendPayload,
  webContents?: WebContents,
) => {
  const owned = requireOwnedRecord(pluginId, webContents);
  if (!owned.ok) return owned;
  const active = owned.record.sockets.get(String(payload?.connectionId || ''));
  if (!active) return { ok: false, error: 'WebSocket 连接不存在' };
  try {
    return sendOnActiveSocket(active, payload.data, 'ping');
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'WebSocket ping 失败',
    };
  }
};

export const closePluginWebSocket = (
  pluginId: string,
  payload: PluginWebSocketClosePayload,
  webContents?: WebContents,
) => {
  const owned = requireOwnedRecord(pluginId, webContents);
  if (!owned.ok) return owned;
  const active = owned.record.sockets.get(String(payload?.connectionId || ''));
  if (!active) return { ok: false, error: 'WebSocket 连接不存在' };
  const code = Number.isInteger(payload?.code) ? Number(payload.code) : 1000;
  if (code !== 1000 && (code < 3000 || code > 4999)) {
    return { ok: false, error: 'WebSocket 关闭码无效' };
  }
  closeActiveWebSocket(owned.record, active, code, String(payload?.reason || ''));
  return { ok: true };
};

const handleUpgrade = (
  pluginId: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => {
  const record = servers.get(pluginId);
  if (!record || record.webContents.isDestroyed()) {
    rejectUpgradeSocket(socket, 503);
    return;
  }
  if (record.sockets.size + record.pendingUpgrades.size >= record.maxConnections) {
    rejectUpgradeSocket(socket, 429);
    return;
  }
  if (!String(getHeaderValue(request.headers, 'sec-websocket-key') || '').trim()) {
    rejectUpgradeSocket(socket, 400);
    return;
  }
  if (!record.allowCrossOrigin) {
    const originHeader = String(getHeaderValue(request.headers, 'origin') || '');
    if (!isSameOriginWebSocket(originHeader, record)) {
      rejectUpgradeSocket(socket, 403);
      return;
    }
  }

  const rawUrl = request.url || '/';
  const parsedUrl = new URL(rawUrl, record.origin);
  const connectionId = `${Date.now()}-${++requestSeq}-${REQUEST_ID_RANDOM}`;
  const pending: PendingUpgrade = {
    connectionId,
    request,
    socket,
    head: Buffer.from(head),
    timeout: setTimeout(() => {
      const current = record.pendingUpgrades.get(connectionId);
      if (!current) return;
      record.pendingUpgrades.delete(connectionId);
      rejectUpgradeSocket(current.socket, 503);
    }, PLUGIN_WEB_SOCKET_UPGRADE_TIMEOUT_MS),
    parsedUrl,
    headers: normalizeHeaders(request.headers),
    protocols: parseSecWebSocketProtocol(request.headers['sec-websocket-protocol']),
    remoteAddress: request.socket.remoteAddress || '',
  };
  record.pendingUpgrades.set(connectionId, pending);
  socket.once('close', () => {
    const current = record.pendingUpgrades.get(connectionId);
    if (!current) return;
    clearTimeout(current.timeout);
    record.pendingUpgrades.delete(connectionId);
  });

  const payload: PluginWebSocketUpgradeRequest = {
    connectionId,
    pluginId: record.pluginId,
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
    path: parsedUrl.pathname,
    query: normalizeQuery(parsedUrl.searchParams),
    headers: pending.headers,
    protocols: pending.protocols,
    remoteAddress: pending.remoteAddress,
  };
  record.webContents.send('plugins:web-server:upgrade', payload);
};

export const listenPluginWebServer = async (
  plugin: EchoPluginDescriptor,
  options: PluginWebServerListenOptions | undefined,
  webContents: WebContents,
  isAccessCurrent: () => boolean,
): Promise<PluginWebServerListenResult> => {
  const normalizedOptions = normalizeListenOptions(options);
  const existing = servers.get(plugin.id);
  if (existing) {
    if (
      existing.ownerWebContentsId === webContents.id &&
      existing.host === normalizedOptions.host &&
      (normalizedOptions.port === 0 || existing.port === normalizedOptions.port) &&
      existing.maxConnections === normalizedOptions.maxConnections &&
      existing.maxMessageBytes === normalizedOptions.maxMessageBytes &&
      existing.maxBufferedBytes === normalizedOptions.maxBufferedBytes &&
      existing.allowCrossOrigin === normalizedOptions.allowCrossOrigin
    ) {
      return getListenResultFromRecord(existing);
    }
    await closeRecord(existing);
  }

  if (webContents.isDestroyed()) return { ok: false, error: '插件运行上下文已销毁' };
  if (!isAccessCurrent()) return { ok: false, error: '插件权限已失效' };

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

  const socketsServer = new WebSocketServer({
    noServer: true,
    maxPayload: normalizedOptions.maxMessageBytes,
    perMessageDeflate: false,
    clientTracking: false,
    handleProtocols: (_protocols, request) => {
      const protocol = (request as UpgradeRequestWithProtocol)[UPGRADE_PROTOCOL] || '';
      return protocol || false;
    },
  });
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(plugin.id, request, socket, head);
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
  if (!isAccessCurrent() || webContents.isDestroyed()) {
    socketsServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { ok: false, error: '插件权限已失效' };
  }
  const port = typeof address === 'object' && address ? address.port : normalizedOptions.port;
  const host = normalizedOptions.host;
  const origin = `http://${host}:${port}`;
  const onOwnerDestroyed = () => void closePluginWebServer(plugin.id);
  const record: PluginWebServerRecord = {
    pluginId: plugin.id,
    server,
    socketsServer,
    webContents,
    ownerWebContentsId: webContents.id,
    host,
    port,
    origin,
    url: `${origin}/`,
    startedAt: Date.now(),
    pendingRequests: new Map(),
    pendingUpgrades: new Map(),
    sockets: new Map(),
    maxConnections: normalizedOptions.maxConnections,
    maxMessageBytes: normalizedOptions.maxMessageBytes,
    maxBufferedBytes: normalizedOptions.maxBufferedBytes,
    allowCrossOrigin: normalizedOptions.allowCrossOrigin,
    onOwnerDestroyed,
  };
  webContents.once('destroyed', onOwnerDestroyed);
  servers.set(plugin.id, record);

  return getListenResultFromRecord(record);
};

export const registerPluginWebServerCleanup = (onBeforeQuit: (handler: () => void) => void) => {
  onBeforeQuit(() => void closePluginWebServers());
};
