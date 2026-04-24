import { ipcMain, shell, app, session } from 'electron';
import Conf from 'conf';
import log from 'electron-log';
import fs from 'fs';
import { dirname, join } from 'path';
import { autoUpdater } from 'electron-updater';
import type { AppInfoResult, UpdateCheckResult, UpdateDownloadResult } from '../../shared/app';
import type { IpcContext } from './types';

const openLogDirectory = async () => {
  const logFile = log.transports.file.getFile();
  const logDir = logFile?.path ? dirname(logFile.path) : '';
  if (!logDir) return;
  await shell.openPath(logDir);
};

const appSettingsStore = new Conf<Record<string, unknown>>({
  projectName: app.getName(),
});

const getAppInfo = (): AppInfoResult => {
  const version = app.getVersion();
  return { version, isPrerelease: version.includes('-') };
};

export const registerSettingsHandlers = ({ getMainWindow }: IpcContext) => {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;

  const isDev = !app.isPackaged;

  const readCurrentVersionChangelog = (): string => {
    const version = app.getVersion();
    const changelogPath = isDev
      ? join(process.cwd(), 'CHANGELOG.md')
      : join(process.resourcesPath, 'CHANGELOG.md');
    try {
      const content = fs.readFileSync(changelogPath, 'utf-8');
      // 提取顶部声明（第一个 ## 之前，去掉 # 标题行）
      const headerMatch = content.match(/^([\s\S]*?)(?=\n## \[)/);
      const header = (headerMatch?.[1] || '').replace(/^#\s+.*$/gm, '').trim();
      // 提取当前版本的内容（包含 ## 标题行）
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const versionMatch = content.match(
        new RegExp(`(## \\[${escaped}\\][^\\n]*\\n[\\s\\S]*?)(?=\\n## \\[|$)`),
      );
      const versionBody = versionMatch?.[1]?.trim() || '';
      if (!header && !versionBody) return '';
      return [header, versionBody].filter(Boolean).join('\n\n');
    } catch {
      return '';
    }
  };

  const sendToRenderer = (channel: string, data: unknown) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  // --- autoUpdater 事件 ---
  autoUpdater.on('update-available', (info) => {
    const { version: currentVersion } = getAppInfo();
    const silent = (autoUpdater as any)._echoSilent ?? false;
    const result: UpdateCheckResult = {
      status: 'available',
      currentVersion,
      latestVersion: info.version,
      releaseName: info.releaseName || `v${info.version}`,
      releaseUrl: `https://github.com/hoowhoami/EchoMusic/releases/tag/v${info.version}`,
      body: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : '',
      silent,
    };
    sendToRenderer('update-check-result', result);
  });

  autoUpdater.on('update-not-available', (info) => {
    const { version: currentVersion } = getAppInfo();
    const silent = (autoUpdater as any)._echoSilent ?? false;
    sendToRenderer('update-check-result', {
      status: 'latest',
      currentVersion,
      latestVersion: info.version,
      releaseName: info.releaseName || `v${info.version}`,
      releaseUrl: `https://github.com/hoowhoami/EchoMusic/releases/tag/v${info.version}`,
      body: readCurrentVersionChangelog(),
      silent,
    } satisfies UpdateCheckResult);
  });

  autoUpdater.on('error', (error) => {
    log.error('[Updater] Error:', error);
    sendToRenderer('update-check-result', {
      status: 'error',
      currentVersion: getAppInfo().version,
      message: error?.message || '更新检查失败，请稍后重试。',
    } satisfies UpdateCheckResult);
    sendToRenderer('update-download-status', {
      status: 'error',
      error: error?.message || '下载失败',
    } satisfies UpdateDownloadResult);
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-download-status', {
      status: 'downloading',
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    } satisfies UpdateDownloadResult);
  });

  autoUpdater.on('update-downloaded', () => {
    sendToRenderer('update-download-status', {
      status: 'downloaded',
    } satisfies UpdateDownloadResult);
  });

  // --- IPC handlers ---
  ipcMain.handle('app:get-info', () => getAppInfo());

  ipcMain.handle('app:get-changelog', () => {
    const changelogPath = isDev
      ? join(process.cwd(), 'CHANGELOG.md')
      : join(process.resourcesPath, 'CHANGELOG.md');
    try {
      return fs.readFileSync(changelogPath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.on('open-log-directory', async () => {
    await openLogDirectory();
  });

  ipcMain.on(
    'check-for-updates',
    (_event, payload?: { prerelease?: boolean; silent?: boolean }) => {
      const silent = Boolean(payload?.silent);
      const prerelease = Boolean(payload?.prerelease);

      if (isDev) {
        sendToRenderer('update-check-result', {
          status: 'latest',
          currentVersion: getAppInfo().version,
          body: readCurrentVersionChangelog(),
          message: '开发模式下不支持在线更新。',
          silent,
        } satisfies UpdateCheckResult);
        return;
      }

      autoUpdater.allowPrerelease = prerelease;
      (autoUpdater as any)._echoSilent = silent;

      autoUpdater.checkForUpdates().catch((error) => {
        log.error('[Updater] Check failed:', error);
        sendToRenderer('update-check-result', {
          status: 'error',
          currentVersion: getAppInfo().version,
          message: error?.message || '更新检查失败，请稍后重试。',
          silent,
        } satisfies UpdateCheckResult);
      });
    },
  );

  ipcMain.on('update:download', () => {
    autoUpdater.downloadUpdate().catch((error) => {
      log.error('[Updater] Download failed:', error);
      sendToRenderer('update-download-status', {
        status: 'error',
        error: error?.message || '下载失败',
      } satisfies UpdateDownloadResult);
    });
  });

  ipcMain.on('update:install', (_event, payload?: { silent?: boolean }) => {
    const isSilent = payload?.silent ?? false;
    autoUpdater.quitAndInstall(isSilent, true);
  });

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

  // GPU 加速设置（需重启生效）
  ipcMain.on('update-disable-gpu-acceleration', (_event, disabled: boolean) => {
    appSettingsStore.set('disableGpuAcceleration', disabled);
  });
};
