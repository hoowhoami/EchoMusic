import type { EchoPluginDescriptor } from '../../../shared/plugins';
import type { PluginTcpConnectOptions, PluginTcpConnection } from '../../../shared/plugin-tcp';

let connectionSequence = 0;

export const createPluginTcpApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  let disposed = false;
  const connections = new Map<string, () => Promise<void>>();
  addDisposable(() => {
    disposed = true;
    for (const close of connections.values()) void close().catch(() => {});
    connections.clear();
  });

  return {
    async connect(options: PluginTcpConnectOptions): Promise<PluginTcpConnection> {
      if (disposed) throw new Error('插件 TCP 上下文已释放');
      if (descriptor.manifest.capabilities?.tcp !== true) {
        throw new Error('插件未声明 TCP 能力');
      }
      const api = window.electron.plugins?.net.tcp;
      if (!api) throw new Error('TCP API 不可用，请升级 EchoMusic');
      if (connections.size >= 16) throw new Error('TCP 连接数量已达到上限');
      const { signal, ...nativeOptions } = options;
      signal?.throwIfAborted();
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${++connectionSequence}-${Math.random().toString(36).slice(2)}`;
      let closed = false;
      let closing: Promise<void> | undefined;
      let reading = false;
      let pendingBytes = 0;
      let pendingWrites = 0;
      let ending: Promise<void> | undefined;
      let closeReason: unknown;
      const pendingOperations = new Set<(error: unknown) => void>();
      const onAbort = () => void close(signal!.reason).catch(() => {});
      const close = (reason: unknown = new Error('TCP 连接已关闭')) => {
        if (closing) return closing;
        closed = true;
        closeReason = reason;
        signal?.removeEventListener('abort', onAbort);
        for (const reject of pendingOperations) reject(reason);
        connections.delete(id);
        closing = api.close(descriptor.id, id);
        return closing;
      };
      const checkOpen = () => {
        if (closed) throw closeReason;
        if (disposed) throw new Error('插件 TCP 上下文已释放');
      };
      // Reject locally on cancellation even if the IPC reply is delayed. Closing the
      // socket prevents a canceled read/write from silently consuming part of a frame.
      const run = <T>(operation: () => Promise<T>, operationSignal?: AbortSignal): Promise<T> => {
        checkOpen();
        operationSignal?.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
          const cleanup = () => {
            pendingOperations.delete(cancel);
            operationSignal?.removeEventListener('abort', abort);
          };
          const cancel = (error: unknown) => {
            cleanup();
            reject(error);
          };
          const abort = () => void close(operationSignal!.reason).catch(() => {});
          pendingOperations.add(cancel);
          operationSignal?.addEventListener('abort', abort, { once: true });
          try {
            operation().then((value) => {
              cleanup();
              resolve(value);
            }, cancel);
          } catch (error) {
            cancel(error);
          }
        });
      };
      const fail = (error: unknown): never => {
        void close(error).catch(() => {});
        throw error;
      };
      // Register before awaiting connect so disabling also cancels an in-flight handshake.
      connections.set(id, close);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await run(() => api.connect(descriptor.id, id, nativeOptions));
        checkOpen();
      } catch (error) {
        fail(error);
      }
      return {
        async read(options) {
          checkOpen();
          options?.signal?.throwIfAborted();
          if (reading) throw new Error('TCP 每个连接只能有一个待完成的 read');
          reading = true;
          try {
            const data = await run(() => api.read(descriptor.id, id), options?.signal);
            checkOpen();
            if (data === null) {
              // Do not destroy queued writes if the peer's FIN races our own end().
              if (ending) void ending.then(() => close()).catch(() => {});
              else await close();
            }
            return data;
          } catch (error) {
            return fail(error);
          } finally {
            reading = false;
          }
        },
        async write(data, options) {
          checkOpen();
          options?.signal?.throwIfAborted();
          if (ending) throw new Error('TCP 已结束写入');
          if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
            throw new Error('TCP write 仅支持 ArrayBuffer 或 Uint8Array');
          }
          const size = data.byteLength;
          if (size > 1024 * 1024) throw new Error('TCP 单次写入不能超过 1 MiB');
          if (pendingBytes + size > 4 * 1024 * 1024 || pendingWrites >= 64) {
            throw new Error('TCP 发送队列已满，请等待 write 完成');
          }
          pendingBytes += size;
          pendingWrites++;
          try {
            await run(() => api.write(descriptor.id, id, data), options?.signal);
          } catch (error) {
            fail(error);
          } finally {
            pendingBytes -= size;
            pendingWrites--;
          }
        },
        async end(options) {
          checkOpen();
          options?.signal?.throwIfAborted();
          // Share one FIN and deadline across repeated calls. Any active caller may abort.
          ending ??= run(() => api.end(descriptor.id, id)).catch(fail);
          return run(() => ending!, options?.signal);
        },
        close: () => close(),
      };
    },
  };
};
