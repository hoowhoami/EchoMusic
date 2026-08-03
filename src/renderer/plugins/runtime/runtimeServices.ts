import type {
  EchoPluginDescriptor,
  PluginSqliteOpenOptions,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteRow,
  PluginSqliteStatement,
  PluginWebServerHandlerResult,
  PluginWebServerListenOptions,
  PluginWebServerRequest,
  PluginWebServerResponse,
  PluginWebServerResponsePayload,
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

  return {
    listen: async (
      handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
      options?: PluginWebServerListenOptions,
    ) => {
      requireWebServerCapability();
      listenRequestDisposer?.();
      const disposeRequestHandler = onRequest(handler);
      listenRequestDisposer = disposeRequestHandler;
      ensureCloseOnDispose();
      const result = (await getWebServerApi()?.listen(
        descriptor.id,
        serializeForIpc(options) as PluginWebServerListenOptions,
      )) ?? { ok: false as const, error: '插件 Web 服务 API 不可用' };
      if (!result.ok) {
        disposeRequestHandler();
        if (listenRequestDisposer === disposeRequestHandler) listenRequestDisposer = null;
      }
      return result;
    },
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
