/** Raw TCP connects directly; it does not use the application's HTTP proxy or TLS. */
export interface PluginTcpConnectOptions {
  host: string;
  port: number;
  /** 1..120000 ms; defaults to 5000. */
  connectTimeoutMs?: number;
  /** Deadline for each write, 1..120000 ms; defaults to 10000. */
  writeTimeoutMs?: number;
  /** Disable Nagle's algorithm; defaults to true. */
  noDelay?: boolean;
  /** Enable OS TCP keepalive probes; defaults to false. Not an application heartbeat. */
  keepAlive?: boolean;
  /** 0..2147483647 ms; defaults to 30000. Zero keeps the OS default. */
  keepAliveInitialDelayMs?: number;
  /** Cancels connection establishment and remains attached for the connection's lifetime. */
  signal?: AbortSignal;
}

export interface PluginTcpOperationOptions {
  /** Aborting an in-flight operation closes the entire connection. */
  signal?: AbortSignal;
}

export interface PluginTcpConnection {
  /** Read up to 64 KiB. null means EOF. Only one pending read is allowed. */
  read(options?: PluginTcpOperationOptions): Promise<ArrayBuffer | null>;
  /** At most 1 MiB per write. Completion is not a peer acknowledgement. */
  write(data: ArrayBuffer | Uint8Array, options?: PluginTcpOperationOptions): Promise<void>;
  /** Flush queued writes and send FIN; reads remain available. Uses the write deadline. */
  end(options?: PluginTcpOperationOptions): Promise<void>;
  /** Abort the connection and any pending operations. Idempotent. */
  close(): Promise<void>;
}

/** Internal preload transport. Connection IDs are scoped to the IPC sender and plugin. */
export interface PluginTcpNativeApi {
  connect(
    pluginId: string,
    connectionId: string,
    options: PluginTcpNativeConnectOptions,
  ): Promise<void>;
  read(pluginId: string, connectionId: string): Promise<ArrayBuffer | null>;
  write(pluginId: string, connectionId: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  end(pluginId: string, connectionId: string): Promise<void>;
  close(pluginId: string, connectionId: string): Promise<void>;
}

/** AbortSignal stays in the renderer; it must never cross Electron's structured-clone boundary. */
export type PluginTcpNativeConnectOptions = Omit<PluginTcpConnectOptions, 'signal'>;
