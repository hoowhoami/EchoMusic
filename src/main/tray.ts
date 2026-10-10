import { Menu, Tray, app, nativeImage, screen, type MenuItemConstructorOptions } from 'electron';
import { statSync } from 'fs';
import { quitApplication } from './window';
import { DEFAULT_PLAYER_VOLUME, type PlayMode } from '../shared/playback';
import type { DesktopLyricSnapshot } from '../shared/desktopLyric';
import type { TrayCommand, TrayPlaybackPayload } from '../shared/tray';
import log, { isDiagnosticModeActive } from './logger';
import { resolveTrayIconPath } from './appIcons';
import { registerMacTrayVisibility } from './macBackgroundMode';

interface TrayContext {
  getMainWindow: () => Electron.BrowserWindow | null;
  /** 恢复上次所在的窗口模式（托盘左键用）。 */
  restoreWindow: () => unknown;
  /** 显式打开主窗口（托盘菜单「打开主窗口」）。 */
  showMainWindow: () => unknown;
  /** 显式打开 Mini 窗口（托盘菜单「打开 Mini 窗口」）。 */
  showMiniPlayer: () => unknown;
  getDesktopLyricSnapshot: () => DesktopLyricSnapshot;
  toggleDesktopLyricLock: () => DesktopLyricSnapshot | Promise<DesktopLyricSnapshot>;
}

type TrayPlaybackState = Required<TrayPlaybackPayload>;

let appTray: Tray | null = null;
let trayContext: TrayContext | null = null;
let trayVisible = true;
let cachedTrayImage: { key: string; image: Electron.NativeImage } | null = null;
let appliedTrayImageKey: string | null = null;
let trayPopupSequence = 0;
// VS Code #72447 and Electron #53738 retain menus while native code references
// their models. 43.7.6 lacks the tray fix. Keep the latest menu even after close
// because the Win32 MenuRunner remains owned by the tray until replacement.
const retainedElectronTrayMenus = new Set<Menu>();
let playbackState: TrayPlaybackState = {
  isPlaying: false,
  playMode: 'list',
  volume: DEFAULT_PLAYER_VOLUME,
};

const playModeLabelMap: Record<PlayMode, string> = {
  sequential: '顺序播放',
  list: '列表循环',
  random: '随机播放',
  single: '单曲循环',
};

const getTrayIconCacheKey = (iconPath: string) => {
  if (!iconPath) return `${process.platform}:empty`;
  try {
    const stats = statSync(iconPath);
    return `${process.platform}:${iconPath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${process.platform}:${iconPath}:missing`;
  }
};

const clearTrayImageCache = () => {
  cachedTrayImage = null;
  appliedTrayImageKey = null;
};

const getTrayImage = () => {
  const iconPath = resolveTrayIconPath();
  const cacheKey = getTrayIconCacheKey(iconPath);
  if (cachedTrayImage?.key === cacheKey) return cachedTrayImage;

  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      log.warn('[Tray] Icon image is empty:', iconPath);
      cachedTrayImage = { key: cacheKey, image: nativeImage.createEmpty() };
      return cachedTrayImage;
    }
    if (process.platform === 'darwin') {
      image.setTemplateImage(true);
    } else {
      // Win10/Win11/Linux：resize 到标准尺寸，避免兼容性问题
      cachedTrayImage = { key: cacheKey, image: image.resize({ width: 20, height: 20 }) };
      return cachedTrayImage;
    }
    cachedTrayImage = { key: cacheKey, image };
    return cachedTrayImage;
  } catch (e) {
    log.error('[Tray] Failed to create tray image:', e);
    cachedTrayImage = { key: cacheKey, image: nativeImage.createEmpty() };
    return cachedTrayImage;
  }
};

