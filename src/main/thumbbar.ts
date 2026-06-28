import { nativeImage, app, type BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import log from './logger';
import type { TrayCommand } from '../shared/tray';

interface ThumbbarContext {
  getMainWindow: () => BrowserWindow | null;
}

let isPlaying = false;
let thumbbarContext: ThumbbarContext | null = null;
let initialized = false;
let thumbbarAdded = false;

let iconPrev: Electron.NativeImage | null = null;
let iconPlay: Electron.NativeImage | null = null;
let iconPause: Electron.NativeImage | null = null;
let iconNext: Electron.NativeImage | null = null;

function getThumbbarIconsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'thumbbar-icons');
  }
  return path.join(app.getAppPath(), 'build', 'thumbbar-icons');
}

const loadIcon = (filename: string): Electron.NativeImage | null => {
  const filePath = path.join(getThumbbarIconsDir(), filename);
  if (!fs.existsSync(filePath)) {
    log.warn('[ThumbBar] Icon file not found:', filePath);
    return null;
  }
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) {
      log.warn('[ThumbBar] Icon image is empty:', filePath);
      return null;
    }
    const size = img.getSize();
    log.info('[ThumbBar] Loaded icon:', filename, `size=${size.width}x${size.height}`);
    return img;
  } catch (err) {
    log.warn('[ThumbBar] Failed to load icon:', filePath, err);
    return null;
  }
};

const ensureIcons = () => {
  if (!iconPrev) iconPrev = loadIcon('prev.png');
  if (!iconPlay) iconPlay = loadIcon('play.png');
  if (!iconPause) iconPause = loadIcon('pause.png');
  if (!iconNext) iconNext = loadIcon('next.png');
};

const forwardCommandToRenderer = (command: TrayCommand) => {
  const mainWindow = thumbbarContext?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shortcut-trigger', command);
};

const buildButtons = () => [
  {
    tooltip: '上一首',
    icon: iconPrev!,
    click: () => forwardCommandToRenderer('previousTrack'),
  },
  {
    tooltip: isPlaying ? '暂停' : '播放',
    icon: isPlaying ? iconPause! : iconPlay!,
    click: () => forwardCommandToRenderer('togglePlayback'),
  },
  {
    tooltip: '下一首',
    icon: iconNext!,
    click: () => forwardCommandToRenderer('nextTrack'),
  },
];

/**
 * 更新缩略图工具栏按钮（播放状态变化时调用）。
 * 一旦 thumbbar 已注册，后续更新不检查窗口可见性，
 * 因为 Windows 会在用户悬停任务栏图标时自动显示最新状态。
 */
export const updateThumbBarButtons = () => {
  if (process.platform !== 'win32') return;
  if (!thumbbarContext) return;
  if (!thumbbarAdded) return; // 尚未首次注册，等 onMainWindowShown

  const mainWindow = thumbbarContext.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  ensureIcons();
  if (!iconPrev || !iconPlay || !iconPause || !iconNext) return;

  try {
    const result = mainWindow.setThumbarButtons(buildButtons());
    log.info('[ThumbBar] Buttons updated, isPlaying:', isPlaying, 'result:', result);
  } catch (err) {
    log.warn('[ThumbBar] Failed to update thumbbar buttons:', err);
  }
};

export const updateThumbBarPlaybackState = (playing: boolean) => {
  if (isPlaying === playing) return;
  isPlaying = playing;
  updateThumbBarButtons();
};

/**
 * 窗口首次 show 时调用 —— 完成 thumbbar 的首次注册。
 * Windows ThumbBarAddButtons 要求窗口已可见，
 * 否则虽然返回 true 但按钮不会实际出现。
 */
export const onMainWindowShown = () => {
  if (process.platform !== 'win32' || thumbbarAdded) return;
  if (!thumbbarContext) return;

  const mainWindow = thumbbarContext.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  ensureIcons();
  if (!iconPrev || !iconPlay || !iconPause || !iconNext) {
    log.warn('[ThumbBar] Icons not ready, cannot setup thumbbar');
    return;
  }

  try {
    const result = mainWindow.setThumbarButtons(buildButtons());
    thumbbarAdded = true;
    log.info('[ThumbBar] Initial thumbbar registered, result:', result);
  } catch (err) {
    log.warn('[ThumbBar] Failed to setup initial thumbbar:', err);
  }
};

export const initThumbBar = (context: ThumbbarContext) => {
  if (process.platform !== 'win32') return;
  thumbbarContext = context;
  initialized = true;
  log.info('[ThumbBar] Context initialized, icons dir:', getThumbbarIconsDir());
  // 预加载图标，但不调用 setThumbarButtons —— 等 onMainWindowShown
  ensureIcons();
};

export const clearThumbBar = () => {
  if (process.platform !== 'win32' || !initialized) return;
  const mainWindow = thumbbarContext?.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setThumbarButtons([]); } catch { /* ignore */ }
  }
  initialized = false;
  thumbbarAdded = false;
};
