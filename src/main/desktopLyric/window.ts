import { BrowserWindow, app } from 'electron';
import { join } from 'path';
import {
  DESKTOP_LYRIC_MAX_HEIGHT,
  DESKTOP_LYRIC_MAX_WIDTH,
  DESKTOP_LYRIC_MIN_HEIGHT,
  DESKTOP_LYRIC_MIN_WIDTH,
  type DesktopLyricWindowState,
  persistDesktopLyricWindowState,
  resolveInitialBounds,
} from './store';

const getBackgroundColor = () => '#00000000';
const desktopLyricUrl = process.env.VITE_DEV_SERVER_URL;
const desktopLyricHtml = join(__dirname, '../../dist/desktop-lyric.html');

let desktopLyricWindow: BrowserWindow | null = null;

export const getDesktopLyricWindow = () => desktopLyricWindow;

export const withDesktopLyricWindow = (window: BrowserWindow | null) => {
  desktopLyricWindow = window;
};

export const isDesktopLyricWindowAvailable = () =>
  Boolean(desktopLyricWindow && !desktopLyricWindow.isDestroyed());

export const persistWindowBounds = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const bounds = desktopLyricWindow.getBounds();
  persistDesktopLyricWindowState(bounds);
};

export const syncWindowPresentation = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBackgroundColor(getBackgroundColor());
  desktopLyricWindow.setAlwaysOnTop(true, 'screen-saver');
  desktopLyricWindow.setSkipTaskbar(true);
};

export const createDesktopLyricWindow = () => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) return desktopLyricWindow;

  const preload = join(__dirname, '../preload/index.js');
  const bounds = resolveInitialBounds();

  desktopLyricWindow = new BrowserWindow({
    title: 'EchoMusic Desktop Lyric',
    ...(!app.isPackaged ? { icon: join(process.cwd(), 'build/icons/icon.png') } : {}),
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: DESKTOP_LYRIC_MIN_WIDTH,
    minHeight: DESKTOP_LYRIC_MIN_HEIGHT,
    maxWidth: DESKTOP_LYRIC_MAX_WIDTH,
    maxHeight: DESKTOP_LYRIC_MAX_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: getBackgroundColor(),
    show: false,
    resizable: true,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      zoomFactor: 1.0,
      partition: 'persist:desktop-lyric',
    },
  });

  desktopLyricWindow.webContents.on('did-finish-load', () => {
    desktopLyricWindow?.webContents.setZoomFactor(1.0);
  });

  desktopLyricWindow.on('move', persistWindowBounds);
  desktopLyricWindow.on('resize', persistWindowBounds);

  return desktopLyricWindow;
};

export const loadDesktopLyricWindow = async () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;

  if (desktopLyricUrl) {
    await desktopLyricWindow.loadURL(new URL('desktop-lyric.html', desktopLyricUrl).toString());
  } else {
    await desktopLyricWindow.loadFile(desktopLyricHtml);
  }
};

export const applyWindowBounds = (bounds: DesktopLyricWindowState) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBounds({
    x: Math.round(bounds.x ?? 0),
    y: Math.round(bounds.y ?? 0),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
};

export const updateWindowHeight = (height: number) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || !height) return;
  const bounds = desktopLyricWindow.getBounds();
  desktopLyricWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.round(height),
  });
  persistDesktopLyricWindowState({
    ...bounds,
    height,
  });
};

export const setDesktopLyricFixedSize = (options: {
  width: number;
  height: number;
  fixed: boolean;
}) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  if (options.fixed) {
    desktopLyricWindow.setMaximumSize(options.width, options.height);
  } else {
    desktopLyricWindow.setMaximumSize(DESKTOP_LYRIC_MAX_WIDTH, DESKTOP_LYRIC_MAX_HEIGHT);
  }
};
