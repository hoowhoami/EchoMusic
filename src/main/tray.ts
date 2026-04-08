import {
  Menu,
  Tray,
  app,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions,
} from 'electron';
import { quitApplication } from './window';
import { join } from 'path';

type TrayCommand = 'togglePlayback' | 'previousTrack' | 'nextTrack';
type PlayMode = 'list' | 'random' | 'single';

interface TrayContext {
  getMainWindow: () => Electron.BrowserWindow | null;
  restoreWindow: () => void;
}

interface TrayPlaybackState {
  isPlaying: boolean;
  playMode: PlayMode;
}

const TRAY_GUID = '3f7a61a2-6707-46ba-95d9-4c53dbb9581a';

let appTray: Tray | null = null;
let trayContext: TrayContext | null = null;
let playbackState: TrayPlaybackState = {
  isPlaying: false,
  playMode: 'list',
};

const playModeLabelMap: Record<PlayMode, string> = {
  list: '列表循环',
  random: '随机播放',
  single: '单曲循环',
};

const resolveTrayIconPath = () => {
  let shouldUseLightTrayIcon = nativeTheme.shouldUseDarkColors;

  if (process.platform === 'win32') {
    // 读取 Windows 注册表判断任务栏是否为深色
    // SystemUsesLightTheme: 0 = 深色任务栏（需要浅色图标），1 = 浅色任务栏（需要深色图标）
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const match = result.match(/SystemUsesLightTheme\s+REG_DWORD\s+0x(\d+)/);
      if (match) {
        shouldUseLightTrayIcon = match[1] === '0'; // 0 = 深色系统 → 用浅色图标
      }
    } catch {
      shouldUseLightTrayIcon = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    }
  }

  const iconName =
    process.platform === 'darwin'
      ? 'IconTemplate.png'
      : process.platform === 'win32'
        ? shouldUseLightTrayIcon
          ? 'win_tray_icon_light.ico'
          : 'win_tray_icon_dark.ico'
        : 'linux_tray_icon.png';

  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons', iconName);
  }

  return join(process.cwd(), 'build/icons', iconName);
};

const createTrayImage = () => {
  const image = nativeImage.createFromPath(resolveTrayIconPath());

  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }

  return image;
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
  appTray = process.platform === 'linux' ? new Tray(trayImage) : new Tray(trayImage, TRAY_GUID);
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

  if (process.platform === 'win32') {
    nativeTheme.on('updated', rebuildTrayMenu);
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
  if (process.platform === 'win32') {
    nativeTheme.removeListener('updated', rebuildTrayMenu);
  }
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
