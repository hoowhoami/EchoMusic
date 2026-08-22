import type {
  EchoPluginDescriptor,
  PluginNetworkJsonValue,
  PluginNetworkRequestOptions,
  PluginNetworkResponse,
} from '../../../shared/plugins';

export type PluginNetworkRequestInit = Omit<PluginNetworkRequestOptions, 'body'> & {
  body?: PluginNetworkRequestOptions['body'] | Blob;
  signal?: AbortSignal;
};

export interface PluginNetworkRequest {
  <T = PluginNetworkJsonValue>(
    options: PluginNetworkRequestInit & { responseType?: 'json' },
  ): Promise<PluginNetworkResponse<T>>;
  (
    options: PluginNetworkRequestInit & { responseType: 'text' },
  ): Promise<PluginNetworkResponse<string>>;
  (
    options: PluginNetworkRequestInit & { responseType: 'arrayBuffer' },
  ): Promise<PluginNetworkResponse<ArrayBuffer>>;
  (options: PluginNetworkRequestInit): Promise<PluginNetworkResponse>;
}

let networkRequestSequence = 0;

const createAbortError = () => new DOMException('The operation was aborted', 'AbortError');

const createRequestId = (pluginId: string) => {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${pluginId}:${Date.now()}:${++networkRequestSequence}:${random}`;
};

const hasContentTypeHeader = (headers: PluginNetworkRequestOptions['headers']) => {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    return headers.some(([name]) => name.toLowerCase() === 'content-type');
  }
  return Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
};

const withBlobContentType = (
  headers: PluginNetworkRequestOptions['headers'],
  contentType: string,
): PluginNetworkRequestOptions['headers'] => {
  if (!contentType || hasContentTypeHeader(headers)) return headers;
  if (Array.isArray(headers)) return [...headers, ['Content-Type', contentType]];
  return { ...headers, 'Content-Type': contentType };
};

export const createPluginNetworkApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const pendingRequestIds = new Set<string>();
  const getNativeApi = () => window.electron.plugins?.net;

  addDisposable(() => {
    const api = getNativeApi();
    if (api) {
      for (const requestId of pendingRequestIds) {
        void api.cancel(descriptor.id, requestId).catch(() => {});
      }
    }
    pendingRequestIds.clear();
  });

  const request = (async (options: PluginNetworkRequestInit): Promise<PluginNetworkResponse> => {
    if (descriptor.manifest.capabilities?.unrestrictedNetwork !== true) {
      throw new Error('插件未声明不受限网络能力');
    }
    const api = getNativeApi();
    if (!api) throw new Error('原生网络 API 不可用');

    const { signal, body, ...requestOptions } = options;
    if (signal?.aborted) throw createAbortError();

    const normalizedBody = body instanceof Blob ? await body.arrayBuffer() : body;
    if (signal?.aborted) throw createAbortError();
    const normalizedOptions: PluginNetworkRequestOptions = {
      ...requestOptions,
      headers:
        body instanceof Blob
          ? withBlobContentType(requestOptions.headers, body.type)
          : requestOptions.headers,
      body: normalizedBody,
    };

    const requestId = createRequestId(descriptor.id);
    const abort = () => {
      void api.cancel(descriptor.id, requestId).catch(() => {});
    };
    pendingRequestIds.add(requestId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await api.request(descriptor.id, requestId, normalizedOptions);
      if (signal?.aborted) throw createAbortError();
      return response;
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw error;
    } finally {
      pendingRequestIds.delete(requestId);
      signal?.removeEventListener('abort', abort);
    }
  }) as PluginNetworkRequest;

  return {
    /** Browser Fetch semantics, including Chromium's forbidden-header rules. */
    fetch: window.fetch.bind(window),
    /** Main-process Axios request using the unrestricted Node.js HTTP adapter. */
    request,
  };
};
