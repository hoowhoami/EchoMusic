import type {
  EchoPluginDescriptor,
  PluginSqliteOpenOptions,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteRow,
  PluginSqliteStatement,
  PluginWebServerHandlerResult,
  PluginWebServerListenConfig,
  PluginWebServerListenOptions,
  PluginWebServerRequest,
  PluginWebServerResponse,
  PluginWebServerResponsePayload,
  PluginWebSocketCloseEvent,
  PluginWebSocketConnection,
  PluginWebSocketConnectionHandler,
  PluginWebSocketData,
  PluginWebSocketListenOptions,
  PluginWebSocketMessageEvent,
  PluginWebSocketNativeCloseEvent,
  PluginWebSocketNativeErrorEvent,
  PluginWebSocketNativeMessageEvent,
  PluginWebSocketOpenEvent,
  PluginWebSocketUpgradeHandlerResult,
} from '../../../shared/plugins';
import { serializeForIpc } from './ipc';

type PluginCallbackRunner = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
) => T;

type PluginRuntimeErrorReporter = (
  pluginId: string,
  error: unknown,
  source?: string,
  fallback?: string,
) => unknown;

const isArrayBufferLike = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';

const isPluginWebServerBase64Body = (value: unknown): value is { type: 'base64'; data: string } =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.get(value, 'type') === 'base64',
  );

const isPluginWebServerResponseLike = (value: unknown): value is PluginWebServerResponse =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('status' in value || 'headers' in value || 'body' in value),
  );

const normalizePluginWebServerBody = (body: unknown): PluginWebServerResponsePayload['body'] => {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string') return body;
  if (isArrayBufferLike(body) || ArrayBuffer.isView(body)) return body;
  if (isPluginWebServerBase64Body(body)) {
    return {
      type: 'base64' as const,
      data: String(body.data || ''),
    };
  }
  return serializeForIpc(body) as PluginWebServerResponsePayload['body'];
};

const normalizePluginWebServerResponse = (
  requestId: string,
  result: Awaited<PluginWebServerHandlerResult>,
): PluginWebServerResponsePayload => {
  if (result === undefined) {
    return {
      requestId,
      status: 204,
    };
  }

  if (isPluginWebServerResponseLike(result)) {
    return {
      requestId,
      status: result.status,
      headers: serializeForIpc(result.headers) as PluginWebServerResponsePayload['headers'],
      body: normalizePluginWebServerBody(result.body),
    };
  }

  return {
    requestId,
    body: normalizePluginWebServerBody(result),
  };
};

