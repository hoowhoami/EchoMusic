import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { quitApplication } from './window';
import type { PlayMode } from '../shared/playback';
import type { DesktopLyricSnapshot } from '../shared/desktop-lyric';
import type { TrayCommand, TrayPlaybackPayload } from '../shared/tray';
import log from './logger';
import { resolveTrayIconPath } from './appIcons';

interface TrayContext {
  getMainWindow: () => Electron.BrowserWindow | null;
  restoreWindow: () => void | Promise<void>;
  getDesktopLyricSnapshot: () => DesktopLyricSnapshot;
  toggleDesktopLyricLock: () => DesktopLyricSnapshot | Promise<DesktopLyricSnapshot>;
}

type TrayPlaybackState = Required<TrayPlaybackPayload>;

let appTray: Tray | null = null;
let trayContext: TrayContext | null = null;
let playbackState: TrayPlaybackState = {
  isPlaying: false,
  playMode: 'list',
  volume: 0.8,
};

const playModeLabelMap: Record<PlayMode, string> = {
  sequential: '顺序播放',
  list: '列表循环',
  random: '随机播放',
  single: '单曲循环',
};

const createTrayImage = () => {
  const iconPath = resolveTrayIconPath();
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      log.warn('[Tray] Icon image is empty:', iconPath);
      return nativeImage.createEmpty();
    }
    if (process.platform === 'darwin') {
      image.setTemplateImage(true);
    } else {
      // Win10/Win11/Linux：resize 到标准尺寸，避免兼容性问题
      return image.resize({ width: 20, height: 20 });
    }
    return image;
  } catch (e) {
    log.error('[Tray] Failed to create tray image:', e);
    return nativeImage.createEmpty();
  }
};

const forwardCommandToRenderer = (command: TrayCommand) => {
  const mainWindow = trayContext?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shortcut-trigger', command);
};

const setPlayModeFromTray = (playMode: PlayMode) => {
  const mainWindow = trayContext?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tray:set-play-mode', playMode);
};

const toggleDesktopLyricLockFromMenu = async () => {
  if (!trayContext) return;
  const snapshot = trayContext.getDesktopLyricSnapshot();
  if (!snapshot.settings.enabled) return;
  try {
    await trayContext.toggleDesktopLyricLock();
  } catch (err) {
    log.error('[Tray] Failed to toggle desktop lyric lock:', err);
  }
};

const createPlaybackMenuItems = (): MenuItemConstructorOptions[] => [
  {
    label: playbackState.isPlaying ? '暂停' : '播放',
    click: () => forwardCommandToRenderer('togglePlayback'),
  },
  {
    label: '上一首',
    click: () => forwardCommandToRenderer('previousTrack'),
  },
  {
    label: '下一首',
    click: () => forwardCommandToRenderer('nextTrack'),
  },
  {
    label: '播放模式',
    submenu: (
      Object.entries(playModeLabelMap) as Array<[PlayMode, string]>
    ).map<MenuItemConstructorOptions>(([mode, label]) => ({
      label,
      type: 'radio',
      checked: playbackState.playMode === mode,
      click: () => setPlayModeFromTray(mode),
    })),
  },
  { type: 'separator' },
  {
    label: `音量 ${Math.round(playbackState.volume * 100)}%`,
    enabled: false,
  },
  {
    label: '增大音量',
    click: () => forwardCommandToRenderer('volumeUp'),
  },
  {
    label: '减小音量',
    click: () => forwardCommandToRenderer('volumeDown'),
  },
  {
    label: '静音 / 取消静音',
    click: () => forwardCommandToRenderer('toggleMute'),
  },
];

const createDesktopLyricMenuItems = (): MenuItemConstructorOptions[] => {
  const snapshot = trayContext?.getDesktopLyricSnapshot();
  const opened = snapshot?.settings.enabled ?? false;
  const locked = opened && (snapshot?.settings.locked ?? false);

  return [
    {
      label: locked ? '解锁桌面歌词' : '锁定桌面歌词',
      enabled: opened,
      click: () => void toggleDesktopLyricLockFromMenu(),
    },
  ];
};

const createTrayMenu = () => {
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => void trayContext?.restoreWindow(),
    },
    { type: 'separator' },
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    ...createDesktopLyricMenuItems(),
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApplication(),
    },
  ]);
};

export const createDockMenu = () =>
  Menu.buildFromTemplate([
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    ...createDesktopLyricMenuItems(),
  ]);

const rebuildTrayMenu = () => {
  if (appTray) {
    appTray.setImage(createTrayImage());
    appTray.setToolTip('EchoMusic');
    if (process.platform === 'linux') {
      appTray.setContextMenu(createTrayMenu());
    }
  }

  if (process.platform === 'darwin') {
    app.dock?.setMenu(createDockMenu());
  }
};

export const refreshTrayMenus = () => {
  rebuildTrayMenu();
};

export const initTray = (context: TrayContext) => {
  trayContext = context;
  if (appTray) {
    rebuildTrayMenu();
    return appTray;
  }

  const trayImage = createTrayImage();
  appTray = new Tray(trayImage);
  appTray.setToolTip('EchoMusic');

  appTray.on('click', () => {
    void trayContext?.restoreWindow();
  });

  if (process.platform === 'linux') {
    appTray.setContextMenu(createTrayMenu());
  } else {
    appTray.on('right-click', () => {
      appTray?.popUpContextMenu(createTrayMenu());
    });
  }

  return appTray;
};

export const refreshTray = () => {
  if (!trayContext) return null;
  if (appTray) {
    destroyTray();
  }
  return initTray(trayContext);
};

export const destroyTray = () => {
  if (!appTray) return;
  appTray.destroy();
  appTray = null;
};

export const updateTrayPlaybackState = (nextState: Partial<TrayPlaybackState>) => {
  playbackState = {
    ...playbackState,
    ...nextState,
  };
  rebuildTrayMenu();
};
