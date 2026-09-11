import { Socket } from 'node:net';
import type { PluginTcpNativeConnectOptions } from '../../shared/plugin-tcp';

const READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 4 * MAX_WRITE_BYTES;
const MAX_PENDING_WRITES = 64;
const MAX_PLUGIN_CONNECTIONS = 16;
const MAX_CONNECTIONS = 128;

export class PluginTcpError extends Error {}

interface Connection {
  ownerId: number;
  pluginId: string;
  socket: Socket;
  connected: boolean;
  error?: Error;
  reading: boolean;
  pendingBytes: number;
  pendingWrites: number;
  writeTimeoutMs: number;
  ending?: Promise<void>;
}

const deadline = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 120000) {
    throw new PluginTcpError('TCP 超时必须是 1..120000 毫秒的整数');
  }
  return Number(value);
};

const validateOptions = (options: PluginTcpNativeConnectOptions) => {
  if (!options || typeof options !== 'object') throw new PluginTcpError('TCP 连接参数无效');
  if (
    typeof options.host !== 'string' ||
    !options.host.trim() ||
    options.host.length > 253 ||
    /[\s\0/\\]/.test(options.host)
  )
    throw new PluginTcpError('TCP host 必须是主机名或 IP 地址');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new PluginTcpError('TCP port 必须是 1..65535 的整数');
  }
  if (options.noDelay !== undefined && typeof options.noDelay !== 'boolean') {
    throw new PluginTcpError('TCP noDelay 必须是布尔值');
  }
  if (options.keepAlive !== undefined && typeof options.keepAlive !== 'boolean') {
    throw new PluginTcpError('TCP keepAlive 必须是布尔值');
  }
  const keepAliveInitialDelayMs =
    options.keepAliveInitialDelayMs === undefined ? 30000 : options.keepAliveInitialDelayMs;
  if (
    !Number.isInteger(keepAliveInitialDelayMs) ||
    keepAliveInitialDelayMs < 0 ||
    keepAliveInitialDelayMs > 2147483647
  ) {
    throw new PluginTcpError('TCP keepAliveInitialDelayMs 必须是 0..2147483647 毫秒的整数');
  }
  return {
    host: options.host,
    port: options.port,
    noDelay: options.noDelay ?? true,
    keepAlive: options.keepAlive ?? false,
    keepAliveInitialDelayMs,
    connectTimeoutMs: deadline(options.connectTimeoutMs, 5000),
    writeTimeoutMs: deadline(options.writeTimeoutMs, 10000),
  };
};

