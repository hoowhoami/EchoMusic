export type ThemeMode = 'light' | 'dark' | 'system';

export type CloseBehavior = 'tray' | 'exit';

export type UpdateCheckStatus = 'available' | 'latest' | 'error';

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  body?: string;
  message?: string;
  silent?: boolean;
};

export type AppInfoResult = {
  version: string;
  isPrerelease: boolean;
};
