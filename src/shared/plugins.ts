export type PluginContributionMap = Record<string, unknown>;

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

export interface EchoPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main?: string;
  style?: string;
  contributes?: PluginContributionMap & {
    image?: string;
    icon?: string;
    windows?: PluginWindowManifest[];
  };
  engines?: {
    echoMusic?: string;
  };
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
  imageUrl: string;
  windows: PluginWindowDescriptor[];
  enabled: boolean;
  invalid: boolean;
  error: string;
  manifest: EchoPluginManifest;
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

export type PluginAssetSourceResult =
  | {
      ok: true;
      source: string;
    }
  | {
      ok: false;
      error: string;
    };
