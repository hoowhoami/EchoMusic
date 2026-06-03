import { BrowserWindow, app, ipcMain, nativeTheme, screen, shell } from 'electron';
import { join } from 'path';
import type {
  MiniPlayerCommand,
  MiniPlayerSnapshot,
  MiniPlayerSnapshotPatch,
} from '../shared/mini-player';
import { MINI_PLAYER_DIMENSIONS } from '../shared/mini-player';
import { getMainWindow, hideMainWindow, showMainWindow } from './window';
import { setActiveWindowMode } from './windowMode';
import { getMainAppSettings, setMainAppSetting } from './storage/settings';

const MINI_PLAYER_WIDTH = MINI_PLAYER_DIMENSIONS.width;
const MINI_PLAYER_HEIGHT = MINI_PLAYER_DIMENSIONS.collapsedHeight;
const MINI_PLAYER_EXPANDED_HEIGHT = MINI_PLAYER_DIMENSIONS.expandedHeight;
// 收起时延迟还原窗口高度，等待渲染层 CSS 高度过渡（240ms）播完，留出缓冲避免提前裁切卡片
const MINI_PLAYER_COLLAPSE_DELAY_MS = 280;

let miniPlayerWindow: BrowserWindow | null = null;
let miniPlayerExpanded = false;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;

let snapshot: MiniPlayerSnapshot = {
  playback: null,
};

const canUseWindow = (win: BrowserWindow | null): win is BrowserWindow =>
  Boolean(win && !win.isDestroyed());

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 主进程权威判定深色：theme=system 跟随系统 nativeTheme，否则按设置。
// 不依赖隐藏的主窗口渲染层，保证 mini 在任意时刻都能正确响应深浅色。
const resolveIsDark = () => {
  const theme = getMainAppSettings().theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
};

// 用主进程权威的 isDark 覆盖快照里的 appearance（accentColor/fontFamily 仍由渲染层提供）
const applyAuthoritativeDarkMode = () => {
  if (!snapshot.appearance) return;
  const isDark = resolveIsDark();
  if (snapshot.appearance.isDark === isDark) return;
  snapshot = { ...snapshot, appearance: { ...snapshot.appearance, isDark } };
};

export const getMiniPlayerWindow = () => miniPlayerWindow;

const getMainRendererWindow = () => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  return mainWindow;
};

const sendSnapshot = () => {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('mini-player:snapshot', snapshot);
    } catch {
      // ignore windows destroyed during broadcast
    }
  });
};

const loadMiniPlayerWindow = async (win: BrowserWindow) => {
  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) {
    const target = new URL(url);
    target.hash = '/mini-player';
    await win.loadURL(target.toString());
    return;
  }

  await win.loadFile(join(__dirname, '../../dist/index.html'), {
    hash: '/mini-player',
  });
};

const resolveMiniPlayerBounds = () => {
  const saved = getMainAppSettings().miniPlayerWindowState;
  const width = MINI_PLAYER_WIDTH;
  const height = MINI_PLAYER_HEIGHT;
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const fallback = {
    width,
    height,
    x: Math.round(primaryArea.x + primaryArea.width - width - 48),
    y: Math.round(primaryArea.y + primaryArea.height - height - 72),
  };

  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return fallback;

  const isVisible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlap = 48;
    return (
      saved.x! + width > area.x + overlap &&
      saved.x! < area.x + area.width - overlap &&
      saved.y! + height > area.y + overlap &&
      saved.y! < area.y + area.height - overlap
    );
  });
  if (!isVisible) return fallback;

  const display = screen.getDisplayNearestPoint({
    x: Math.round(saved.x + width / 2),
    y: Math.round(saved.y + height / 2),
  });
  const area = display.workArea;
  return {
    width,
    height,
    x: clamp(Math.round(saved.x), area.x, area.x + area.width - width),
    y: clamp(Math.round(saved.y), area.y, area.y + area.height - height),
  };
};

let persistBoundsTimer: ReturnType<typeof setTimeout> | null = null;

