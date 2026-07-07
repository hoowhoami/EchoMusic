import { session } from 'electron';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { normalizeProxyUrl } from '../shared/network';

const KUGOU_API_SESSION_PARTITION = 'echo-kugou-api';

let appliedProxyKey: string | null = null;
let proxyPromise: Promise<void> = Promise.resolve();

const getProxyRules = (proxyUrl: string) => {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};

const ensureProxy = async (proxyUrl: string) => {
  const proxyRules = getProxyRules(proxyUrl);
  const proxyKey = proxyRules || 'system';
  if (appliedProxyKey === proxyKey) return proxyPromise;

  appliedProxyKey = proxyKey;
  const ses = session.fromPartition(KUGOU_API_SESSION_PARTITION);
  proxyPromise = ses.setProxy(proxyRules ? { proxyRules } : { mode: 'system' });
  await proxyPromise;
};

const toHeaderObject = (headers: unknown): Record<string, string> => {
  const source =
    headers && typeof headers === 'object' && 'toJSON' in headers
      ? (headers as { toJSON: () => Record<string, unknown> }).toJSON()
      : ((headers ?? {}) as Record<string, unknown>);
  return Object.entries(source).reduce<Record<string, string>>((result, [key, value]) => {
    if (value === undefined || value === null || value === false) return result;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'content-length' || lowerKey === 'host') return result;
    result[key] = String(value);
    return result;
  }, {});
};

const toBody = (method: string, data: unknown): BodyInit | undefined => {
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (data === undefined || data === null) return undefined;
  const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
  const isFormData = typeof FormData !== 'undefined' && data instanceof FormData;
  if (
    typeof data === 'string' ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    isBlob ||
    isFormData ||
    data instanceof URLSearchParams
  ) {
    return data as BodyInit;
  }
  return JSON.stringify(data);
};

const readResponseData = async (response: Response, responseType?: string) => {
  if (responseType === 'stream') return response.body;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (responseType === 'arraybuffer') return buffer;
  return buffer.toString('utf8');
};

const createAxiosHttpError = (
  message: string,
  config: InternalAxiosRequestConfig,
  request: unknown,
  response: AxiosResponse,
) => {
  const error = new Error(message) as Error & {
    config?: InternalAxiosRequestConfig;
    request?: unknown;
    response?: AxiosResponse;
    isAxiosError?: boolean;
  };
  error.config = config;
  error.request = request;
  error.response = response;
  error.isAxiosError = true;
  return error;
};

export const createElectronAxiosAdapter = (
  axiosModule: { getUri: (config: InternalAxiosRequestConfig) => string },
  getProxyUrl: () => string,
): AxiosAdapter => {
  return async (config) => {
    await ensureProxy(getProxyUrl());

    const url = axiosModule.getUri(config);
    const method = String(config.method || 'GET').toUpperCase();
    const controller = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    if (config.signal) {
      if (config.signal.aborted) controller.abort();
      else config.signal.addEventListener?.('abort', () => controller.abort(), { once: true });
    }
    if (config.timeout && config.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeout);
    }

    const request = { url, method };
    try {
      const response = await session.fromPartition(KUGOU_API_SESSION_PARTITION).fetch(url, {
        method,
        headers: toHeaderObject(config.headers),
        body: toBody(method, config.data),
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const axiosResponse: AxiosResponse = {
        data: await readResponseData(response, config.responseType),
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        config,
        request,
      };

      const validateStatus = config.validateStatus;
      if (!response.status || !validateStatus || validateStatus(response.status)) {
        return axiosResponse;
      }
      throw createAxiosHttpError(
        `Request failed with status code ${response.status}`,
        config,
        request,
        axiosResponse,
      );
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error(`timeout of ${config.timeout}ms exceeded`) as Error & {
          code?: string;
          config?: InternalAxiosRequestConfig;
          request?: unknown;
        };
        timeoutError.code = 'ECONNABORTED';
        timeoutError.config = config;
        timeoutError.request = request;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  };
};
