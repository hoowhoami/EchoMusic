import type { LocalAudioMetadata } from './localMusic';

export type PluginWindowType = 'floating';
export type PluginWindowPosition = 'center' | 'top-center';
export type PluginWindowResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface PluginWindowManifest {
  id: string;
  type?: PluginWindowType;
  title?: string;
  main: string;
  style?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  position?: PluginWindowPosition;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
  movable?: boolean;
  rememberBounds?: boolean;
  allowOutsideWorkArea?: boolean;
  acceptFirstMouse?: boolean;
}

export interface PluginWindowDescriptor extends Required<
  Pick<
    PluginWindowManifest,
    | 'id'
    | 'type'
    | 'title'
    | 'main'
    | 'defaultWidth'
    | 'defaultHeight'
    | 'minWidth'
    | 'minHeight'
    | 'maxWidth'
    | 'maxHeight'
    | 'position'
    | 'transparent'
    | 'alwaysOnTop'
    | 'skipTaskbar'
    | 'resizable'
    | 'movable'
    | 'rememberBounds'
    | 'allowOutsideWorkArea'
    | 'acceptFirstMouse'
  >
> {
  pluginId: string;
  style: string;
  mainFile: string;
  styleFile: string;
}

export interface PluginWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Options for binding a plugin window resize handle to an element. */
export interface PluginWindowResizeOptions {
  direction?: PluginWindowResizeDirection;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface PluginWindowShowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  alwaysOnTop?: boolean;
  allowOutsideWorkArea?: boolean;
}

/** 将窗口抬到最前的选项，不改变置顶状态 */
export interface PluginShowOnTopOptions {
  /** 是否抢占焦点并激活窗口，默认 true；为 false 时仅抬升层级、不打断当前输入 */
  focus?: boolean;
}

/** 宿主窗口目标：主窗口或 mini 播放器 */
export type PluginHostWindowTarget = 'main' | 'mini-player';