/** No Electron dependency: the IPC adapter supplies ownership and lifecycle hooks. */
export const createPluginTcpManager = (createSocket: () => Socket = () => new Socket()) => {
  const connections = new Map<string, Connection>();
  const keyFor = (ownerId: number, pluginId: string, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 128) {
      throw new PluginTcpError('TCP 连接 ID 无效');
    }
    return JSON.stringify([ownerId, pluginId, id]);
  };
  const get = (ownerId: number, pluginId: string, id: string) => {
    const connection = connections.get(keyFor(ownerId, pluginId, id));
    if (!connection) throw new PluginTcpError('TCP 连接不存在或已释放');
    return connection;
  };
  const abort = (connection: Connection) => {
    connection.error ??= new PluginTcpError('TCP 连接已关闭');
    connection.socket.destroy();
  };

  return {
    async connect(
      ownerId: number,
      pluginId: string,
      id: string,
      input: PluginTcpNativeConnectOptions,
    ) {
      const options = validateOptions(input);
      const key = keyFor(ownerId, pluginId, id);
      if (connections.has(key)) throw new PluginTcpError('TCP 连接 ID 重复');
      const count = [...connections.values()].filter((item) => item.pluginId === pluginId).length;
      if (count >= MAX_PLUGIN_CONNECTIONS || connections.size >= MAX_CONNECTIONS) {
        throw new PluginTcpError('TCP 连接数量已达到上限');
      }
      // Non-flowing reads keep buffering bounded, including while the renderer is stalled.
      const socket = createSocket();
      // Each bounded in-flight write waits for close, alongside the connect/read listeners.
      socket.setMaxListeners(MAX_PENDING_WRITES + 8);
      const connection: Connection = {
        ownerId,
        pluginId,
        socket,
        connected: false,
        reading: false,
        pendingBytes: 0,
        pendingWrites: 0,
        writeTimeoutMs: options.writeTimeoutMs,
      };
      connections.set(key, connection);
      socket.on('error', (error) => {
        connection.error = new PluginTcpError(error.message);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('error', onError);
            socket.off('close', onClose);
          };
          const onConnect = () => {
            cleanup();
            connection.connected = true;
            resolve();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(new PluginTcpError(error.message));
          };
          const onClose = () => onError(connection.error ?? new PluginTcpError('TCP 连接已关闭'));
          const timer = setTimeout(() => {
            const error = new PluginTcpError('TCP 连接超时');
            onError(error);
            connection.error = error;
            socket.destroy();
          }, options.connectTimeoutMs);
          socket.once('connect', onConnect);
          socket.once('error', onError);
          socket.once('close', onClose);
          try {
            socket.setNoDelay(options.noDelay);
            socket.setKeepAlive(options.keepAlive, options.keepAliveInitialDelayMs);
            socket.connect({ host: options.host, port: options.port });
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        if (connections.get(key) === connection) connections.delete(key);
        socket.destroy();
        throw error;
      }
    },

    async read(ownerId: number, pluginId: string, id: string): Promise<ArrayBuffer | null> {
      const connection = get(ownerId, pluginId, id);
      if (!connection.connected) throw new PluginTcpError('TCP 尚未连接');
      if (connection.reading) throw new PluginTcpError('TCP 每个连接只能有一个待完成的 read');
      connection.reading = true;
      const { socket } = connection;
      try {
        return await new Promise<ArrayBuffer | null>((resolve, reject) => {
          const cleanup = () => {
            socket.off('readable', consume);
            socket.off('end', consume);
            socket.off('close', consume);
            socket.off('error', consume);
          };
          const consume = () => {
            if (connection.error) {
              cleanup();
              reject(connection.error);
              return;
            }
            const data: Buffer | null = socket.read(
              Math.min(READ_BYTES, socket.readableLength) || READ_BYTES,
            );
            if (data !== null) {
              cleanup();
              resolve(Uint8Array.from(data).buffer);
            } else if (socket.readableEnded || socket.destroyed) {
              cleanup();
              resolve(null);
            }
          };
          socket.on('readable', consume);
          socket.once('end', consume);
          socket.once('close', consume);
          socket.once('error', consume);
          consume();
        });
      } finally {
        connection.reading = false;
      }
    },

    async write(ownerId: number, pluginId: string, id: string, data: ArrayBuffer | Uint8Array) {
      const connection = get(ownerId, pluginId, id);
      if (!connection.connected) throw new PluginTcpError('TCP 尚未连接');
      if (connection.error) throw connection.error;
      if (connection.ending || connection.socket.destroyed || connection.socket.writableEnded) {
        throw new PluginTcpError('TCP 连接不可写');
      }
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
        throw new PluginTcpError('TCP write 仅支持 ArrayBuffer 或 Uint8Array');
      }
      const size = data.byteLength;
      if (size > MAX_WRITE_BYTES) throw new PluginTcpError('TCP 单次写入不能超过 1 MiB');
      if (!size) return;
      if (
        connection.pendingBytes + size > MAX_PENDING_WRITE_BYTES ||
        connection.pendingWrites >= MAX_PENDING_WRITES
      ) {
        throw new PluginTcpError('TCP 发送队列已满，请等待 write 完成');
      }
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, size);
      connection.pendingBytes += size;
      connection.pendingWrites++;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            connection.socket.off('close', onClose);
            if (error) reject(new PluginTcpError(error.message));
            else resolve();
          };
          const onClose = () => finish(connection.error ?? new PluginTcpError('TCP 写入中断'));
          const timer = setTimeout(() => {
            const error = new PluginTcpError('TCP 写入超时');
            finish(error);
            connection.error = error;
            connection.socket.destroy();
          }, connection.writeTimeoutMs);
          connection.socket.once('close', onClose);
          try {
            connection.socket.write(bytes, finish);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } finally {
        connection.pendingBytes -= size;
        connection.pendingWrites--;
      }
    },

    async end(ownerId: number, pluginId: string, id: string) {
      const connection = get(ownerId, pluginId, id);
      if (!connection.connected) throw new PluginTcpError('TCP 尚未连接');
      if (connection.ending) return connection.ending;
      if (connection.error) throw connection.error;
      const { socket } = connection;
      if (socket.destroyed) throw new PluginTcpError('TCP 连接已关闭');
      connection.ending = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off('close', onClose);
          socket.off('error', finish);
          if (error) reject(new PluginTcpError(error.message));
          else resolve();
        };
        const onClose = () => finish(connection.error ?? new PluginTcpError('TCP 结束写入中断'));
        const timer = setTimeout(() => {
          const error = new PluginTcpError('TCP 结束写入超时');
          finish(error);
          connection.error = error;
          socket.destroy();
        }, connection.writeTimeoutMs);
        socket.once('close', onClose);
        socket.once('error', finish);
        try {
          // Node queues FIN after all prior writes. The readable side remains open.
          socket.end(finish);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return connection.ending;
    },

    close(ownerId: number, pluginId: string, id: string) {
      const key = keyFor(ownerId, pluginId, id);
      const connection = connections.get(key);
      if (!connection) return;
      connections.delete(key);
      abort(connection);
    },

    closeAll(filter: { ownerId?: number; pluginId?: string } = {}) {
      for (const [key, connection] of connections) {
        if (filter.ownerId !== undefined && filter.ownerId !== connection.ownerId) continue;
        if (filter.pluginId !== undefined && filter.pluginId !== connection.pluginId) continue;
        connections.delete(key);
        abort(connection);
      }
    },
  };
};

export const pluginTcpManager = createPluginTcpManager();
