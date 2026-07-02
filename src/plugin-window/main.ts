import * as Vue from 'vue';
import './style.css';
import type {
  EchoPluginDescriptor,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
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
  PluginWindowDescriptor,
  PluginShowOnTopOptions,
  PluginHostWindowTarget,
} from '../shared/plugins';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../shared/audio-spectrum';
import { createFontApi } from '../shared/font';

type PluginWindowModule =
  | {
      activateWindow?: (ctx: EchoPluginWindowContext) => unknown;
      activate?: (ctx: EchoPluginWindowContext) => unknown;
      default?: PluginWindowModuleDefault;
    }
  | PluginWindowModuleDefault;

type PluginWindowModuleDefault =
  | ((ctx: EchoPluginWindowContext) => unknown)
  | {
      activateWindow?: (ctx: EchoPluginWindowContext) => unknown;
      activate?: (ctx: EchoPluginWindowContext) => unknown;
      deactivate?: (ctx: EchoPluginWindowContext) => unknown;
    };

interface EchoPluginWindowContext {
  id: string;
  pluginId: string;
  windowId: string;
  manifest: EchoPluginDescriptor['manifest'];
  descriptor: EchoPluginDescriptor;
  windowDescriptor: PluginWindowDescriptor;
  vue: typeof Vue;
  container: HTMLElement;
  nowPlaying: NonNullable<Window['electron']['nowPlaying']>;
  fonts: ReturnType<typeof createFontsApi>;
  audio: {
    spectrum: {
      getStatus: NonNullable<Window['electron']['audioSpectrum']>['getStatus'];
      getSnapshot: NonNullable<Window['electron']['audioSpectrum']>['getSnapshot'];
      subscribe: (
        options: AudioSpectrumOptions,
        handler: (frame: AudioSpectrumFrame) => void,
      ) => () => void;
    };
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  fs: {
    listFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>;
    listImageFiles: NonNullable<Window['electron']['plugins']>['fs']['listImageFiles'];
    getFileUrl: NonNullable<Window['electron']['plugins']>['fs']['getFileUrl'];
    readTextFile: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>;
    readFileBytes: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>;
  };
  process: {
    launch: (options: PluginProcessLaunchOptions) => Promise<PluginProcessLaunchResult>;
    terminate: (pid: number) => Promise<PluginProcessTerminateResult>;
  };
  webServer: {
    listen: (
      handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
      options?: PluginWebServerListenOptions,
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['listen']>;
    status: () => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['status']>;
    close: () => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['close']>;
    onRequest: (
      handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
    ) => () => void;
  };
  sqlite: ReturnType<typeof createPluginSqliteApi>;
  css: {
    inject: (cssText: string, options?: { id?: string }) => () => void;
  };
  window: {
    getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
    move: (
      bounds: Partial<{ x: number; y: number; width: number; height: number }>,
    ) => Promise<unknown>;
    hide: () => Promise<unknown>;
    close: () => Promise<unknown>;
    setIgnoreMouseEvents: (ignore: boolean) => Promise<unknown>;
    setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<unknown>;
    showOnTop: (options?: PluginShowOnTopOptions) => Promise<unknown>;
  };
  host: {
    showOnTop: (
      target?: PluginHostWindowTarget,
      options?: PluginShowOnTopOptions,
    ) => Promise<unknown>;
  };
  electron: Window['electron'];
  dispose: (dispose: () => void) => () => void;
}

const params = new URLSearchParams(window.location.search);
const pluginId = String(params.get('pluginId') || '').trim();
const windowId = String(params.get('windowId') || '').trim();
const root = document.getElementById('app');
const disposables: Array<() => void> = [];
const blobUrls: string[] = [];

document.documentElement.classList.add('plugin-window');
document.body.classList.add('plugin-window');

const setStatus = (message: string) => {
  if (!root) return;
  root.textContent = message;
};

const addDisposable = (dispose: () => void) => {
  disposables.push(dispose);
  return dispose;
};

const createStyleDisposer = (cssText: string, styleId = 'runtime') => {
  const elementId = `echo-plugin-window-style-${pluginId}-${windowId}-${styleId}`;
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.textContent = cssText;
  document.head.appendChild(style);
  return () => style.remove();
};

const reportFailure = (error: unknown, source: string) => {
  const message = error instanceof Error ? error.message : String(error || '插件窗口运行异常');
  void window.electron.plugins?.reportFailure({
    pluginId,
    reason: 'runtime-error',
    message: `${source}: ${message}`,
  });
};

const resolveActivator = (module: PluginWindowModule) => {
  if (typeof module === 'function') return module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginWindowModuleDefault | undefined;
    if (typeof Reflect.get(module, 'activateWindow') === 'function') {
      return (
        Reflect.get(module, 'activateWindow') as (ctx: EchoPluginWindowContext) => unknown
      ).bind(module);
    }
    if (typeof Reflect.get(module, 'activate') === 'function') {
      return (Reflect.get(module, 'activate') as (ctx: EchoPluginWindowContext) => unknown).bind(
        module,
      );
    }
    if (typeof defaultExport === 'function') return defaultExport;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activateWindow === 'function'
    ) {
      return defaultExport.activateWindow.bind(defaultExport);
    }
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activate === 'function'
    ) {
      return defaultExport.activate.bind(defaultExport);
    }
  }
  return null;
};