export type PluginHostWindowResult =
  | {
      ok: true;
      target: PluginHostWindowTarget;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginWindowResult =
  | {
      ok: true;
      window: PluginWindowDescriptor;
      bounds?: PluginWindowBounds;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginWindowContextResult =
  | {
      ok: true;
      plugin: EchoPluginDescriptor;
      window: PluginWindowDescriptor;
    }
  | {
      ok: false;
      error: string;
    };

export interface PluginFileDialogFilter {
  name: string;
  extensions: string[];
}

export interface PluginOpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: PluginFileDialogFilter[];
  multiple?: boolean;
}

export interface PluginDialogResult {
  canceled: boolean;
  paths: string[];
}

export interface PluginImageFileEntry {
  name: string;
  path: string;
  url: string;
  size: number;
  modifiedAt: number;
}

export interface PluginListImageFilesOptions {
  recursive?: boolean;
  limit?: number;
}

export type PluginListImageFilesResult =
  | {
      ok: true;
      files: PluginImageFileEntry[];
    }
  | {
      ok: false;
      error: string;
    };

export type PluginFileKind = 'audio' | 'image' | 'lyric' | 'playlist' | 'cue' | 'other';

export interface PluginFileEntry extends PluginImageFileEntry {
  kind: PluginFileKind;
  extension: string;
  relativePath: string;
}

export interface PluginListFilesOptions {
  recursive?: boolean;
  limit?: number;
  kinds?: PluginFileKind[];
  extensions?: string[];
  includeHidden?: boolean;
  maxDepth?: number;
}

export type PluginListFilesResult =
  | {
      ok: true;
      root: string;
      files: PluginFileEntry[];
      limitReached: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginFileUrlResult =
  | {
      ok: true;
      url: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface PluginReadTextFileOptions {
  encoding?: 'utf8' | 'utf-8' | 'utf16le' | 'ucs2' | 'ucs-2' | 'latin1' | 'ascii';
  offset?: number;
  length?: number;
  maxBytes?: number;
}

export type PluginReadTextFileResult =
  | {
      ok: true;
      name: string;
      path: string;
      url: string;
      size: number;
      modifiedAt: number;
      content: string;
      bytesRead: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export interface PluginReadFileBytesOptions {
  offset?: number;
  length?: number;
  maxBytes?: number;
}

export type PluginReadFileBytesResult =
  | {
      ok: true;
      name: string;
      path: string;
      url: string;
      size: number;
      modifiedAt: number;
      data: ArrayBuffer;
      bytesRead: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginReadAudioMetadataResult =
  | ({
      ok: true;
      title: string;
      metadataParsed: boolean;
      metadataError?: string;
    } & PluginFileEntry &
      LocalAudioMetadata)
  | {
      ok: false;
      error: string;
    };

export interface PluginWriteFileOptions {
  encoding?: 'utf8' | 'utf-8' | 'utf16le' | 'ucs2' | 'ucs-2' | 'latin1' | 'ascii' | 'base64';
  overwrite?: boolean;
  createDirectories?: boolean;
}

export type PluginWriteFileData =
  | string
  | ArrayBuffer
  | Uint8Array
  | {
      type: 'base64';
      data: string;
    };

export type PluginWriteFileResult =
  | {
      ok: true;
      name: string;
      path: string;
      url: string;
      size: number;
      modifiedAt: number;
      bytesWritten: number;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginDeleteFileResult =
  | {
      ok: true;
      name: string;
      path: string;
      existed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginRestoreIconResult =
  | {
      ok: true;
      applied: boolean;
      message: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface PluginProcessLaunchOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | number | boolean | null | undefined>;
}

export type PluginProcessLaunchResult =
  | {
      ok: true;
      pid: number;
      executable: string;
      cwd: string;
      startedAt: number;
    }
  | {
      ok: false;
      error: string;
      canceled?: boolean;
    };

export type PluginProcessTerminateResult =
  | {
      ok: true;
      pid: number;
      terminated: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginNetworkHeader = [name: string, value: string];

export type PluginNetworkHeaders = PluginNetworkHeader[] | Record<string, string | string[]>;

export type PluginNetworkJsonValue =
  | null
  | string
  | number
  | boolean
  | PluginNetworkJsonValue[]
  | { [key: string]: PluginNetworkJsonValue };

export type PluginNetworkRequestBody =
  | string
  | PluginNetworkJsonValue[]
  | { [key: string]: PluginNetworkJsonValue }
  | ArrayBuffer
  | ArrayBufferView
  | {
      type: 'base64';
      data: string;
    };

export type PluginNetworkResponseType = 'json' | 'text' | 'arrayBuffer';

export interface PluginNetworkTlsOptions {
  /** Defaults to true, matching Node's TLS behavior. */
  rejectUnauthorized?: boolean;
  /** Overrides the TLS SNI server name without changing the HTTP Host header. */
  servername?: string;
}

/** Main-process request options backed by Axios' Node.js adapter. */
export interface PluginNetworkRequestOptions {
  url: string;
  method?: string;
  headers?: PluginNetworkHeaders;
  body?: PluginNetworkRequestBody;
  /** Response decoding mode. Defaults to json. */
  responseType?: PluginNetworkResponseType;
  /** Request timeout. Defaults to 30 seconds; 0 disables it. */
  timeoutMs?: number;
  /** Maximum buffered response size. Defaults to 32 MiB; 0 disables the limit. */
  maxResponseBytes?: number;
  /** Maximum redirects to follow. Defaults to 5; 0 disables redirects. */
  maxRedirects?: number;
  /** Whether to decompress gzip/deflate/br responses. Defaults to true. */
  decompress?: boolean;
  tls?: PluginNetworkTlsOptions;
}

export type PluginNetworkResponseData = PluginNetworkJsonValue | string | ArrayBuffer;

export interface PluginNetworkResponse<T = PluginNetworkResponseData> {
  url: string;
  status: number;
  statusText: string;
  /** Axios-normalized response headers. Header names are lowercase. */
  headers: Record<string, string | string[]>;
  data: T;
}

// --- 服务请求拦截器（ctx.server.intercept） ---

/**
 * 可拦截的服务请求（Authorization 注入完成、发往主进程 server 之前的形态）。
 * 修改 params/data/headers/url 后，主进程 server 会基于新值重新计算签名。
 */
export interface PluginServerRequest {
  /** HTTP 方法，'GET' | 'POST' */
  method: string;
  /** 路由路径，如 '/song/url'，对应 server/module 下的模块 */
  url: string;
  params: Record<string, any>;
  data?: any;
  headers: Record<string, string>;
  /** 请求来源：host=主程序业务代码（拦截器只处理此类）；plugin=插件经 ctx.kugou 发起 */
  origin: { type: 'host' } | { type: 'plugin'; pluginId: string };
}

export interface PluginServerResponse {
  status: number;
  body: any;
  cookie?: string[];
  headers?: Record<string, string>;
  /** 未真实出网（被某层拦截器短路 Mock/转发）时为 true；插件也可显式设置 */
  mocked?: boolean;
  /** 短路该请求的插件 id；响应来自真实 server 时不存在，外层插件据此感知内层已接管 */
  handledBy?: string;
}

export type PluginServerNext = (
  requestPatch?: Partial<Omit<PluginServerRequest, 'origin'>>,
) => Promise<PluginServerResponse>;

export type PluginServerInterceptor = (
  request: PluginServerRequest,
  next: PluginServerNext,
) => Promise<PluginServerResponse> | PluginServerResponse;

/**
 * 匹配条件（决定本拦截器是否应用于本次请求）：
 * - string：按路由路径前缀匹配（如 '/song/' 匹配 '/song/url'）
 * - RegExp：对 request.url 执行 test
 * - 函数：拿到完整请求自行判断，可读 method/params/data/headers/origin
 */
export type PluginServerMatcher = string | RegExp | ((request: PluginServerRequest) => boolean);

export interface PluginServerInterceptOptions {
  /**
   * 优先级，默认 0。数值越大越靠外层（请求阶段越早执行、响应阶段越晚执行）。
   * 同优先级按注册先后稳定排序。建议档位：100 观测/日志、0 数据转换、-100 Mock/转发。
   */
  priority?: number;
  /** 预过滤条件；不匹配的请求不会调用 handler（透明跳过）。默认匹配全部 */
  match?: PluginServerMatcher;
  /** 仅用于日志与排查的标签（如 'traffic-logger'），不参与排序 */
  name?: string;
}

export interface PluginWebServerListenOptions {
  port?: number;
  host?: '127.0.0.1' | 'localhost';
  /** Concurrent WebSocket connections. Default 16, max 64. */
  maxConnections?: number;
  /** Max WebSocket message size in bytes. Default 1 MiB, max 8 MiB. */
  maxMessageBytes?: number;
  /** Max queued outbound WebSocket bytes. Default 4× message size, max 32 MiB. */
  maxBufferedBytes?: number;
  /**
   * Allow WebSocket clients whose `Origin` is not this server (`http://127.0.0.1:<port>` /
   * `http://localhost:<port>`). Default false: browsers on other origins are rejected.
   * Non-browser clients that omit `Origin` are still accepted.
   */
  allowCrossOrigin?: boolean;
}

export interface PluginWebServerRequest {
  requestId: string;
  pluginId: string;
  method: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  body: ArrayBuffer;
  remoteAddress: string;
}

export type PluginWebSocketData =
  | string
  | ArrayBuffer
  | ArrayBufferView<ArrayBufferLike>
  | {
      type: 'base64';
      data: string;
    };

export interface PluginWebSocketUpgradeRequest {
  connectionId: string;
  pluginId: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  protocols: string[];
  remoteAddress: string;
}

export interface PluginWebSocketUpgradeDecision {
  accept?: boolean;
  protocol?: string;
}

export type PluginWebSocketUpgradeHandlerResult =
  | PluginWebSocketUpgradeDecision
  | boolean
  | void
  | Promise<PluginWebSocketUpgradeDecision | boolean | void>;

export interface PluginWebSocketOpenEvent {
  connectionId: string;
  pluginId: string;
  protocol: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  remoteAddress: string;
}

export interface PluginWebSocketMessageEvent {
  data: ArrayBuffer | string;
}

export interface PluginWebSocketCloseEvent {
  code: number;
  reason: string;
}

export interface PluginWebSocketNativeMessageEvent {
  connectionId: string;
  pluginId: string;
  data: ArrayBuffer | string;
  binary: boolean;
}

export interface PluginWebSocketNativeCloseEvent {
  connectionId: string;
  pluginId: string;
  code: number;
  reason: string;
}

export interface PluginWebSocketNativeErrorEvent {
  connectionId: string;
  pluginId: string;
  error: string;
}

export interface PluginWebSocketConnection {
  readonly connectionId: string;
  readonly protocol: string;
  readonly url: string;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly headers: Record<string, string | string[]>;
  readonly remoteAddress: string;
  readonly readyState: number;
  send(data: PluginWebSocketData): Promise<{ ok: boolean; error?: string }>;
  ping(data?: PluginWebSocketData): Promise<{ ok: boolean; error?: string }>;
  close(code?: number, reason?: string): Promise<{ ok: boolean; error?: string }>;
  onMessage(handler: (event: PluginWebSocketMessageEvent) => void): () => void;
  onClose(handler: (event: PluginWebSocketCloseEvent) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
}

export type PluginWebSocketConnectionHandler = (
  socket: PluginWebSocketConnection,
) => void | (() => void);

export interface PluginWebSocketListenOptions {
  path?: string;
  onUpgrade?: (request: PluginWebSocketUpgradeRequest) => PluginWebSocketUpgradeHandlerResult;
}

export interface PluginWebServerListenConfig
  extends PluginWebServerListenOptions, PluginWebSocketListenOptions {
  onRequest?: (request: PluginWebServerRequest) => PluginWebServerHandlerResult;
  onConnection?: PluginWebSocketConnectionHandler;
}

export interface PluginWebSocketSendPayload {
  connectionId: string;
  data?: PluginWebSocketData;
}

export interface PluginWebSocketClosePayload {
  connectionId: string;
  code?: number;
  reason?: string;
}

export interface PluginWebSocketUpgradeResponse {
  connectionId: string;
  accept: boolean;
  protocol?: string;
}

export type PluginWebServerJsonBody =
  | null
  | string
  | number
  | boolean
  | PluginWebServerJsonBody[]
  | { [key: string]: PluginWebServerJsonBody };

export type PluginWebServerResponseBody =
  | string
  | ArrayBuffer
  | ArrayBufferView<ArrayBufferLike>
  | {
      type: 'base64';
      data: string;
    }
  | PluginWebServerJsonBody;

export interface PluginWebServerResponse {
  status?: number;
  headers?: Record<string, string | number | boolean | string[]>;
  body?: PluginWebServerResponseBody;
}

export interface PluginWebServerResponsePayload extends PluginWebServerResponse {
  requestId: string;
}

export type PluginWebServerHandlerResult =
  | PluginWebServerResponse
  | PluginWebServerResponseBody
  | void
  | Promise<PluginWebServerResponse | PluginWebServerResponseBody | void>;

export type PluginWebServerListenResult =
  | {
      ok: true;
      pluginId: string;
      host: string;
      port: number;
      origin: string;
      url: string;
      startedAt: number;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginWebServerStatusResult =
  | {
      ok: true;
      pluginId: string;
      running: boolean;
      host: string;
      port: number;
      origin: string;
      url: string;
      startedAt: number;
      pendingRequests: number;
      connections: number;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginWebServerCloseResult =
  | {
      ok: true;
      pluginId: string;
      closed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteBlobValue = { type: 'hex' | 'base64'; data: string };
export type PluginSqliteValue = string | number | boolean | null | { type: 'hex'; data: string };
export type PluginSqliteParam = string | number | boolean | null | PluginSqliteBlobValue;
export type PluginSqliteParams = PluginSqliteParam[];

export interface PluginSqliteMigration {
  version: number;
  sql: string | string[];
}

export interface PluginSqliteOpenOptions {
  name?: string;
  migrations?: PluginSqliteMigration[];
  readOnly?: boolean;
  busyTimeoutMs?: number;
}

export interface PluginSqliteQueryOptions {
  limit?: number;
}

export interface PluginSqliteStatement {
  sql: string;
  params?: PluginSqliteParams;
}

export type PluginSqliteRow = Record<string, PluginSqliteValue>;

export type PluginSqliteOpenResult =
  | {
      ok: true;
      pluginId: string;
      databaseId: string;
      name: string;
      version: number;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteExecResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteRunResult =
  | {
      ok: true;
      changes: number;
      lastInsertRowid: number;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteQueryResult =
  | {
      ok: true;
      rows: PluginSqliteRow[];
      rowCount: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteCloseResult =
  | {
      ok: true;
      closed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export interface PluginSqliteDatabaseInfo {
  name: string;
  size: number;
  modifiedAt: number;
}

export type PluginSqliteListResult =
  | {
      ok: true;
      databases: PluginSqliteDatabaseInfo[];
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSqliteDeleteResult =
  | {
      ok: true;
      deleted: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export interface EchoPluginManifest {
  tags?: string[];
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  downloadUrl?: string;
  main?: string;
  style?: string;
  runtime?: {
    miniPlayer?: boolean;
    desktopLyric?: boolean;
  };
  capabilities?: {
    audioSource?: boolean;
    audioSpectrum?: boolean;
    backups?: boolean;
    kugouApi?: boolean;
    kugouVerification?: boolean;
    localFiles?: boolean;
    lyricEffects?: boolean;
    lyrics?: boolean;
    lyricsPage?: boolean;
    process?: boolean;
    sqlite?: boolean;
    tcp?: boolean;
    unrestrictedNetwork?: boolean;
    webServer?: boolean;
    /** 拦截主程序发往 server 的 API 请求（读取凭证与数据、修改、Mock、转发） */
    serverIntercept?: boolean;
  };
  contributes?: {
    windows?: PluginWindowManifest[];
  };
  requires?: {
    echoMusicVersion?: string;
  };
}

export interface EchoPluginCompatibility {
  compatible: boolean;
  currentEchoMusicVersion: string;
  requiredEchoMusicVersion: string;
  message: string;
}

export type PluginInstallSource =
  | { kind: 'local' }
  | { kind: 'marketplace'; id: string; name: string; url: string };

export interface EchoPluginDescriptor {
  tags?: string[];
  installSource?: PluginInstallSource;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  directoryName: string;
  directory: string;
  manifestPath: string;
  mainFile: string;
  styleFile: string;
  iconUrl: string;
  windows: PluginWindowDescriptor[];
  enabled: boolean;
  invalid: boolean;
  error: string;
  compatibility: EchoPluginCompatibility;
  manifest: EchoPluginManifest;
}

export interface PluginMarketplaceSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  official: boolean;
  indexUrl: string;
  homepage: string;
  pluginCount: number;
  addedAt: number;
  updatedAt: number;
  lastFetchedAt: number;
  lastError: string;
}

export interface PluginMarketplaceSourceInput {
  url: string;
  name?: string;
  enabled?: boolean;
}

export interface PluginMarketplaceSourcePatch {
  name?: string;
  enabled?: boolean;
}

export interface PluginMarketplaceRequestOptions {
  /** Refresh installed plugin manifests only; omit marketplace statistics. */
  installedOnly?: boolean;
  /** 仅读取本地目录，供页面先展示缓存。 */
  cachedOnly?: boolean;
  githubProxyUrl?: string;
  refresh?: boolean;
}

export interface PluginMarketplaceInstallOptions {
  githubProxyUrl?: string;
  enableAfterInstall?: boolean;
}

export interface PluginMarketplaceStats {
  installCount: number;
  updateCount: number;
  failureCount: number;
  score: number;
  lastInstalledAt: string;
  lastUpdatedAt: string;
}

export interface PluginLocalInstallOptions {
  enableAfterInstall?: boolean;
  expectedPluginId?: string;
}

export interface PluginMarketplacePlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  iconUrl: string;
  tags: string[];
  repo: string;
  homepage: string;
  downloadUrl: string;
  packagePath: string;
  checksum: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  installed: boolean;
  installedVersion: string;
  updateAvailable: boolean;
  compatibility: EchoPluginCompatibility;
  stats: PluginMarketplaceStats;
  manifest: EchoPluginManifest;
}

export type PluginMarketplaceListResult =
  | {
      ok: true;
      sources: PluginMarketplaceSource[];
      plugins: PluginMarketplacePlugin[];
      fetchedAt: number;
    }
  | {
      ok: false;
      error: string;
      sources: PluginMarketplaceSource[];
      plugins: PluginMarketplacePlugin[];
      fetchedAt: number;
    };

export type PluginMarketplaceSourceListResult = {
  sources: PluginMarketplaceSource[];
};

export type PluginMarketplaceSourceMutationResult =
  | {
      ok: true;
      source: PluginMarketplaceSource;
      sources: PluginMarketplaceSource[];
    }
  | {
      ok: false;
      error: string;
      sources: PluginMarketplaceSource[];
    };

export type PluginMarketplaceRemoveSourceResult =
  | {
      ok: true;
      sourceId: string;
      sources: PluginMarketplaceSource[];
    }
  | {
      ok: false;
      error: string;
      sources: PluginMarketplaceSource[];
    };

export type PluginMarketplaceInstallResult =
  | {
      ok: true;
      plugin: EchoPluginDescriptor;
      updated: boolean;
      enabled: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginLocalInstallSourceKind = 'zip' | 'directory';

export type PluginLocalInstallItemResult =
  | {
      ok: true;
      sourcePath: string;
      kind: PluginLocalInstallSourceKind;
      plugin: EchoPluginDescriptor;
      updated: boolean;
      enabled: boolean;
    }
  | {
      ok: false;
      sourcePath: string;
      kind: PluginLocalInstallSourceKind | 'unknown';
      error: string;
    };

export interface PluginLocalInstallResult {
  ok: boolean;
  results: PluginLocalInstallItemResult[];
  installed: number;
  failed: number;
}

export interface PluginFailureRecord {
  pluginId?: string;
  pluginIds?: string[];
  reason: 'activation-error' | 'runtime-error' | 'render-process-gone' | 'unresponsive';
  message: string;
  createdAt: number;
}

export type PluginListResult = {
  plugins: EchoPluginDescriptor[];
  directory: string;
  safeMode: boolean;
  lastFailure: PluginFailureRecord | null;
};

export type PluginSetEnabledResult =
  | {
      ok: true;
      plugin: EchoPluginDescriptor;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginSetSafeModeResult =
  | {
      ok: true;
      safeMode: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginUninstallResult =
  | {
      ok: true;
      pluginId: string;
    }
  | {
      ok: false;
      error: string;
    };

export type PluginReportFailureResult = {
  ok: boolean;
};

export type PluginAppIconRefreshResult = {
  ok: true;
  trayIconPath: string | null;
  taskbarIconPath: string | null;
  windowIconPath: string | null;
  desktopIconPath: string | null;
  trayPluginId: string | null;
  taskbarPluginId: string | null;
  windowPluginId: string | null;
  desktopPluginId: string | null;
  desktopApplied: boolean;
  desktopError: string | null;
  taskbarShortcutApplied: boolean;
  taskbarShortcutError: string | null;
};

export type PluginAssetSourceResult =
  | {
      ok: true;
      source: string;
    }
  | {
      ok: false;
      error: string;
    };
