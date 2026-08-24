import { Agent as HttpsAgent } from 'node:https';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type {
  PluginNetworkHeaders,
  PluginNetworkRequestBody,
  PluginNetworkRequestOptions,
  PluginNetworkResponse,
  PluginNetworkResponseType,
} from '../../shared/plugins';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

type NormalizedHeaders = Record<string, string | string[]>;

export class PluginNetworkRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PluginNetworkRequestError';
    this.code = code;
  }
}

export const isPluginNetworkRequestError = (error: unknown): error is PluginNetworkRequestError =>
  error instanceof PluginNetworkRequestError;

const normalizeAxiosError = (error: unknown): PluginNetworkRequestError | null => {
  if (!axios.isAxiosError(error)) return null;
  const code = typeof error.code === 'string' && error.code ? error.code : undefined;
  const message = String(error.message || '网络请求失败').trim() || '网络请求失败';
  return new PluginNetworkRequestError(code ? `${message} (${code})` : message, code, error);
};

const normalizeHeaders = (headers?: PluginNetworkHeaders): NormalizedHeaders | undefined => {
  if (!headers) return undefined;

  if (!Array.isArray(headers)) {
    if (typeof headers !== 'object') {
      throw new TypeError('请求头必须是对象或 [name, value] 数组');
    }
    const normalized: NormalizedHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!name.trim()) throw new TypeError('请求头名称不能为空');
      const values = Array.isArray(value) ? value : [value];
      if (values.some((item) => typeof item !== 'string')) {
        throw new TypeError('请求头值必须是字符串或字符串数组');
      }
      normalized[name] = Array.isArray(value) ? [...value] : value;
    }
    return normalized;
  }

  const normalized = new Map<string, { name: string; values: string[] }>();
  for (const header of headers) {
    if (!Array.isArray(header) || header.length !== 2) {
      throw new TypeError('请求头必须是 [name, value] 二元组');
    }
    const [name, value] = header;
    if (typeof name !== 'string' || !name.trim() || typeof value !== 'string') {
      throw new TypeError('请求头名称和值必须是字符串，且名称不能为空');
    }
    const key = name.toLowerCase();
    const existing = normalized.get(key);
    if (existing) existing.values.push(value);
    else normalized.set(key, { name, values: [value] });
  }

  return Object.fromEntries(
    [...normalized.values()].map(({ name, values }) => [
      name,
      values.length === 1 ? values[0] : values,
    ]),
  );
};

const isBase64Body = (body: PluginNetworkRequestBody): body is { type: 'base64'; data: string } =>
  typeof body === 'object' &&
  body !== null &&
  !ArrayBuffer.isView(body) &&
  !(body instanceof ArrayBuffer) &&
  'type' in body &&
  body.type === 'base64' &&
  'data' in body &&
  typeof body.data === 'string';

const normalizeBody = (body?: PluginNetworkRequestBody): unknown => {
  if (body === undefined) return undefined;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (isBase64Body(body)) return Buffer.from(body.data, 'base64');
  return body;
};

const toArrayBuffer = (value: unknown): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const { buffer, byteOffset, byteLength } = value;
    if (buffer instanceof ArrayBuffer) {
      if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
      return buffer.slice(byteOffset, byteOffset + byteLength);
    }

    // SharedArrayBuffer cannot cross Electron IPC as an ArrayBuffer. Copy only
    // for this uncommon case.
    const bytes = new Uint8Array(byteLength);
    bytes.set(new Uint8Array(buffer, byteOffset, byteLength));
    return bytes.buffer;
  }
  return toArrayBuffer(Buffer.from(value == null ? '' : String(value)));
};

const normalizeResponseHeaders = (response: AxiosResponse): Record<string, string | string[]> => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || value === null) continue;
    headers[name.toLowerCase()] = Array.isArray(value)
      ? value.map((item) => String(item))
      : String(value);
  }
  return headers;
};

const validateOptions = (options: PluginNetworkRequestOptions): URL => {
  if (!options || typeof options !== 'object') {
    throw new TypeError('网络请求参数不能为空');
  }

  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new TypeError('网络请求 URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('网络请求仅支持 http: 和 https:');
  }
  if (url.username || url.password) {
    throw new TypeError('URL 中不能包含凭据，请显式设置 Authorization 请求头');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new TypeError('网络请求超时必须是非负有限数值');
  }
  if (
    options.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0)
  ) {
    throw new TypeError('响应体上限必须是非负安全整数');
  }
  if (
    options.maxRedirects !== undefined &&
    (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0)
  ) {
    throw new TypeError('最大重定向次数必须是非负安全整数');
  }
  if (options.decompress !== undefined && typeof options.decompress !== 'boolean') {
    throw new TypeError('decompress 必须是布尔值');
  }
  if (
    options.responseType !== undefined &&
    !(['json', 'text', 'arrayBuffer'] as PluginNetworkResponseType[]).includes(options.responseType)
  ) {
    throw new TypeError('responseType 必须是 json、text 或 arrayBuffer');
  }
  if (
    options.tls?.rejectUnauthorized !== undefined &&
    typeof options.tls.rejectUnauthorized !== 'boolean'
  ) {
    throw new TypeError('tls.rejectUnauthorized 必须是布尔值');
  }
  if (options.tls?.servername !== undefined && typeof options.tls.servername !== 'string') {
    throw new TypeError('tls.servername 必须是字符串');
  }
  return url;
};

/** Sends a plugin request through Axios' Node.js HTTP adapter in the main process. */
export const requestPluginNetwork = async (
  options: PluginNetworkRequestOptions,
  signal?: AbortSignal,
): Promise<PluginNetworkResponse> => {
  const url = validateOptions(options);
  let finalResponseUrl = url.href;
  const responseType = options.responseType ?? 'json';
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // Ordinary HTTPS requests use Node's shared default Agent. A dedicated Agent
  // is created only for non-default TLS policy so sockets with relaxed
  // verification or custom SNI are never pooled across plugin requests.
  const httpsAgent = options.tls
    ? new HttpsAgent({
        rejectUnauthorized: options.tls.rejectUnauthorized,
        servername: options.tls.servername,
      })
    : undefined;

  const config: AxiosRequestConfig = {
    // Force the Node adapter so app-wide Axios defaults can never route plugin
    // requests back through Chromium's restricted network stack.
    adapter: 'http',
    url: url.href,
    method: options.method ?? 'GET',
    headers: normalizeHeaders(options.headers),
    data: normalizeBody(options.body),
    responseType: responseType === 'arrayBuffer' ? 'arraybuffer' : responseType,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxContentLength: maxResponseBytes === 0 ? -1 : maxResponseBytes,
    maxBodyLength: -1,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    beforeRedirect: (_redirectOptions, responseDetails, requestDetails) => {
      const location = responseDetails.headers.location;
      if (typeof location === 'string') {
        finalResponseUrl = new URL(location, requestDetails.url).href;
      }
    },
    decompress: options.decompress ?? true,
    httpsAgent,
    signal,
    proxy: false,
    // HTTP errors remain inspectable responses; transport, timeout and cancel
    // failures still reject the promise.
    validateStatus: () => true,
    transitional: { clarifyTimeoutError: true },
  };

  try {
    const response = await axios.request(config);
    return {
      url: finalResponseUrl,
      status: response.status,
      statusText: response.statusText,
      headers: normalizeResponseHeaders(response),
      data: responseType === 'arrayBuffer' ? toArrayBuffer(response.data) : response.data,
    };
  } catch (error) {
    throw normalizeAxiosError(error) ?? error;
  } finally {
    httpsAgent?.destroy();
  }
};
