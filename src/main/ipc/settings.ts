import { ipcRegistry } from './registry';
import { shell, app, session, dialog, type OpenDialogOptions } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import { execFile } from 'child_process';
import { dirname, extname, join, resolve, sep, basename } from 'path';
import { autoUpdater } from 'electron-updater';
import { getFonts } from 'font-list';
import { coerce as semverCoerce, gt as semverGt, valid as semverValid } from 'semver';
import type { AppInfoResult, UpdateCheckResult, UpdateDownloadResult } from '../../shared/app';
import type { NetworkSettings } from '../../shared/network';
import {
  normalizeImpulseResponseName,
  type ImportImpulseResponseResult,
  type ImpulseResponseFile,
} from '../../shared/audio';
import type { LogSettings } from '../../shared/logging';
import { applyLogSettings, getLogSettings } from '../logger';
import { getPlaybackQueueStorage } from '../storage/playbackQueues';
import { setMainAppSetting } from '../storage/settings';
import { updateNetworkSettings } from '../networkSettings';
import type { IpcContext } from './types';

const openLogDirectory = async () => {
  const logFile = log.transports.file.getFile();
  const logDir = logFile?.path ? dirname(logFile.path) : '';
  if (!logDir) return;
  await shell.openPath(logDir);
};

const getImpulseResponseDir = () => join(app.getPath('userData'), 'irs');
const DEFAULT_IMPULSE_RESPONSE_EXTENSION = '.irs';
const SUPPORTED_IMPULSE_RESPONSE_EXTENSIONS = new Set([
  '.irs',
  '.wav',
  '.wave',
  '.flac',
  '.aif',
  '.aiff',
  '.caf',
  '.ogg',
  '.oga',
  '.mp3',
  '.m4a',
  '.aac',
  '.opus',
]);

type GithubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GithubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

type LinuxDistribution = {
  id: string;
  idLike: string[];
};

type LinuxPackageType = 'deb' | 'rpm' | 'pacman';

const readLinuxDistribution = (): LinuxDistribution | null => {
  if (process.platform !== 'linux') return null;
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf-8');
    const values = new Map<string, string>();
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;
      values.set(match[1], match[2].trim().replace(/^"(.*)"$/, '$1'));
    }
    const id = values.get('ID')?.toLowerCase() || '';
    const idLike = (values.get('ID_LIKE') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return { id, idLike };
  } catch (error) {
    log.warn('[Updater] Failed to read Linux distribution:', error);
    return null;
  }
};

const isArchLinux = (): boolean => {
  const distro = readLinuxDistribution();
  if (!distro) return false;
  return distro.id === 'arch' || distro.idLike.includes('arch');
};

const readLinuxPackageType = (): LinuxPackageType | null => {
  if (process.platform !== 'linux') return null;
  try {
    const value = fs.readFileSync(join(process.resourcesPath, 'package-type'), 'utf-8').trim();
    return value === 'deb' || value === 'rpm' || value === 'pacman' ? value : null;
  } catch {
    return null;
  }
};

const shouldUseArchManualUpdate = (): boolean => {
  if (!isArchLinux()) return false;
  if (process.env.APPIMAGE) return false;
  return readLinuxPackageType() !== 'pacman';
};

const requestJson = <T>(url: string): Promise<T> =>
  new Promise((resolveRequest, rejectRequest) => {
    import('https')
      .then((https) => {
        const req = https.get(
          url,
          { headers: { 'User-Agent': 'EchoMusic-Updater', Accept: 'application/json' } },
          (res) => {
            const statusCode = res.statusCode || 0;
            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
              res.resume();
              requestJson<T>(res.headers.location).then(resolveRequest, rejectRequest);
              return;
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => {
              if (statusCode < 200 || statusCode >= 300) {
                rejectRequest(new Error(`GitHub API returned HTTP ${statusCode}`));
                return;
              }
              try {
                resolveRequest(JSON.parse(data) as T);
              } catch (error) {
                rejectRequest(error);
              }
            });
          },
        );
        req.on('error', rejectRequest);
        req.setTimeout(15000, () => {
          req.destroy(new Error('GitHub API request timed out'));
        });
      })
      .catch(rejectRequest);
  });

