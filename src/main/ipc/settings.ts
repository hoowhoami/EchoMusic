import { BrowserWindow, ipcMain, shell, app, session } from 'electron';
import Conf from 'conf';
import log from 'electron-log';
import { dirname } from 'path';
import { compare, prerelease, valid } from 'semver';

interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
}

const openLogDirectory = async () => {
  const logFile = log.transports.file.getFile();
  const logDir = logFile?.path ? dirname(logFile.path) : '';
  if (!logDir) return;
  await shell.openPath(logDir);
};

const appSettingsStore = new Conf<Record<string, unknown>>({
  projectName: app.getName(),
});

type UpdateCheckResult = {
  status: 'available' | 'latest' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  body?: string;
  message?: string;
  silent?: boolean;
};

type AppInfoResult = {
  version: string;
  isPrerelease: boolean;
};

const RELEASES_API = 'https://api.github.com/repos/hoowhoami/EchoMusic/releases';

const normalizeVersion = (value: string) => valid(value.trim()) ?? value.replace(/^v/i, '').trim();
const getAppInfo = (): AppInfoResult => {
  const version = app.getVersion();
  return {
    version,
    isPrerelease: Array.isArray(prerelease(normalizeVersion(version))),
  };
};

const compareVersions = (left: string, right: string) =>
  compare(normalizeVersion(left), normalizeVersion(right));

const fetchLatestRelease = async (includePrerelease: boolean) => {
  const response = await fetch(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'EchoMusic',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`);
  }

  const releases = (await response.json()) as Array<Record<string, unknown>>;
  return releases.find((release) => {
    if (release.draft === true) return false;
    if (!includePrerelease && release.prerelease === true) return false;
    return typeof release.tag_name === 'string';
  });
};

export const registerSettingsHandlers = ({ getMainWindow }: IpcContext) => {
  ipcMain.handle('app:get-info', () => getAppInfo());

  ipcMain.on('open-log-directory', async () => {
    await openLogDirectory();
  });

  ipcMain.on(
    'check-for-updates',
    async (_event, payload?: { prerelease?: boolean; silent?: boolean }) => {
      const win = getMainWindow();
      if (!win) return;

      const { version: currentVersion } = getAppInfo();
      const silent = Boolean(payload?.silent);

      try {
        const release = await fetchLatestRelease(Boolean(payload?.prerelease));
        if (!release || typeof release.tag_name !== 'string') {
          const result: UpdateCheckResult = {
            status: 'error',
            currentVersion,
            message: '未获取到有效的版本信息，请稍后再试。',
            silent,
          };
          win.webContents.send('update-check-result', result);
          return;
        }

        const latestVersion = String(release.tag_name);
        const result: UpdateCheckResult =
          compareVersions(latestVersion, currentVersion) > 0
            ? {
                status: 'available',
                currentVersion,
                latestVersion,
                releaseName: typeof release.name === 'string' ? release.name : latestVersion,
                releaseUrl:
                  typeof release.html_url === 'string'
                    ? release.html_url
                    : 'https://github.com/hoowhoami/EchoMusic/releases',
                body: typeof release.body === 'string' ? release.body.slice(0, 1200) : '',
                silent,
              }
            : {
                status: 'latest',
                currentVersion,
                latestVersion,
                releaseName: typeof release.name === 'string' ? release.name : latestVersion,
                releaseUrl:
                  typeof release.html_url === 'string'
                    ? release.html_url
                    : 'https://github.com/hoowhoami/EchoMusic/releases',
                silent,
              };

        win.webContents.send('update-check-result', result);
      } catch (error) {
        const result: UpdateCheckResult = {
          status: 'error',
          currentVersion,
          message: error instanceof Error ? error.message : '更新检查失败，请稍后重试。',
          silent,
        };
        win.webContents.send('update-check-result', result);
      }
    },
  );

  ipcMain.on('open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('http')) return;
    await shell.openExternal(url);
  });

  ipcMain.on('open-disclaimer', () => {
    const win = getMainWindow();
    if (!win) return;
    win.webContents.send('open-disclaimer');
  });

  ipcMain.on('clear-app-data', async () => {
    appSettingsStore.clear();
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
  });
};
