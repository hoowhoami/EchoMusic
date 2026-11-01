import { execFile } from 'child_process';
import { promisify } from 'util';
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } from 'electron';
import { join } from 'path';
import log from './logger';
import type { NowPlayingPlaybackPayload } from '../shared/nowPlaying';

let currentIsPlaying = false;
let currentIsFavorite = false;
let hasCurrentTrack = false;
let targetWindow: BrowserWindow | null = null;
let thumbarSetup = false;

// --- Tabler 描边图标（样式迁移自 EchoMusicNext，PNG 由 build/icons/thumbar/svg 离线生成） ---

type ThumbarIcons = {
  play: Electron.NativeImage;
  pause: Electron.NativeImage;
  prev: Electron.NativeImage;
  next: Electron.NativeImage;
  heart: Electron.NativeImage;
  heartFilled: Electron.NativeImage;
};

// 深色任务栏用白色描边（-white），浅色任务栏用深色描边（-dark）；
// 收藏实心心为固定强调红，不随主题变化。
const iconCache = new Map<boolean, ThumbarIcons>();

// 任务栏配色只跟随 Windows 系统设置，不跟随软件内主题：nativeTheme.shouldUseDarkColors
// 会被 window/index.ts 的 themeSource 同步污染，因此像 EchoMusicNext 的 TrayIconTheme
// 一样直接读注册表里任务栏的真实模式（浅色任务栏 → SystemUsesLightTheme=1）。
const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

let taskbarLightTheme: boolean | null = null;

const execFileAsync = promisify(execFile);

const readTaskbarLightThemeAsync = async (): Promise<boolean> => {
  try {
    // 异步读取注册表：execSync 同步 spawn reg.exe 会阻塞主进程（正常 30-80ms，超时上限 2s）
    const { stdout } = await execFileAsync(
      'reg',
      ['query', PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'],
      { timeout: 2000 },
    );
    return /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(stdout);
  } catch {
    // 读取失败按深色任务栏处理（Windows 默认配色）
    return false;
  }
};

let refreshingTaskbarLightTheme = false;

/** 异步刷新任务栏明暗缓存；读取结果变化时重建图标并重新应用任务栏按钮。 */
const refreshTaskbarLightTheme = async (): Promise<void> => {
  if (refreshingTaskbarLightTheme) return;
  refreshingTaskbarLightTheme = true;
  try {
    const light = await readTaskbarLightThemeAsync();
    if (light === taskbarLightTheme) return;
    taskbarLightTheme = light;
    iconCache.clear();
    const win = targetWindow;
    if (win && !win.isDestroyed()) applyThumbarButtons(win);
  } finally {
    refreshingTaskbarLightTheme = false;
  }
};

const ensureTaskbarLightTheme = (): boolean => {
  if (taskbarLightTheme === null) {
    // 首次先按 Windows 默认（深色）同步渲染，注册表读取完成后在
    // refreshTaskbarLightTheme 里按真实值刷新，避免启动路径同步阻塞。
    taskbarLightTheme = false;
    void refreshTaskbarLightTheme();
  }
  return taskbarLightTheme;
};

const resolveIconPath = (file: string) =>
  app.isPackaged
    ? join(process.resourcesPath, 'icons', 'thumbar', file)
    : join(__dirname, '../../build/icons/thumbar', file);

const loadIcons = (light: boolean): ThumbarIcons => {
  const suffix = light ? 'dark' : 'white';
  const load = (file: string) => nativeImage.createFromPath(resolveIconPath(file));
  return {
    prev: load(`prev-${suffix}.png`),
    next: load(`next-${suffix}.png`),
    play: load(`play-${suffix}.png`),
    pause: load(`pause-${suffix}.png`),
    heart: load(`heart-${suffix}.png`),
    heartFilled: load('heart-filled-red.png'),
  };
};

function getIcons(): ThumbarIcons {
  const light = ensureTaskbarLightTheme();
  let icons = iconCache.get(light);
  if (!icons) {
    icons = loadIcons(light);
    iconCache.clear();
    iconCache.set(light, icons);
  }
  return icons;
}

function buildThumbarButtons(win: BrowserWindow): Electron.ThumbarButton[] {
  const icons = getIcons();
  return [
    {
      tooltip: '上一曲',
      icon: icons.prev,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Previous track clicked');
        win.webContents.send('media-control:event', { type: 'PreviousSong' });
      },
    },
    {
      tooltip: currentIsPlaying ? '暂停' : '播放',
      icon: currentIsPlaying ? icons.pause : icons.play,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Play/Pause clicked');
        win.webContents.send('media-control:event', {
          type: currentIsPlaying ? 'Pause' : 'Play',
        });
      },
    },
    {
      tooltip: '下一曲',
      icon: icons.next,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Next track clicked');
        win.webContents.send('media-control:event', { type: 'NextSong' });
      },
    },
    {
      tooltip: currentIsFavorite ? '取消收藏' : '收藏',
      icon: currentIsFavorite ? icons.heartFilled : icons.heart,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        if (hasCurrentTrack && !win.isDestroyed()) {
          win.webContents.send('now-playing:command', 'toggleFavorite');
        }
      },
    },
  ];
}

function applyThumbarButtons(win: BrowserWindow) {
  if (win.isDestroyed()) return false;
  const result = win.setThumbarButtons(buildThumbarButtons(win));
  log.info('[Thumbar] setThumbarButtons result:', result);
  return result;
}

export function setupThumbarButtons(win: BrowserWindow) {
  if (process.platform !== 'win32') return;
  if (targetWindow !== win) {
    targetWindow = win;
    // Rebind window lifecycle on recreation, without adding duplicate IPC listeners.
    win.on('show', () => applyThumbarButtons(win));
    win.once('closed', () => {
      if (targetWindow === win) targetWindow = null;
    });
  }
  if (!thumbarSetup) {
    thumbarSetup = true;

    // nativeTheme updated 在系统主题设置变化（WM_SETTINGCHANGE）时触发；软件内
    // 主题切换同样会走到这里，但任务栏只认注册表里的系统模式，值不变就不刷新
    nativeTheme.on('updated', () => {
      // 应用内主题切换同样会触发本事件，注册表读取改为异步，避免阻塞主进程
      void refreshTaskbarLightTheme();
    });

    ipcMain.on('thumbar:update-play-state', (event, isPlaying: boolean) => {
      const win = targetWindow;
      if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return;
      if (typeof isPlaying !== 'boolean' || !hasCurrentTrack) return;
      if (currentIsPlaying === isPlaying) return;
      currentIsPlaying = isPlaying;
      if (!win.isDestroyed()) {
        applyThumbarButtons(win);
      }
    });
  }

  applyThumbarButtons(win);
  log.info('[Thumbar] Thumbnail toolbar buttons initialized');
}

/** Reuse the validated v2.3.1 playback snapshot; no second renderer state channel. */
export function updateThumbarPlayback(playback: NowPlayingPlaybackPayload | null): void {
  if (process.platform !== 'win32') return;
  const hasTrack = Boolean(playback?.trackId);
  const playing = hasTrack && Boolean(playback?.isPlaying);
  const favorite = hasTrack && Boolean(playback?.isFavorite);
  if (
    hasCurrentTrack === hasTrack &&
    currentIsPlaying === playing &&
    currentIsFavorite === favorite
  )
    return;
  hasCurrentTrack = hasTrack;
  currentIsPlaying = playing;
  currentIsFavorite = favorite;
  if (targetWindow) applyThumbarButtons(targetWindow);
}