const normalizeReleaseVersion = (tagName: unknown): string => {
  const raw = String(tagName || '')
    .trim()
    .replace(/^v/i, '');
  return semverValid(raw) ?? semverCoerce(raw)?.version ?? raw;
};

const isNewerRelease = (nextVersion: string, currentVersion: string): boolean => {
  const next = semverValid(nextVersion) ?? semverCoerce(nextVersion)?.version;
  const current = semverValid(currentVersion) ?? semverCoerce(currentVersion)?.version;
  if (next && current) return semverGt(next, current);
  return nextVersion !== currentVersion;
};

const isArchPacmanPackageName = (name: string): boolean => name.endsWith('.pkg.tar.zst');
const isElectronUpdaterPacmanPackageName = (name: string): boolean => name.endsWith('.pacman');
const isPacmanAssetName = (name: string): boolean =>
  isArchPacmanPackageName(name) || isElectronUpdaterPacmanPackageName(name);

const getArchLinuxPackageAsset = (release: GithubRelease): GithubReleaseAsset | null => {
  const assets = Array.isArray(release.assets) ? (release.assets as GithubReleaseAsset[]) : [];
  const archTokens =
    process.arch === 'x64'
      ? ['x86_64', 'x64', 'amd64']
      : process.arch === 'arm64'
        ? ['arm64', 'aarch64']
        : [process.arch];

  return (
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return isArchPacmanPackageName(name) && archTokens.some((token) => name.includes(token));
    }) ??
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return isArchPacmanPackageName(name);
    }) ??
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return (
        isElectronUpdaterPacmanPackageName(name) && archTokens.some((token) => name.includes(token))
      );
    }) ??
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return isElectronUpdaterPacmanPackageName(name);
    }) ??
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return (
        name.endsWith('.tar.gz') &&
        name.includes('linux') &&
        archTokens.some((token) => name.includes(token))
      );
    }) ??
    assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return name.endsWith('.tar.gz') && name.includes('linux');
    }) ??
    null
  );
};

const withGithubProxy = (url: string, githubProxyUrl: string): string => {
  const proxyBase = githubProxyUrl.trim();
  if (!proxyBase || !url.startsWith('http')) return url;
  return `${proxyBase.endsWith('/') ? proxyBase : `${proxyBase}/`}${url}`;
};

const probeAudioFileWithFfprobe = async (filePath: string): Promise<boolean | null> =>
  new Promise((resolveProbe) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 5000 },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolveProbe(null);
          return;
        }
        if (error) {
          resolveProbe(false);
          return;
        }
        resolveProbe(stdout.trim().split(/\s+/).includes('audio'));
      },
    );
  });

const isSupportedImpulseResponseAudio = async (filePath: string): Promise<boolean> => {
  const ffprobeResult = await probeAudioFileWithFfprobe(filePath);
  if (ffprobeResult !== null) return ffprobeResult;

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 4) return false;

    const magic4 = buffer.subarray(0, 4).toString('ascii');
    const magic3 = buffer.subarray(0, 3).toString('ascii');
    const brand = buffer.subarray(4, 12).toString('ascii');
    if (magic4 === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return true;
    if (magic4 === 'caff') return true;
    if (magic4 === 'fLaC' || magic4 === 'OggS' || magic4 === 'FORM') return true;
    if (brand.includes('ftyp')) return true;
    if (magic3 === 'ID3') return true;
    return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  } finally {
    await handle.close();
  }
};

const isPathInside = (targetPath: string, parentPath: string): boolean => {
  const normalizedParent = resolve(parentPath);
  const normalizedTarget = resolve(targetPath);
  return (
    normalizedTarget === normalizedParent ||
    normalizedTarget.startsWith(`${normalizedParent}${sep}`)
  );
};

const importImpulseResponseFile = async (
  sourcePath: string,
): Promise<{ file?: ImpulseResponseFile; error?: string }> => {
  const extension = extname(sourcePath).toLowerCase();
  const sourceName = basename(sourcePath);
  const targetExtension = SUPPORTED_IMPULSE_RESPONSE_EXTENSIONS.has(extension)
    ? extension
    : DEFAULT_IMPULSE_RESPONSE_EXTENSION;

  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) {
    return { error: `${sourceName}: 请选择有效的音频文件。` };
  }
  if (!(await isSupportedImpulseResponseAudio(sourcePath))) {
    return { error: `${sourceName}: 该文件不是可识别的音频文件。` };
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const irsDir = getImpulseResponseDir();
  await fs.promises.mkdir(irsDir, { recursive: true });

  const targetPath = join(irsDir, `${id}${targetExtension}`);
  await fs.promises.copyFile(sourcePath, targetPath);

  return {
    file: {
      id,
      name: normalizeImpulseResponseName(sourceName),
      path: targetPath,
      size: stat.size,
      importedAt: Date.now(),
      format: targetExtension.slice(1),
    },
  };
};