const applyTrayImageIfNeeded = () => {
  if (!appTray) return;
  const trayImage = getTrayImage();
  if (appliedTrayImageKey === trayImage.key) return;
  appTray.setImage(trayImage.image);
  appliedTrayImageKey = trayImage.key;
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
    label: `音量 ${Math.round(playbackState.volume)}%`,
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
      label: '打开主窗口',
      click: () => void trayContext?.showMainWindow(),
    },
    {
      label: '打开 Mini 窗口',
      click: () => void trayContext?.showMiniPlayer(),
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

const logTrayDiagnostic = (tray: Tray, phase: string, details: Record<string, unknown> = {}) => {
  if (process.platform !== 'win32' || !isDiagnosticModeActive()) return;
  try {
    const mainWindow = trayContext?.getMainWindow();
    const cursor = screen.getCursorScreenPoint();
    log.info('[TrayDiagnostic]', {
      phase,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      windowsVersion: process.getSystemVersion(),
      forcedScale: app.commandLine.getSwitchValue('force-device-scale-factor'),
      trayBounds: tray.getBounds(),
      cursor,
      cursorDisplayId: screen.getDisplayNearestPoint(cursor).id,
      displays: screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor, rotation }) => ({
        id,
        bounds,
        workArea,
        scaleFactor,
        rotation,
      })),
      mainWindow:
        mainWindow && !mainWindow.isDestroyed()
          ? {
              bounds: mainWindow.getBounds(),
              visible: mainWindow.isVisible(),
              minimized: mainWindow.isMinimized(),
              focused: mainWindow.isFocused(),
            }
          : null,
      ...details,
    });
  } catch (error) {
    // Diagnostic collection must never prevent a popup.
    log.warn('[TrayDiagnostic] Snapshot failed:', error);
  }
};

const popupElectronTrayMenu = (tray: Tray, attempt: number) => {
  const menu = createTrayMenu();
  // Retain the previous model too, until popUpContextMenu replaces its runner.
  retainedElectronTrayMenus.add(menu);
  if (process.platform === 'win32' && isDiagnosticModeActive()) {
    // These events show how far the popup request progressed, not whether the
    // menu was actually visible on the desktop.
    menu.once('menu-will-show', () => logTrayDiagnostic(tray, 'menu-will-show', { attempt }));
    menu.once('menu-will-close', () => logTrayDiagnostic(tray, 'menu-will-close', { attempt }));
  }
  logTrayDiagnostic(tray, 'electron-popup-request', { attempt });
  try {
    tray.popUpContextMenu(menu);
    for (const previousMenu of retainedElectronTrayMenus) {
      if (previousMenu !== menu) retainedElectronTrayMenus.delete(previousMenu);
    }
    logTrayDiagnostic(tray, 'electron-popup-returned', { attempt });
  } catch (error) {
    retainedElectronTrayMenus.delete(menu);
    log.error('[Tray] Electron menu failed:', error);
  }
};

export const createDockMenu = () =>
  Menu.buildFromTemplate([
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    ...createDesktopLyricMenuItems(),
  ]);

const rebuildTrayMenu = () => {
  if (appTray) {
    applyTrayImageIfNeeded();
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
  if (!trayVisible) return null;
  if (appTray) {
    rebuildTrayMenu();
    return appTray;
  }

  const trayImage = getTrayImage();
  appTray = new Tray(trayImage.image);
  appliedTrayImageKey = trayImage.key;
  appTray.setToolTip('EchoMusic');
  logTrayDiagnostic(appTray, 'created');

  appTray.on('click', () => {
    void trayContext?.restoreWindow();
  });

  if (process.platform === 'linux') {
    appTray.setContextMenu(createTrayMenu());
  } else {
    appTray.on('right-click', (_event, eventBounds) => {
      if (appTray) logTrayDiagnostic(appTray, 'right-click', { eventBounds });
      if (appTray) popupElectronTrayMenu(appTray, ++trayPopupSequence);
    });
  }

  return appTray;
};

export const refreshTray = () => {
  if (!trayContext) return null;
  clearTrayImageCache();
  if (appTray) {
    destroyTray();
  }
  return initTray(trayContext);
};

export const destroyTray = () => {
  if (!appTray) return;
  if (retainedElectronTrayMenus.size) appTray.closeContextMenu();
  appTray.destroy();
  appTray = null;
  retainedElectronTrayMenus.clear();
  clearTrayImageCache();
};

registerMacTrayVisibility((visible) => {
  trayVisible = visible;
  if (!visible) destroyTray();
  else if (trayContext) {
    try {
      initTray(trayContext);
    } catch (error) {
      log.error('[Tray] Failed to restore tray:', error);
    }
  }
});

export const updateTrayPlaybackState = (nextState: Partial<TrayPlaybackState>) => {
  playbackState = {
    ...playbackState,
    ...nextState,
  };
  rebuildTrayMenu();
};
