import type {
  DirectoryRef,
  DirectoryRequest,
  FilesRequest,
  FileRef,
  MediaLease,
  ResourceMethod,
  PluginResourceError,
  DownloadTarget,
} from '../../../shared/pluginFiles';
import type {
  DownloadHandle,
  DownloadOptions,
  DownloadSnapshot,
  DownloadSource,
  DownloadResult,
} from '../../../shared/pluginDownloads';

export function createPluginResourceApi(
  pluginId: string,
  addDisposable: (fn: () => void) => unknown,
) {
  let disposed = false;
  const contextId =
    globalThis.crypto.randomUUID?.() ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  const leases = new Set<() => Promise<unknown>>();
  const cache = new Map<string, DownloadSnapshot>();
  const listeners = new Map<string, Set<(s: DownloadSnapshot) => void>>();
  const pending = new Set<() => void>();
  const native = () => window.electron.plugins?.resources;
  const failure = (e: PluginResourceError) =>
    Object.assign(new Error(e.message), {
      name: 'PluginDownloadError',
      code: e.code,
      retryable: e.retryable,
    });
  const call = async <T>(method: ResourceMethod, input?: unknown): Promise<T> => {
    if (disposed) throw failure({ code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' });
    const api = native();
    if (!api) throw failure({ code: 'PLUGIN_UNAVAILABLE', message: '请更新宿主以使用资源 API' });
    bind();
    const result = await api.call<T>(pluginId, method, input, contextId);
    if (disposed) throw failure({ code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' });
    if (!result.ok) throw failure(result.error);
    return result.value;
  };
  const accept = (s: DownloadSnapshot) => {
    if (disposed || (cache.get(s.id)?.revision ?? -1) >= s.revision) return;
    cache.set(s.id, s);
    for (const fn of listeners.get(s.id) ?? []) {
      try {
        fn(s);
      } catch (error) {
        globalThis.console.warn('[PluginDownload] subscriber failed', error);
      }
    }
  };
  let stop: (() => void) | undefined;
  const bind = () => {
    stop ??= native()?.onDownload(pluginId, accept, contextId);
  };
  addDisposable(() => {
    disposed = true;
    for (const reject of pending) reject();
    pending.clear();
    listeners.clear();
    cache.clear();
    void Promise.all([...leases].map((release) => release())).finally(() => stop?.());
  });
  const handle = (initial: DownloadSnapshot): DownloadHandle => {
    accept(initial);
    const id = initial.id;
    const control = async (
      method: 'downloadPause' | 'downloadResume' | 'downloadRetry' | 'downloadCancel',
      source?: DownloadSource,
    ) => {
      const s = await call<DownloadSnapshot>(method, { id, source });
      accept(s);
      return s;
    };
    const subscribe = (fn: (s: DownloadSnapshot) => void) => {
      if (disposed) throw failure({ code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' });
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(fn);
      fn(cache.get(id)!);
      return () => {
        set!.delete(fn);
      };
    };
    return {
      id,
      getSnapshot: async () => {
        const s = await call<DownloadSnapshot>('downloadGet', { id });
        accept(s);
        return cache.get(id)!;
      },
      subscribe,
      pause: () => control('downloadPause'),
      resume: (source) => control('downloadResume', source),
      retry: (source) => control('downloadRetry', source),
      cancel: () => control('downloadCancel'),
      wait: async (options = {}) => {
        if (options.signal?.aborted) throw new DOMException('等待已取消', 'AbortError');
        const s = await call<DownloadSnapshot>('downloadGet', { id });
        accept(s);
        const run = cache.get(id)!.runId;
        return new Promise<DownloadResult>((resolve, reject) => {
          let unsubscribe = () => {};
          let finished = false;
          const cleanup = () => {
            unsubscribe();
            options.signal?.removeEventListener('abort', abort);
            pending.delete(abort);
          };
          const finish = (error?: Error, result?: DownloadResult) => {
            if (finished) return;
            finished = true;
            cleanup();
            if (error) reject(error);
            else resolve(result!);
          };
          const abort = () => finish(new DOMException('等待已取消', 'AbortError'));
          pending.add(abort);
          options.signal?.addEventListener('abort', abort, { once: true });
          unsubscribe = subscribe((current) => {
            if (current.runId !== run)
              finish(failure({ code: 'STALE_RUN', message: '任务已开始新一轮' }));
            else if (current.state === 'completed') finish(undefined, current.result);
            else if (['failed', 'canceled', 'interrupted'].includes(current.state))
              finish(
                failure(current.error ?? { code: 'NETWORK_INTERRUPTED', message: '任务已中断' }),
              );
          });
          if (finished) unsubscribe();
          if (options.signal?.aborted) abort();
        });
      },
    };
  };
  const request = async <T extends object>(
    method: ResourceMethod,
    input: unknown,
  ): Promise<({ ok: true } & T) | { ok: false; error: PluginResourceError }> => {
    if (disposed)
      return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' } };
    const api = native();
    if (!api)
      return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '资源 API 不可用' } };
    bind();
    const result = await api.call<T>(pluginId, method, input, contextId);
    if (disposed)
      return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' } };
    return result.ok ? { ok: true, ...result.value } : result;
  };
  const files = {
    requestDirectory: (options: DirectoryRequest) =>
      request<{ canceled: true } | { canceled: false; directory: DirectoryRef }>(
        'requestDirectory',
        options,
      ),
    requestFiles: (options: FilesRequest) =>
      request<{ canceled: true } | { canceled: false; files: FileRef[] }>('requestFiles', options),
    reauthorizeDirectoryGrant: (id: string, options: DirectoryRequest) =>
      request<{ canceled: true } | { canceled: false; directory: DirectoryRef }>(
        'reauthorizeDirectoryGrant',
        { id, request: options },
      ),
    listDirectoryGrants: () => call<DirectoryRef[]>('listDirectoryGrants'),
    revokeDirectoryGrant: (id: string) => call<boolean>('revokeDirectoryGrant', { id }),
    revokeFileGrant: (id: string) => call<boolean>('revokeFileGrant', { id }),
    getPrivateDirectory: (options: { kind: 'data' | 'cache' }) =>
      call<DirectoryRef>('getPrivateDirectory', options),
    stat: (ref: FileRef) => call<import('../../../shared/pluginFiles').FileStat>('stat', { ref }),
    mkdir: (ref: FileRef) => call<boolean>('mkdir', { ref }),
    copyFile: async (
      source: FileRef,
      target: DownloadTarget,
      options: { conflict?: 'fail' | 'rename' | 'replace' } = {},
    ) => handle(await call<DownloadSnapshot>('copyFile', { source, target, ...options })),
    openMedia: async (ref: FileRef) => {
      const lease = await call<MediaLease>('openMedia', { ref });
      let released = false;
      const cleanup = async () => {
        if (released) return;
        released = true;
        leases.delete(cleanup);
        await native()
          ?.call(pluginId, 'releaseMedia', { id: lease.id }, contextId)
          .catch(() => {});
      };
      leases.add(cleanup);
      return {
        ...lease,
        release: () => {
          void cleanup();
        },
      };
    },
  };
  return {
    files,
    request,
    call,
    download: async (options: DownloadOptions) =>
      handle(await call<DownloadSnapshot>('download', options)),
    downloads: {
      list: (options: { offset?: number; limit?: number } = {}) =>
        call<DownloadSnapshot[]>('downloadList', options),
      get: (id: string) => call<DownloadSnapshot>('downloadGet', { id }),
      attach: async (id: string) => handle(await call<DownloadSnapshot>('downloadGet', { id })),
      remove: (id: string) => call<boolean>('downloadRemove', { id }),
    },
  };
}
