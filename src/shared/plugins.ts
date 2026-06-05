export type PluginContributionMap = Record<string, unknown>;

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
  contributes?: PluginContributionMap;
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