const getAppInfo = (): AppInfoResult => {
  const version = app.getVersion();
  return { version, isPrerelease: version.includes('-') };
};

export const registerSettingsHandlers = ({ getMainWindow, mpvRef }: IpcContext) => {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;

  const isDev = !app.isPackaged;

  // 更新状态的单一可信来源（供渲染层在重新打开弹窗时恢复进度）
  let lastCheckResult: UpdateCheckResult | null = null;
  let downloadState: UpdateDownloadResult = { status: 'idle' };

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

    // releaseNotes 可能是 string 或 Array<{ version: string; note: string | null }>
    // 只展示最新版本的更新内容
    let body = '';
    if (typeof info.releaseNotes === 'string') {
      body = info.releaseNotes.slice(0, 4000);
    } else if (Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0) {
      body = (info.releaseNotes[0].note || '').trim().slice(0, 4000);
    }

    const result: UpdateCheckResult = {
      status: 'available',
      currentVersion,
      latestVersion: info.version,
      releaseName: info.releaseName || `v${info.version}`,
      releaseUrl: `https://github.com/hoowhoami/EchoMusic/releases/tag/v${info.version}`,
      body,
      silent,
    };
    lastCheckResult = result;
    sendToRenderer('update-check-result', result);
  });

  autoUpdater.on('update-not-available', (info) => {
    const { version: currentVersion } = getAppInfo();
    const silent = (autoUpdater as any)._echoSilent ?? false;
    const result: UpdateCheckResult = {
      status: 'latest',
      currentVersion,
      latestVersion: info.version,
      releaseName: info.releaseName || `v${info.version}`,
      releaseUrl: `https://github.com/hoowhoami/EchoMusic/releases/tag/v${info.version}`,
      body: readCurrentVersionChangelog(),
      silent,
    };
    lastCheckResult = result;
    sendToRenderer('update-check-result', result);
  });

  autoUpdater.on('error', (error) => {
    log.error('[Updater] Error:', error);
    const message = error?.message || '更新失败，请稍后重试。';
    // 区分检查阶段与下载阶段的错误，避免下载出错时弹窗被「检查更新失败」覆盖
    if (downloadState.status === 'downloading') {
      downloadState = { status: 'error', error: message };
      sendToRenderer('update-download-status', downloadState);
    } else {
      sendToRenderer('update-check-result', {
        status: 'error',
        currentVersion: getAppInfo().version,
        message,
        silent: (autoUpdater as any)._echoSilent ?? false,
      } satisfies UpdateCheckResult);
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    downloadState = {
      status: 'downloading',
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    };
    sendToRenderer('update-download-status', downloadState);
  });

  autoUpdater.on('update-downloaded', () => {
    downloadState = { status: 'downloaded' };
    sendToRenderer('update-download-status', downloadState);
  });

  const checkArchLinuxManualUpdate = async (payload: {
    prerelease: boolean;
    silent: boolean;
    githubProxyUrl: string;
  }): Promise<void> => {
    const { version: currentVersion } = getAppInfo();
    const releasesUrl = payload.prerelease
      ? 'https://api.github.com/repos/hoowhoami/EchoMusic/releases?per_page=20'
      : 'https://api.github.com/repos/hoowhoami/EchoMusic/releases/latest';

    const response = payload.prerelease
      ? await requestJson<GithubRelease[]>(releasesUrl)
      : await requestJson<GithubRelease>(releasesUrl);
    const release = Array.isArray(response)
      ? response.find((item) => item && item.prerelease === true) || response[0]
      : response;

    if (!release?.tag_name) {
      throw new Error('未找到可用的 GitHub Release。');
    }

    const latestVersion = normalizeReleaseVersion(release.tag_name);
    const releaseUrl =
      typeof release.html_url === 'string'
        ? release.html_url
        : `https://github.com/hoowhoami/EchoMusic/releases/tag/${release.tag_name}`;

    if (!isNewerRelease(latestVersion, currentVersion)) {
      const result: UpdateCheckResult = {
        status: 'latest',
        currentVersion,
        latestVersion,
        releaseName: String(release.name || release.tag_name || `v${latestVersion}`),
        releaseUrl,
        body: readCurrentVersionChangelog(),
        silent: payload.silent,
      };
      lastCheckResult = result;
      sendToRenderer('update-check-result', result);
      return;
    }

    const archiveAsset = getArchLinuxPackageAsset(release);
    const archiveName = String(archiveAsset?.name || '').toLowerCase();
    const isPacmanPackage = isPacmanAssetName(archiveName);
    const downloadUrl =
      typeof archiveAsset?.browser_download_url === 'string'
        ? withGithubProxy(archiveAsset.browser_download_url, payload.githubProxyUrl)
        : releaseUrl;
    const downloadLabel = archiveAsset
      ? isPacmanPackage
        ? '下载 pacman 包'
        : '下载 tar.gz'
      : '前往发布页下载';

    const result: UpdateCheckResult = {
      status: 'available',
      currentVersion,
      latestVersion,
      releaseName: String(release.name || release.tag_name || `v${latestVersion}`),
      releaseUrl,
      downloadUrl,
      downloadLabel,
      manualDownload: true,
      body: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      message: archiveAsset
        ? isPacmanPackage
          ? 'Arch Linux 暂不使用内置安装器，请下载 pacman 包后使用 pacman -U 手动安装。'
          : 'Arch Linux 暂不使用内置安装器，请下载 tar.gz 压缩包后手动替换安装目录。'
        : 'Arch Linux 暂不使用内置安装器，请前往发布页选择适合当前系统的安装包。',
      silent: payload.silent,
    };
    lastCheckResult = result;
    downloadState = { status: 'idle' };
    sendToRenderer('update-check-result', result);
    sendToRenderer('update-download-status', downloadState);
  };

  // --- IPC handlers ---
  ipcRegistry.registerHandler('app:get-info', () => getAppInfo());

  ipcRegistry.registerHandler('app:get-changelog', () => {
    const changelogPath = isDev
      ? join(process.cwd(), 'CHANGELOG.md')
      : join(process.resourcesPath, 'CHANGELOG.md');
    try {
      return fs.readFileSync(changelogPath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcRegistry.registerHandler(
    'audio:import-impulse-response',
    async (): Promise<ImportImpulseResponseResult> => {
      const win = getMainWindow();
      const options: OpenDialogOptions = {
        title: '导入空间音效文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Impulse Response Audio',
            extensions: [
              'irs',
              'wav',
              'wave',
              'flac',
              'aif',
              'aiff',
              'caf',
              'ogg',
              'oga',
              'mp3',
              'm4a',
              'aac',
              'opus',
            ],
          },
          { name: 'All Files', extensions: ['*'] },
        ],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const files: ImpulseResponseFile[] = [];
      const errors: string[] = [];

      for (const sourcePath of result.filePaths) {
        try {
          const imported = await importImpulseResponseFile(sourcePath);
          if (imported.file) files.push(imported.file);
          if (imported.error) errors.push(imported.error);
        } catch (error) {
          log.error('[Audio] Import impulse response failed:', { sourcePath, error });
          errors.push(`${basename(sourcePath)}: 音效文件导入失败。`);
        }
      }

      return {
        canceled: false,
        file: files[0],
        files,
        error: files.length === 0 ? errors[0] || '音效文件导入失败。' : undefined,
        errors,
      };
    },
  );

  ipcRegistry.registerHandler('audio:delete-impulse-response', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    const irsDir = getImpulseResponseDir();
    if (!isPathInside(filePath, irsDir)) return false;
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      log.warn('[Audio] Delete impulse response failed:', error);
      return false;
    }
  });

  ipcRegistry.registerHandler(
    'audio:reconcile-impulse-responses',
    async (_event, files: ImpulseResponseFile[] = []) => {
      if (!Array.isArray(files)) return [];
      const irsDir = getImpulseResponseDir();
      const next: ImpulseResponseFile[] = [];

      for (const file of files) {
        if (!file?.path || !isPathInside(file.path, irsDir)) continue;
        try {
          const stat = await fs.promises.stat(file.path);
          if (!stat.isFile()) continue;
          if (!(await isSupportedImpulseResponseAudio(file.path))) continue;
          const format = file.format || extname(file.path).replace(/^\./, '');
          next.push({
            ...file,
            size: stat.size,
            format: format || undefined,
          });
        } catch {
          // 文件被手动删除或不可读时，从列表中剔除
        }
      }

      return next;
    },
  );

  ipcRegistry.registerListener('open-log-directory', async () => {
    await openLogDirectory();
  });

  ipcRegistry.registerHandler('logging:get-settings', () => getLogSettings());

  ipcRegistry.registerHandler(
    'logging:update-settings',
    (_event, settings: Partial<LogSettings>) => {
      return applyLogSettings(settings, true);
    },
  );

  ipcRegistry.registerListener(
    'logging:update-settings',
    (_event, settings: Partial<LogSettings>) => {
      applyLogSettings(settings, true);
    },
  );

  ipcRegistry.registerHandler(
    'network:update-settings',
    async (_event, settings: Partial<NetworkSettings>) => {
      const next = updateNetworkSettings(settings);
      try {
        await mpvRef.current?.setNetworkSettings(next);
      } catch (error) {
        log.warn('[Network] Failed to apply mpv network settings:', error);
      }
      return next;
    },
  );

  ipcRegistry.registerListener(
    'check-for-updates',
    (_event, payload?: { prerelease?: boolean; silent?: boolean; githubProxyUrl?: string }) => {
      const silent = Boolean(payload?.silent);
      const prerelease = Boolean(payload?.prerelease);
      const githubProxyUrl = payload?.githubProxyUrl?.trim() || '';

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

      if (shouldUseArchManualUpdate()) {
        checkArchLinuxManualUpdate({ prerelease, silent, githubProxyUrl }).catch((error) => {
          log.error('[Updater] Arch Linux manual check failed:', error);
          sendToRenderer('update-check-result', {
            status: 'error',
            currentVersion: getAppInfo().version,
            message: error?.message || '更新检查失败，请稍后重试。',
            silent,
          } satisfies UpdateCheckResult);
        });
        return;
      }

      // 已在下载或已下载完成：不重复检查/下载，直接回传当前状态，
      // 保证再次点击「检查更新」时能复现弹窗并看到真实进度。
      if (downloadState.status === 'downloading' || downloadState.status === 'downloaded') {
        if (lastCheckResult) {
          sendToRenderer('update-check-result', { ...lastCheckResult, silent });
        }
        sendToRenderer('update-download-status', downloadState);
        return;
      }

      // 配置更新源
      if (githubProxyUrl) {
        const proxyBase = githubProxyUrl.endsWith('/') ? githubProxyUrl : `${githubProxyUrl}/`;

        if (prerelease) {
          // 预发布 + 代理：先通过 GitHub API 查询最新 prerelease 的 tag，再用代理下载
          log.info('[Updater] Fetching latest prerelease tag via GitHub API...');
          import('https')
            .then((https) => {
              const apiUrl = 'https://api.github.com/repos/hoowhoami/EchoMusic/releases?per_page=1';
              const req = https.get(
                apiUrl,
                { headers: { 'User-Agent': 'EchoMusic-Updater', Accept: 'application/json' } },
                (res) => {
                  let data = '';
                  res.on('data', (chunk: string) => (data += chunk));
                  res.on('end', () => {
                    try {
                      const releases = JSON.parse(data);
                      const latest = releases[0];
                      if (!latest?.tag_name) {
                        log.warn('[Updater] No prerelease found, falling back to github provider');
                        autoUpdater.setFeedURL({
                          provider: 'github',
                          owner: 'hoowhoami',
                          repo: 'EchoMusic',
                        });
                      } else {
                        const tag = latest.tag_name;
                        const feedUrl = `${proxyBase}https://github.com/hoowhoami/EchoMusic/releases/download/${tag}`;
                        log.info(`[Updater] Using proxy feed URL for prerelease: ${feedUrl}`);
                        autoUpdater.setFeedURL({
                          provider: 'generic',
                          url: feedUrl,
                        });
                      }
                    } catch {
                      log.warn('[Updater] Failed to parse API response, falling back');
                      autoUpdater.setFeedURL({
                        provider: 'github',
                        owner: 'hoowhoami',
                        repo: 'EchoMusic',
                      });
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
                  });
                },
              );
              req.on('error', (error) => {
                log.warn('[Updater] API request failed, falling back to github provider:', error);
                autoUpdater.setFeedURL({
                  provider: 'github',
                  owner: 'hoowhoami',
                  repo: 'EchoMusic',
                });
                autoUpdater.allowPrerelease = prerelease;
                (autoUpdater as any)._echoSilent = silent;
                autoUpdater.checkForUpdates().catch((err) => {
                  log.error('[Updater] Check failed:', err);
                  sendToRenderer('update-check-result', {
                    status: 'error',
                    currentVersion: getAppInfo().version,
                    message: err?.message || '更新检查失败，请稍后重试。',
                    silent,
                  } satisfies UpdateCheckResult);
                });
              });
            })
            .catch(() => {
              autoUpdater.setFeedURL({
                provider: 'github',
                owner: 'hoowhoami',
                repo: 'EchoMusic',
              });
              autoUpdater.allowPrerelease = prerelease;
              (autoUpdater as any)._echoSilent = silent;
              autoUpdater.checkForUpdates();
            });
          return;
        } else {
          // 正式版 + 代理：直接用 releases/latest/download
          const feedUrl = `${proxyBase}https://github.com/hoowhoami/EchoMusic/releases/latest/download`;
          log.info(`[Updater] Using proxy feed URL: ${feedUrl}`);
          autoUpdater.setFeedURL({
            provider: 'generic',
            url: feedUrl,
          });
        }
      } else {
        // 无代理：用 github provider 直连
        autoUpdater.setFeedURL({
          provider: 'github',
          owner: 'hoowhoami',
          repo: 'EchoMusic',
        });
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

  ipcRegistry.registerHandler('update:get-state', () => ({
    checkResult: lastCheckResult,
    download: downloadState,
  }));

  ipcRegistry.registerListener('update:download', () => {
    // 防重入：正在下载或已下载完成时忽略，仅回传当前状态
    if (downloadState.status === 'downloading' || downloadState.status === 'downloaded') {
      sendToRenderer('update-download-status', downloadState);
      return;
    }
    downloadState = {
      status: 'downloading',
      progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    };
    sendToRenderer('update-download-status', downloadState);
    autoUpdater.downloadUpdate().catch((error) => {
      log.error('[Updater] Download failed:', error);
      downloadState = {
        status: 'error',
        error: error?.message || '下载失败',
      };
      sendToRenderer('update-download-status', downloadState);
    });
  });

  ipcRegistry.registerListener('update:install', (_event, payload?: { silent?: boolean }) => {
    const isSilent = payload?.silent ?? false;
    autoUpdater.quitAndInstall(isSilent, true);
  });

  ipcRegistry.registerListener('open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('http')) return;
    await shell.openExternal(url);
  });

  ipcRegistry.registerListener('open-disclaimer', () => {
    const win = getMainWindow();
    if (!win) return;
    win.webContents.send('open-disclaimer');
  });

  ipcRegistry.registerListener('clear-app-data', async () => {
    getPlaybackQueueStorage().resetAll();
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
    await fs.promises.rm(getImpulseResponseDir(), { recursive: true, force: true });
  });

  // GPU 加速设置（需重启生效）
  ipcRegistry.registerListener('update-disable-gpu-acceleration', (_event, disabled: boolean) => {
    setMainAppSetting('disableGpuAcceleration', Boolean(disabled));
  });

  // 高 DPI 支持（需重启生效）
  ipcRegistry.registerListener(
    'update-high-dpi-settings',
    (_event, payload: { enabled?: boolean; dpiScale?: number }) => {
      const dpiScale = Math.min(2, Math.max(0.5, Number(payload?.dpiScale) || 1));
      setMainAppSetting('highDpiEnabled', Boolean(payload?.enabled));
      setMainAppSetting('dpiScale', dpiScale);
    },
  );

  // 获取系统全部字体
  ipcRegistry.registerHandler('get-all-fonts', async () => {
    try {
      const fonts = await getFonts({ disableQuoting: true });
      return fonts;
    } catch (error) {
      log.error('[Fonts] 获取系统字体失败:', error);
      return [];
    }
  });
};
