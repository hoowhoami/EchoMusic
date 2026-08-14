import { STATUS_CODES } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { net, session, type ClientRequest, type Session } from 'electron';
import type {
  AxiosAdapter,
  AxiosError,
  AxiosResponse,
  AxiosStatic,
  InternalAxiosRequestConfig,
} from 'axios';
import { normalizeProxyUrl } from '../shared/network';

const KUGOU_API_SESSION_PARTITION = 'echo-kugou-api';
const CAPTURE_REQUEST_HEADER = 'x-echo-transport-request-id';
const DEFAULT_MAX_REDIRECTS = 21;
const BODYLESS_STATUS_CODES = new Set([101, 204, 205, 304]);
const RESTRICTED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie2',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type AxiosRuntime = Pick<AxiosStatic, 'AxiosError' | 'AxiosHeaders'> & {
  getAdapter: (adapters: 'fetch', config?: InternalAxiosRequestConfig) => AxiosAdapter;
};

interface ProxyCredentials {
  username: string;
  password: string;
}

interface ProxyState {
  key: string;
  config: Electron.ProxyConfig;
  credentials?: ProxyCredentials;
}

interface ErrorWithCode extends Error {
  code?: string;
}

interface HeaderCapture {
  setCookies: string[];
}

interface TransportContext {
  config: InternalAxiosRequestConfig;
  headerCapture: HeaderCapture;
  networkSession: Session;
  proxyState: ProxyState;
}

let appliedProxyKey: string | null = null;
let proxyQueue: Promise<void> = Promise.resolve();
let captureSession: Session | null = null;
const pendingTransportContexts = new Map<string, TransportContext>();
const headerCapturesByRequestId = new Map<number, HeaderCapture>();

const getNetworkSession = (): Session => session.fromPartition(KUGOU_API_SESSION_PARTITION);

const captureSetCookieHeaders = (
  source: Record<string, string | string[]> | undefined,
  capture: HeaderCapture,
) => {
  if (!source) return;
  Object.entries(source).forEach(([key, value]) => {
    if (key.toLowerCase() !== 'set-cookie') return;
    capture.setCookies.push(...(Array.isArray(value) ? value : [value]));
  });
};

const findHeaderKey = (headers: Record<string, unknown>, target: string) =>
  Object.keys(headers).find((key) => key.toLowerCase() === target);

const ensureHeaderCapture = (networkSession: Session) => {
  if (captureSession === networkSession) return;
  captureSession = networkSession;

  const filter = { urls: ['http://*/*', 'https://*/*'] };
  networkSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const markerKey = findHeaderKey(details.requestHeaders, CAPTURE_REQUEST_HEADER);
    if (markerKey) {
      const context = pendingTransportContexts.get(details.requestHeaders[markerKey]);
      delete details.requestHeaders[markerKey];
      if (context) headerCapturesByRequestId.set(details.id, context.headerCapture);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  networkSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const capture = headerCapturesByRequestId.get(details.id);
    if (capture) captureSetCookieHeaders(details.responseHeaders, capture);
    callback({});
  });
  const releaseRequestCapture = (details: { id: number }) => {
    headerCapturesByRequestId.delete(details.id);
  };
  networkSession.webRequest.onCompleted(filter, releaseRequestCapture);
  networkSession.webRequest.onErrorOccurred(filter, releaseRequestCapture);
};

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getProxyState = (proxyUrl: string): ProxyState => {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return { key: 'system', config: { mode: 'system' } };
  }

  const parsed = new URL(normalized);
  const proxyRules = `${parsed.protocol}//${parsed.host}`;
  const credentials =
    parsed.username || parsed.password
      ? {
          username: safeDecodeURIComponent(parsed.username),
          password: safeDecodeURIComponent(parsed.password),
        }
      : undefined;
  const credentialKey = credentials ? `\0${credentials.username}\0${credentials.password}` : '';

  return {
    key: `fixed:${proxyRules}${credentialKey}`,
    config: { mode: 'fixed_servers', proxyRules },
    credentials,
  };
};

const ensureProxy = async (proxyUrl: string): Promise<ProxyState> => {
  const desiredState = getProxyState(proxyUrl);
  const applyTask = proxyQueue.then(async () => {
    if (appliedProxyKey === desiredState.key) return;

    const networkSession = getNetworkSession();
    const hadPreviousConfiguration = appliedProxyKey !== null;
    await networkSession.setProxy(desiredState.config);

    // Chromium may otherwise reuse pooled sockets created with the previous proxy.
    // This intentionally happens only after a real settings change.
    if (hadPreviousConfiguration) await networkSession.closeAllConnections();
    appliedProxyKey = desiredState.key;
  });

  // Keep future changes serial even if this application attempt fails. The failed key is
  // not committed, so the next request can retry instead of getting stuck permanently.
  proxyQueue = applyTask.catch(() => undefined);
  await applyTask;
  return desiredState;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

const createCodedError = (message: string, code: string): ErrorWithCode => {
  const error = new Error(message) as ErrorWithCode;
  error.code = code;
  return error;
};

const getAbortReason = (signal: AbortSignal): unknown => {
  if ('reason' in signal && signal.reason !== undefined) return signal.reason;
  return new DOMException('This operation was aborted', 'AbortError');
};

const getRequestHeaders = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!RESTRICTED_REQUEST_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
};