const writeMiniPlayerBounds = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  // 顶边锚定：y 即窗口顶部，折叠/展开都不变，直接保存；高度始终存折叠值，下次以折叠态打开
  setMainAppSetting('miniPlayerWindowState', {
    width: MINI_PLAYER_WIDTH,
    height: MINI_PLAYER_HEIGHT,
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  });
};

// 拖动时 move 事件高频触发，去抖后再写设置，避免每像素同步落盘导致拖动卡顿
const persistMiniPlayerBounds = () => {
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    writeMiniPlayerBounds();
  }, 250);
};

// 一次性把窗口设为目标高度，顶边锚定（保持卡片顶边不动，向下展开），并夹取在工作区内。
// 高度动画交给渲染层 CSS（卡片高度过渡），避免逐帧 setBounds 造成透明窗口闪烁。
const applyMiniPlayerWindowHeight = (height: number) => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  if (bounds.height === height) return;

  // 顶边锚定：保持窗口顶部 y 不变，向下增高；若底部超出工作区则整体上移夹取在屏幕内
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  });
  const area = display.workArea;
  const y = clamp(Math.round(bounds.y), area.y, area.y + area.height - height);
  win.setBounds({ x: bounds.x, y, width: bounds.width, height });
};

const clearCollapseTimer = () => {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
};

const setMiniPlayerExpanded = (expanded: boolean) => {
  clearCollapseTimer();
  miniPlayerExpanded = expanded;
  if (expanded) {
    // 展开：窗口立即升至目标高度，渲染层卡片在透明空间内 CSS 上展
    applyMiniPlayerWindowHeight(MINI_PLAYER_EXPANDED_HEIGHT);
    return;
  }
  // 收起：先让渲染层卡片 CSS 下收，过渡结束后再缩小窗口，避免提前留出透明空洞
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    applyMiniPlayerWindowHeight(MINI_PLAYER_HEIGHT);
  }, MINI_PLAYER_COLLAPSE_DELAY_MS);
};

const collapseMiniPlayer = () => {
  clearCollapseTimer();
  if (!miniPlayerExpanded) return;
  miniPlayerExpanded = false;
  // 窗口即将隐藏，立即收起，无需动画
  applyMiniPlayerWindowHeight(MINI_PLAYER_HEIGHT);
};

export const ensureMiniPlayerWindow = async () => {
  if (canUseWindow(miniPlayerWindow)) {
    if (miniPlayerWindow.isMinimized()) miniPlayerWindow.restore();
    if (!miniPlayerWindow.isVisible()) miniPlayerWindow.show();
    miniPlayerWindow.focus();
    sendSnapshot();
    return miniPlayerWindow;
  }

  const preload = join(__dirname, '../preload/index.js');
  const bounds = resolveMiniPlayerBounds();
  const win = new BrowserWindow({
    title: 'EchoMusic Mini Player',
    ...(!app.isPackaged ? { icon: join(process.cwd(), 'build/icons/icon.png') } : {}),
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: true,
    // 透明窗口用原生阴影会在内容缩放时残留黑色条纹，改由渲染层 CSS 投影
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
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
      partition: 'persist:mini-player',
    },
  });

  miniPlayerWindow = win;
  miniPlayerExpanded = false;

  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1.0);
    sendSnapshot();
  });

  win.once('ready-to-show', () => {
    win.show();
    sendSnapshot();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    clearCollapseTimer();
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer);
      persistBoundsTimer = null;
    }
    miniPlayerWindow = null;
    miniPlayerExpanded = false;
  });

  if (process.platform === 'win32') {
    win.on('moved', persistMiniPlayerBounds);
  } else {
    win.on('move', persistMiniPlayerBounds);
  }

  await loadMiniPlayerWindow(win);
  return win;
};

export const showMiniPlayerWindow = async () => {
  setActiveWindowMode('mini');
  const win = await ensureMiniPlayerWindow();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  hideMainWindow();
  if (process.platform === 'darwin') {
    setTimeout(() => {
      hideMainWindow();
      if (!win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        win.focus();
      }
    }, 80);
  }
  sendSnapshot();
  return snapshot;
};