const cleanup = () => {
  disposables
    .splice(0)
    .reverse()
    .forEach((dispose) => {
      try {
        dispose();
      } catch (error) {
        reportFailure(error, '插件窗口清理');
      }
    });
  blobUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
};

window.addEventListener('beforeunload', cleanup);

const importWindowModule = async (descriptor: EchoPluginDescriptor, source: string) => {
  const blob = new Blob(
    [`${source}\n//# sourceURL=echo-plugin-window:${descriptor.id}:${windowId}`],
    { type: 'text/javascript' },
  );
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return (await import(/* @vite-ignore */ url)) as PluginWindowModule;
};

const requireAudioSpectrumCapability = (descriptor: EchoPluginDescriptor) => {
  if (descriptor.manifest.capabilities?.audioSpectrum !== true) {
    throw new Error('插件未声明音频频谱能力');
  }
};

const createFontsApi = () =>
  createFontApi(() => window.electron.fonts?.getAll?.() ?? Promise.resolve([]));

const serializeForIpc = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

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

const createPluginWebServerApi = (descriptor: EchoPluginDescriptor) => {
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
            const result = await handler(request);
            payload = normalizePluginWebServerResponse(request.requestId, result);
          } catch (error) {
            reportFailure(error, '插件 Web 服务请求');
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

const createPluginSqliteApi = (descriptor: EchoPluginDescriptor) => {
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

const buildContext = (
  descriptor: EchoPluginDescriptor,
  windowDescriptor: PluginWindowDescriptor,
  container: HTMLElement,
): EchoPluginWindowContext => ({
  id: descriptor.id,
  pluginId: descriptor.id,
  windowId: windowDescriptor.id,
  manifest: descriptor.manifest,
  descriptor,
  windowDescriptor,
  vue: Vue,
  container,
  nowPlaying: window.electron.nowPlaying,
  fonts: createFontsApi(),
  audio: {
    spectrum: {
      getStatus: () => {
        requireAudioSpectrumCapability(descriptor);
        return (
          window.electron.audioSpectrum?.getStatus() ??
          Promise.resolve({
            available: false,
            running: false,
            provider: 'unavailable' as const,
            reason: '频谱 API 不可用',
          })
        );
      },
      getSnapshot: () => {
        requireAudioSpectrumCapability(descriptor);
        return window.electron.audioSpectrum?.getSnapshot() ?? Promise.resolve(null);
      },
      subscribe: (options, handler) => {
        requireAudioSpectrumCapability(descriptor);
        return addDisposable(
          window.electron.audioSpectrum?.subscribe(options, handler, {
            pluginId: descriptor.id,
          }) ?? (() => undefined),
        );
      },
    },
  },
  storage: {
    get: <T = unknown>(key: string) =>
      window.electron.plugins?.storage.get<T>(descriptor.id, key) ?? Promise.resolve(null),
    set: (key: string, value: unknown) =>
      window.electron.plugins?.storage.set(descriptor.id, key, value) ?? Promise.resolve(null),
    delete: (key: string) =>
      window.electron.plugins?.storage.delete(descriptor.id, key) ?? Promise.resolve(null),
  },
  fs: {
    listFiles: (directoryPath, options) =>
      window.electron.plugins?.fs.listFiles(descriptor.id, directoryPath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    listImageFiles: (directoryPath, options) =>
      window.electron.plugins?.fs.listImageFiles(directoryPath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    getFileUrl: (filePath) =>
      window.electron.plugins?.fs.getFileUrl(filePath) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    readTextFile: (filePath, options) =>
      window.electron.plugins?.fs.readTextFile(descriptor.id, filePath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    readFileBytes: (filePath, options) =>
      window.electron.plugins?.fs.readFileBytes(descriptor.id, filePath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
  },
  process: {
    launch: (options) =>
      window.electron.plugins?.process.launch(descriptor.id, options) ??
      Promise.resolve({ ok: false, error: '插件进程 API 不可用' }),
    terminate: (pid) =>
      window.electron.plugins?.process.terminate(descriptor.id, pid) ??
      Promise.resolve({ ok: false, error: '插件进程 API 不可用' }),
  },
  webServer: createPluginWebServerApi(descriptor),
  sqlite: createPluginSqliteApi(descriptor),
  css: {
    inject: (cssText, options) =>
      addDisposable(createStyleDisposer(cssText, options?.id || 'runtime')),
  },
  window: {
    getBounds: async () => {
      const result = await window.electron.plugins?.windows.getBounds(
        descriptor.id,
        windowDescriptor.id,
      );
      return result?.ok ? (result.bounds ?? null) : null;
    },
    move: (bounds) =>
      window.electron.plugins?.windows.move(descriptor.id, windowDescriptor.id, bounds) ??
      Promise.resolve(null),
    hide: () =>
      window.electron.plugins?.windows.hide(descriptor.id, windowDescriptor.id) ??
      Promise.resolve(null),
    close: () =>
      window.electron.plugins?.windows.close(descriptor.id, windowDescriptor.id) ??
      Promise.resolve(null),
    setIgnoreMouseEvents: (ignore) =>
      window.electron.plugins?.windows.setIgnoreMouseEvents(
        descriptor.id,
        windowDescriptor.id,
        ignore,
      ) ?? Promise.resolve(null),
    setAlwaysOnTop: (alwaysOnTop) =>
      window.electron.plugins?.windows.show(descriptor.id, windowDescriptor.id, {
        alwaysOnTop,
      }) ?? Promise.resolve(null),
    showOnTop: (options) =>
      window.electron.plugins?.windows.showOnTop(descriptor.id, windowDescriptor.id, options) ??
      Promise.resolve(null),
  },
  host: {
    showOnTop: (target, options) =>
      window.electron.plugins?.host.showOnTop(target, options) ?? Promise.resolve(null),
  },
  electron: window.electron,
  dispose: addDisposable,
});

const bootstrap = async () => {
  if (!root) return;
  if (!pluginId || !windowId) {
    setStatus('插件窗口参数缺失');
    return;
  }
  if (!window.electron.plugins?.windows || !window.electron.nowPlaying) {
    setStatus('插件窗口 API 不可用');
    return;
  }

  const contextResult = await window.electron.plugins.windows.getContext(pluginId, windowId);
  if (!contextResult.ok) {
    setStatus(contextResult.error);
    return;
  }

  if (contextResult.window.style) {
    const styleAsset = await window.electron.plugins.windows.readAsset(pluginId, windowId, 'style');
    if (styleAsset.ok && styleAsset.source) {
      addDisposable(createStyleDisposer(styleAsset.source, 'manifest'));
    }
  }

  const mainAsset = await window.electron.plugins.windows.readAsset(pluginId, windowId, 'main');
  if (!mainAsset.ok) {
    setStatus(mainAsset.error);
    return;
  }

  const module = await importWindowModule(contextResult.plugin, mainAsset.source);
  const activator = resolveActivator(module);
  if (!activator) {
    throw new Error('插件窗口未导出 activateWindow(ctx) 或默认函数');
  }

  root.textContent = '';
  await activator(buildContext(contextResult.plugin, contextResult.window, root));
};

bootstrap().catch((error) => {
  reportFailure(error, '插件窗口启动');
  setStatus(error instanceof Error ? error.message : '插件窗口启动失败');
});