const appendResponseHeaders = (target: Headers, source: Record<string, string | string[]>) => {
  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item) => target.append(key, item));
  });
};

const getRedirectLimit = (config: InternalAxiosRequestConfig) => {
  if (config.maxRedirects === undefined) return DEFAULT_MAX_REDIRECTS;
  if (!Number.isFinite(config.maxRedirects)) return DEFAULT_MAX_REDIRECTS;
  return Math.max(0, Math.trunc(config.maxRedirects));
};

const createLimitedResponseStream = (
  response: Electron.IncomingMessage,
  request: ClientRequest,
  maxContentLength: number,
) => {
  const source = response as unknown as Readable;
  if (maxContentLength < 0) return source;

  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxContentLength) {
        request.abort();
        callback(
          createCodedError(
            `maxContentLength size of ${maxContentLength} exceeded`,
            'ERR_BAD_RESPONSE',
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  source.pipe(limiter);
  return limiter;
};

const toFetchResponse = (
  response: Electron.IncomingMessage,
  request: ClientRequest,
  requestMethod: string,
  maxContentLength: number,
): Response => {
  const headers = new Headers();
  appendResponseHeaders(headers, response.headers);

  const contentLength = Number(headers.get('content-length'));
  if (maxContentLength >= 0 && Number.isFinite(contentLength) && contentLength > maxContentLength) {
    request.abort();
    throw createCodedError(
      `maxContentLength size of ${maxContentLength} exceeded`,
      'ERR_BAD_RESPONSE',
    );
  }

  const status = response.statusCode;
  const hasBody = requestMethod !== 'HEAD' && !BODYLESS_STATUS_CODES.has(status);
  if (!hasBody) {
    // Drain Electron's response so the underlying Chromium request can close cleanly.
    (response as unknown as Readable).resume();
  }
  const body = hasBody
    ? (Readable.toWeb(
        createLimitedResponseStream(response, request, maxContentLength),
      ) as ReadableStream<Uint8Array>)
    : null;

  return new Response(body, {
    status,
    statusText: response.statusMessage,
    headers,
  });
};

const createRedirectResponse = (status: number, responseHeaders: Record<string, string[]>) => {
  const headers = new Headers();
  appendResponseHeaders(headers, responseHeaders);
  return new Response(null, {
    status,
    statusText: STATUS_CODES[status] || '',
    headers,
  });
};

const writeRequestBody = async (input: Request, request: ClientRequest, maxBodyLength: number) => {
  if (!input.body) {
    request.end();
    return;
  }

  const reader = input.body.getReader();
  let sentBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      sentBytes += chunk.length;
      if (maxBodyLength >= 0 && sentBytes > maxBodyLength) {
        throw createCodedError(
          `Request body larger than maxBodyLength limit of ${maxBodyLength}`,
          'ERR_BAD_REQUEST',
        );
      }
      request.write(chunk);
    }
    request.end();
  } finally {
    reader.releaseLock();
  }
};

