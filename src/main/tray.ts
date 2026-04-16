import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { quitApplication } from './window';
import { join } from 'path';
import type { PlayMode } from '../shared/playback';
import type { TrayCommand, TrayPlaybackPayload } from '../shared/tray';

interface TrayContext {
  getMainWindow: () => Electron.BrowserWindow | null;
  restoreWindow: () => void;
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

const resolveTrayIconPath = () => {
  const iconName =
    process.platform === 'darwin'
      ? 'IconTemplate.png'
      : process.platform === 'win32'
        ? 'win_tray_icon.ico'
        : 'linux_tray_icon.png';

  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons', iconName);
  }

  return join(process.cwd(), 'build/icons', iconName);
};

const createTrayImage = () => {
  const iconPath = resolveTrayIconPath();
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.warn('[Tray] Icon image is empty:', iconPath);
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
    console.error('[Tray] Failed to create tray image:', e);
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

const createTrayMenu = () => {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => trayContext?.restoreWindow(),
    },
    { type: 'separator' },
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApplication(),
    },
  ]);
};

export const createDockMenu = () => Menu.buildFromTemplate(createPlaybackMenuItems());

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
    trayContext?.restoreWindow();
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