export const closeMiniPlayerWindow = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  if (persistBoundsTimer) {
    clearTimeout(persistBoundsTimer);
    persistBoundsTimer = null;
  }
  writeMiniPlayerBounds();
  collapseMiniPlayer();
  win.hide();
};

export const destroyMiniPlayerWindow = () => {
  const win = getMiniPlayerWindow();
  if (!win || win.isDestroyed()) return;
  miniPlayerWindow = null;
  win.destroy();
};

const forwardCommandToMainRenderer = (command: MiniPlayerCommand) => {
  const mainWindow = getMainRendererWindow();
  if (!mainWindow) return;
  mainWindow.webContents.send('mini-player:command', command);
};

export const getMiniPlayerSnapshot = () => snapshot;

export const registerMiniPlayerHandlers = () => {
  ipcMain.handle('mini-player:get-snapshot', () => getMiniPlayerSnapshot());

  ipcMain.handle('mini-player:show', async () => showMiniPlayerWindow());

  ipcMain.handle('mini-player:hide', () => {
    closeMiniPlayerWindow();
    return snapshot;
  });

  ipcMain.on('mini-player:sync-snapshot', (_event, payload: MiniPlayerSnapshotPatch) => {
    if (!payload) return;
    if (payload.playback !== undefined) {
      snapshot = {
        ...snapshot,
        playback: payload.playback,
      };
    }
    if (payload.appearance !== undefined) {
      snapshot = {
        ...snapshot,
        appearance: payload.appearance,
      };
      // 渲染层传来的 isDark 可能滞后（主窗口隐藏时 matchMedia 不可靠），用主进程权威值覆盖
      applyAuthoritativeDarkMode();
    }
    if (payload.queue !== undefined) {
      snapshot = {
        ...snapshot,
        queue: payload.queue,
      };
    }
    sendSnapshot();
  });

  ipcMain.on('mini-player:set-expanded', (_event, expanded: boolean) => {
    setMiniPlayerExpanded(Boolean(expanded));
  });

  ipcMain.handle('mini-player:get-bounds', () => {
    const win = getMiniPlayerWindow();
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    return win.getBounds();
  });

  // 自定义拖动：渲染层用 pointer 事件计算新坐标后下发（取代 -webkit-app-region: drag，
  // 后者会吞掉拖拽区的 pointer 事件导致 hover 闪烁）
  ipcMain.on('mini-player:move', (_event, x: number, y: number) => {
    const win = getMiniPlayerWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: bounds.width,
      height: bounds.height,
    });
    persistMiniPlayerBounds();
  });

  ipcMain.on('mini-player:command', (_event, command: MiniPlayerCommand) => {
    if (command === 'showMainWindow') {
      setActiveWindowMode('main');
      showMainWindow();
      closeMiniPlayerWindow();
      return;
    }
    if (command === 'closeMiniPlayer') {
      closeMiniPlayerWindow();
      return;
    }
    forwardCommandToMainRenderer(command);
  });
};

export const unregisterMiniPlayerHandlers = () => {
  ipcMain.removeHandler('mini-player:get-snapshot');
  ipcMain.removeHandler('mini-player:show');
  ipcMain.removeHandler('mini-player:hide');
  ipcMain.removeHandler('mini-player:get-bounds');
  ipcMain.removeAllListeners('mini-player:sync-snapshot');
  ipcMain.removeAllListeners('mini-player:set-expanded');
  ipcMain.removeAllListeners('mini-player:move');
  ipcMain.removeAllListeners('mini-player:command');
};

// 主题（应用设置或系统配色）变化时刷新 mini 的深色判定并广播。
// 应用设置变化由 window.ts 的 update-theme 调用；系统配色由下方 nativeTheme 监听。
export const refreshMiniPlayerDarkMode = () => {
  if (!snapshot.appearance) return;
  const before = snapshot.appearance.isDark;
  applyAuthoritativeDarkMode();
  if (snapshot.appearance.isDark !== before) sendSnapshot();
};

nativeTheme.on('updated', () => {
  refreshMiniPlayerDarkMode();
});
