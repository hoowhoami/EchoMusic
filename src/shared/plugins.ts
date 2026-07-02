export type PluginWindowType = 'floating';
export type PluginWindowPosition = 'center' | 'top-center';

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

export interface PluginWebServerListenOptions {
  port?: number;
  host?: '127.0.0.1' | 'localhost';
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

export type PluginSqliteValue = string | number | boolean | null | { type: 'hex'; data: string };
export type PluginSqliteParam = string | number | boolean | null;
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
    kugouApi?: boolean;
    localFiles?: boolean;
    lyricEffects?: boolean;
    lyrics?: boolean;
    process?: boolean;
    sqlite?: boolean;
    webServer?: boolean;
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

export interface EchoPluginDescriptor {
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