const chromiumFetch = async (input: URL | Request | string): Promise<Response> => {
  const fetchRequest = input instanceof Request ? input : new Request(input);
  const captureToken = fetchRequest.headers.get(CAPTURE_REQUEST_HEADER);
  if (!captureToken) {
    throw createCodedError('Missing Chromium transport request context', 'ERR_BAD_OPTION');
  }
  const context = pendingTransportContexts.get(captureToken);
  if (!context)
    throw createCodedError('Unknown Chromium transport request context', 'ERR_BAD_OPTION');

  const { config, networkSession, proxyState } = context;
  const signal = fetchRequest.signal;
  if (signal.aborted) throw getAbortReason(signal);

  const redirectLimit = getRedirectLimit(config);
  const requestedRedirectMode = fetchRequest.redirect;
  const redirectMode = config.maxRedirects === 0 ? 'manual' : requestedRedirectMode;
  const maxBodyLength = config.maxBodyLength ?? -1;
  const maxContentLength = config.maxContentLength ?? -1;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let redirectCount = 0;
    let currentMethod = fetchRequest.method.toUpperCase();
    let request: ClientRequest;

    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const resolveOnce = (response: Response, keepAbortListener = false) => {
      if (settled) return;
      settled = true;
      if (!keepAbortListener) cleanup();
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      request?.abort();
      rejectOnce(getAbortReason(signal));
    };

    try {
      const headers = getRequestHeaders(fetchRequest);
      headers[CAPTURE_REQUEST_HEADER] = captureToken;
      request = net.request({
        url: fetchRequest.url,
        method: currentMethod,
        headers,
        session: networkSession,
        redirect: 'manual',
        // Omitting credentials matches Node Axios: proxy auth remains available while the
        // Chromium cookie jar is used only when the caller explicitly opts in.
        credentials: fetchRequest.credentials === 'include' ? 'include' : undefined,
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    request.on('login', (authInfo, callback) => {
      if (authInfo.isProxy && proxyState.credentials) {
        callback(proxyState.credentials.username, proxyState.credentials.password);
      } else {
        callback();
      }
    });

    request.on('redirect', (status, nextMethod, _redirectUrl, responseHeaders) => {
      if (redirectMode === 'manual') {
        resolveOnce(createRedirectResponse(status, responseHeaders));
        request.abort();
        return;
      }
      if (redirectMode === 'error') {
        rejectOnce(new TypeError('fetch failed: redirect mode is set to error'));
        request.abort();
        return;
      }

      redirectCount += 1;
      if (redirectCount > redirectLimit) {
        rejectOnce(
          createCodedError(
            `Maximum number of redirects exceeded (${redirectLimit})`,
            'ERR_FR_TOO_MANY_REDIRECTS',
          ),
        );
        request.abort();
        return;
      }

      currentMethod = nextMethod.toUpperCase();
      request.followRedirect();
    });

    request.on('response', (response) => {
      try {
        const fetchResponse = toFetchResponse(response, request, currentMethod, maxContentLength);
        const responseStream = response as unknown as Readable;
        responseStream.once('end', cleanup);
        responseStream.once('close', cleanup);
        resolveOnce(fetchResponse, true);
      } catch (error) {
        rejectOnce(error);
      }
    });
    request.on('error', rejectOnce);
    request.on('abort', () => {
      if (!settled) rejectOnce(getAbortReason(signal));
    });

    void writeRequestBody(fetchRequest, request, maxBodyLength).catch((error) => {
      request.abort();
      rejectOnce(error);
    });
  });
};

const normalizeAxiosResponse = (
  response: AxiosResponse | undefined,
  responseType: string | undefined,
  setCookies: string[],
) => {
  if (!response) return;

  if (setCookies.length > 0) {
    const headers = response.headers as AxiosResponse['headers'] & {
      set?: (name: string, value: string[], rewrite?: boolean) => unknown;
    };
    if (typeof headers.set === 'function') headers.set('set-cookie', [...setCookies], true);
    else headers['set-cookie'] = [...setCookies];
  }

  if (responseType === 'arraybuffer' && response.data instanceof ArrayBuffer) {
    response.data = Buffer.from(response.data);
  } else if (
    responseType === 'stream' &&
    response.data &&
    typeof response.data.getReader === 'function'
  ) {
    response.data = Readable.fromWeb(response.data as never);
  }
};

export const createElectronAxiosAdapter = (
  axiosModule: AxiosRuntime,
  getProxyUrl: () => string,
): AxiosAdapter => {
  return async (config) => {
    let proxyState: ProxyState;
    try {
      proxyState = await ensureProxy(getProxyUrl());
    } catch (error) {
      throw axiosModule.AxiosError.from(
        error,
        getErrorCode(error) || axiosModule.AxiosError.ERR_NETWORK,
        config,
      );
    }

    const networkSession = getNetworkSession();
    ensureHeaderCapture(networkSession);
    const captureToken = randomUUID();
    const headerCapture: HeaderCapture = { setCookies: [] };
    const headers = axiosModule.AxiosHeaders.from(config.headers);
    headers.set(CAPTURE_REQUEST_HEADER, captureToken);
    const adapterConfig: InternalAxiosRequestConfig = {
      ...config,
      headers,
      env: {
        ...config.env,
        fetch: chromiumFetch,
        Request,
        Response: Response as unknown as NonNullable<InternalAxiosRequestConfig['env']>['Response'],
      },
    };
    pendingTransportContexts.set(captureToken, {
      config: adapterConfig,
      headerCapture,
      networkSession,
      proxyState,
    });
    const fetchAdapter = axiosModule.getAdapter('fetch', adapterConfig);

    try {
      const response = await fetchAdapter(adapterConfig);
      normalizeAxiosResponse(response, config.responseType, headerCapture.setCookies);
      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      normalizeAxiosResponse(axiosError.response, config.responseType, headerCapture.setCookies);
      if (axiosError.code === axiosModule.AxiosError.ETIMEDOUT) {
        axiosError.code = config.transitional?.clarifyTimeoutError
          ? axiosModule.AxiosError.ETIMEDOUT
          : axiosModule.AxiosError.ECONNABORTED;
        if (config.timeoutErrorMessage) axiosError.message = config.timeoutErrorMessage;
      }
      throw error;
    } finally {
      pendingTransportContexts.delete(captureToken);
    }
  };
};
