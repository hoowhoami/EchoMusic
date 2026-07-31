export type ThemeMode = 'light' | 'dark' | 'system';

export type CloseBehavior = 'tray' | 'exit';

export type UpdateCheckStatus = 'available' | 'latest' | 'error';

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  downloadLabel?: string;
  manualDownload?: boolean;
  body?: string;
  message?: string;
  silent?: boolean;
};

export type UpdateDownloadProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type UpdateDownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error';

export type UpdateDownloadResult = {
  status: UpdateDownloadStatus;
  progress?: UpdateDownloadProgress;
  error?: string;
};

export type UpdateState = {
  checkResult: UpdateCheckResult | null;
  download: UpdateDownloadResult;
};

export type UpdateInstallResult = {
  ok: boolean;
  error?: string;
};

export type AppInfoResult = {
  version: string;
  isPrerelease: boolean;
  isPackaged: boolean;
};
