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
}

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

export type PluginFileUrlResult =
  | {
      ok: true;
      url: string;
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

export interface EchoPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  main?: string;
  style?: string;
  runtime?: {
    miniPlayer?: boolean;
    desktopLyric?: boolean;
  };
  capabilities?: {
    audioSource?: boolean;
    audioSpectrum?: boolean;
    lyrics?: boolean;
    process?: boolean;
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

export type PluginAssetSourceResult =
  | {
      ok: true;
      source: string;
    }
  | {
      ok: false;
      error: string;
    };