export const createPluginWebServerApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
  runPluginCallback: PluginCallbackRunner,
  reportPluginRuntimeError: PluginRuntimeErrorReporter,
) => {
  const getWebServerApi = () => window.electron.plugins?.webServer;
  const requireWebServerCapability = () => {
    if (descriptor.manifest.capabilities?.webServer !== true) {
      throw new Error('插件未声明 Web 服务能力');
    }
  };
  let closeOnDisposeRegistered = false;
  let listenRequestDisposer: (() => void) | null = null;
  const ensureCloseOnDispose = () => {
    if (closeOnDisposeRegistered) return;
    closeOnDisposeRegistered = true;
    addDisposable(() => {
      void getWebServerApi()?.close(descriptor.id);
    });
  };

  const onRequest = (
    handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
  ) => {
    requireWebServerCapability();
    const dispose =
      getWebServerApi()?.onRequest((request) => {
        if (request.pluginId !== descriptor.id) return;
        void (async () => {
          let payload: PluginWebServerResponsePayload;
          try {
            const result = await runPluginCallback(
              descriptor.id,
              '插件 Web 服务请求',
              () => handler(request),
              { status: 500, body: '插件 Web 服务处理异常' },
            );
            payload = normalizePluginWebServerResponse(request.requestId, result);
          } catch (error) {
            void reportPluginRuntimeError(descriptor.id, error, '插件 Web 服务请求');
            payload = {
              requestId: request.requestId,
              status: 500,
              body: '插件 Web 服务处理异常',
            };
          }
          await getWebServerApi()?.respond(descriptor.id, payload);
        })();
      }) ?? (() => undefined);
    return addDisposable(dispose);
  };

  const onConnection = (
    handler: PluginWebSocketConnectionHandler,
    options?: PluginWebSocketListenOptions,
  ) => {
    requireWebServerCapability();
    ensureCloseOnDispose();
    const native = getWebServerApi();
    if (!native) return () => undefined;

    const expectedPath = options?.path ? String(options.path) : '';
    const sockets = new Map<string, PluginWebSocketConnection>();
    const readyStates = new Map<string, { value: number }>();
    const messageListeners = new Map<string, Set<(event: PluginWebSocketMessageEvent) => void>>();
    const closeListeners = new Map<string, Set<(event: PluginWebSocketCloseEvent) => void>>();
    const errorListeners = new Map<string, Set<(error: Error) => void>>();
    const connectionDisposers = new Map<string, () => void>();

    const normalizeUpgradeDecision = (
      result: Awaited<PluginWebSocketUpgradeHandlerResult>,
    ): { accept: boolean; protocol?: string } => {
      if (result === false) return { accept: false };
      if (result === true || result === undefined) return { accept: true };
      return {
        accept: result.accept !== false,
        protocol: result.protocol,
      };
    };

    const createConnection = (event: PluginWebSocketOpenEvent): PluginWebSocketConnection => {
      const state = { value: 1 };
      readyStates.set(event.connectionId, state);
      return {
        connectionId: event.connectionId,
        protocol: event.protocol,
        url: event.url,
        path: event.path,
        query: event.query,
        headers: event.headers,
        remoteAddress: event.remoteAddress,
        get readyState() {
          return state.value;
        },
        send: (data: PluginWebSocketData) =>
          native.send(descriptor.id, { connectionId: event.connectionId, data }) ??
          Promise.resolve({ ok: false as const, error: '插件 Web 服务 API 不可用' }),
        ping: (data?: PluginWebSocketData) =>
          native.ping(descriptor.id, { connectionId: event.connectionId, data }) ??
          Promise.resolve({ ok: false as const, error: '插件 Web 服务 API 不可用' }),
        close: (code?: number, reason?: string) =>
          native.closeSocket(descriptor.id, {
            connectionId: event.connectionId,
            code,
            reason,
          }) ?? Promise.resolve({ ok: false as const, error: '插件 Web 服务 API 不可用' }),
        onMessage: (listener) => {
          let listeners = messageListeners.get(event.connectionId);
          if (!listeners) {
            listeners = new Set();
            messageListeners.set(event.connectionId, listeners);
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onClose: (listener) => {
          let listeners = closeListeners.get(event.connectionId);
          if (!listeners) {
            listeners = new Set();
            closeListeners.set(event.connectionId, listeners);
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onError: (listener) => {
          let listeners = errorListeners.get(event.connectionId);
          if (!listeners) {
            listeners = new Set();
            errorListeners.set(event.connectionId, listeners);
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    };

    const disposeUpgrade = native.onUpgrade((request) => {
      if (request.pluginId !== descriptor.id) return;
      if (expectedPath && request.path !== expectedPath) return;
      void (async () => {
        let decision: { accept: boolean; protocol?: string } = { accept: true };
        try {
          const result = await runPluginCallback(
            descriptor.id,
            '插件 WebSocket 升级',
            () => options?.onUpgrade?.(request),
            true as const,
          );
          decision = normalizeUpgradeDecision(
            result as Awaited<PluginWebSocketUpgradeHandlerResult>,
          );
        } catch (error) {
          void reportPluginRuntimeError(descriptor.id, error, '插件 WebSocket 升级');
          decision = { accept: false };
        }
        await native.upgrade(descriptor.id, {
          connectionId: request.connectionId,
          accept: decision.accept,
          protocol: decision.protocol,
        });
      })();
    });

    const disposeOpen = native.onOpen((event) => {
      if (event.pluginId !== descriptor.id) return;
      if (expectedPath && event.path !== expectedPath) return;
      const connection = createConnection(event);
      sockets.set(event.connectionId, connection);
      const dispose = runPluginCallback(
        descriptor.id,
        '插件 WebSocket 连接',
        () => handler(connection),
        undefined,
      );
      if (typeof dispose === 'function') {
        connectionDisposers.set(event.connectionId, dispose);
      }
    });

    const disposeMessage = native.onMessage((event: PluginWebSocketNativeMessageEvent) => {
      if (event.pluginId !== descriptor.id) return;
      const listeners = messageListeners.get(event.connectionId);
      if (!listeners?.size) return;
      for (const listener of listeners) {
        runPluginCallback(
          descriptor.id,
          '插件 WebSocket 消息',
          () => listener({ data: event.data }),
          undefined,
        );
      }
    });

    const disposeClose = native.onClose((event: PluginWebSocketNativeCloseEvent) => {
      if (event.pluginId !== descriptor.id) return;
      const state = readyStates.get(event.connectionId);
      if (state) state.value = 3;
      sockets.delete(event.connectionId);
      readyStates.delete(event.connectionId);
      connectionDisposers.get(event.connectionId)?.();
      connectionDisposers.delete(event.connectionId);
      const listeners = closeListeners.get(event.connectionId);
      closeListeners.delete(event.connectionId);
      messageListeners.delete(event.connectionId);
      errorListeners.delete(event.connectionId);
      if (!listeners?.size) return;
      for (const listener of listeners) {
        runPluginCallback(
          descriptor.id,
          '插件 WebSocket 关闭',
          () => listener({ code: event.code, reason: event.reason }),
          undefined,
        );
      }
    });

    const disposeError = native.onError((event: PluginWebSocketNativeErrorEvent) => {
      if (event.pluginId !== descriptor.id) return;
      const listeners = errorListeners.get(event.connectionId);
      if (!listeners?.size) return;
      const error = new Error(event.error);
      for (const listener of listeners) {
        runPluginCallback(descriptor.id, '插件 WebSocket 错误', () => listener(error), undefined);
      }
    });

    return addDisposable(() => {
      disposeUpgrade();
      disposeOpen();
      disposeMessage();
      disposeClose();
      disposeError();
      for (const dispose of connectionDisposers.values()) dispose();
      connectionDisposers.clear();
      sockets.clear();
      readyStates.clear();
      messageListeners.clear();
      closeListeners.clear();
      errorListeners.clear();
    });
  };

  const listen = async (
    handlerOrOptions?:
      | ((request: PluginWebServerRequest) => PluginWebServerHandlerResult)
      | PluginWebServerListenConfig,
    options?: PluginWebServerListenConfig,
  ) => {
    requireWebServerCapability();
    const config = typeof handlerOrOptions === 'function' ? options : handlerOrOptions;
    const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : config?.onRequest;
    listenRequestDisposer?.();
    const disposeRequestHandler = handler
      ? onRequest(handler)
      : onRequest(() => ({ status: 404, body: 'Not Found' }));
    listenRequestDisposer = disposeRequestHandler;
    ensureCloseOnDispose();
    const nativeOptions: PluginWebServerListenOptions | undefined = config
      ? {
          port: config.port,
          host: config.host,
          maxConnections: config.maxConnections,
          maxMessageBytes: config.maxMessageBytes,
          maxBufferedBytes: config.maxBufferedBytes,
        }
      : undefined;
    const result = (await getWebServerApi()?.listen(
      descriptor.id,
      serializeForIpc(nativeOptions) as PluginWebServerListenOptions,
    )) ?? { ok: false as const, error: '插件 Web 服务 API 不可用' };
    if (!result.ok) {
      disposeRequestHandler();
      if (listenRequestDisposer === disposeRequestHandler) listenRequestDisposer = null;
      return result;
    }
    if (config?.onConnection) {
      onConnection(config.onConnection, {
        path: config.path,
        onUpgrade: config.onUpgrade,
      });
    }
    return result;
  };

  return {
    listen,
    status: () => {
      requireWebServerCapability();
      return (
        getWebServerApi()?.status(descriptor.id) ??
        Promise.resolve({ ok: false as const, error: '插件 Web 服务 API 不可用' })
      );
    },
    close: () => {
      requireWebServerCapability();
      return (
        getWebServerApi()?.close(descriptor.id) ??
        Promise.resolve({ ok: false as const, error: '插件 Web 服务 API 不可用' })
      );
    },
    onRequest,
    onConnection,
  };
};

export const createPluginSqliteApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const getSqliteApi = () => window.electron.plugins?.sqlite;
  const openDatabaseIds = new Set<string>();
  const requireSqliteCapability = () => {
    if (descriptor.manifest.capabilities?.sqlite !== true) {
      throw new Error('插件未声明 SQLite 能力');
    }
  };

  const closeDatabase = async (databaseId: string) => {
    const result = (await getSqliteApi()?.close(descriptor.id, databaseId)) ?? {
      ok: false as const,
      error: '插件 SQLite API 不可用',
    };
    if (result.ok) openDatabaseIds.delete(databaseId);
    return result;
  };

  addDisposable(() => {
    for (const databaseId of openDatabaseIds) {
      void getSqliteApi()?.close(descriptor.id, databaseId);
    }
    openDatabaseIds.clear();
  });

  return {
    open: async (options?: PluginSqliteOpenOptions) => {
      requireSqliteCapability();
      const result = (await getSqliteApi()?.open(
        descriptor.id,
        serializeForIpc(options) as PluginSqliteOpenOptions,
      )) ?? { ok: false as const, error: '插件 SQLite API 不可用' };
      if (!result.ok) return result;

      const databaseId = result.databaseId;
      openDatabaseIds.add(databaseId);
      return {
        ...result,
        exec: (sql: string) =>
          getSqliteApi()?.exec(descriptor.id, databaseId, sql) ??
          Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' }),
        run: (sql: string, params?: PluginSqliteParams) =>
          getSqliteApi()?.run(
            descriptor.id,
            databaseId,
            sql,
            serializeForIpc(params) as PluginSqliteParams,
          ) ?? Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' }),
        all: (sql: string, params?: PluginSqliteParams, queryOptions?: PluginSqliteQueryOptions) =>
          getSqliteApi()?.all(
            descriptor.id,
            databaseId,
            sql,
            serializeForIpc(params) as PluginSqliteParams,
            serializeForIpc(queryOptions) as PluginSqliteQueryOptions,
          ) ?? Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' }),
        get: async (sql: string, params?: PluginSqliteParams) => {
          const queryResult = (await getSqliteApi()?.get(
            descriptor.id,
            databaseId,
            sql,
            serializeForIpc(params) as PluginSqliteParams,
          )) ?? { ok: false as const, error: '插件 SQLite API 不可用' };
          if (!queryResult.ok) return queryResult;
          return {
            ok: true as const,
            row: (queryResult.rows[0] ?? null) as PluginSqliteRow | null,
          };
        },
        transaction: (statements: PluginSqliteStatement[]) =>
          getSqliteApi()?.transaction(
            descriptor.id,
            databaseId,
            serializeForIpc(statements) as PluginSqliteStatement[],
          ) ?? Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' }),
        close: () => closeDatabase(databaseId),
      };
    },
    listDatabases: () => {
      requireSqliteCapability();
      return (
        getSqliteApi()?.list(descriptor.id) ??
        Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' })
      );
    },
    deleteDatabase: (name?: string) => {
      requireSqliteCapability();
      return (
        getSqliteApi()?.delete(descriptor.id, name) ??
        Promise.resolve({ ok: false as const, error: '插件 SQLite API 不可用' })
      );
    },
  };
};
