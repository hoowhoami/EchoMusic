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

export const getMiniPlayerWindow = () => miniPlayerWindow;

const getMainRendererWindow = () => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  return mainWindow;
};

const sendSnapshot = () => {
  const win = miniPlayerWindow;
  if (!canUseWindow(win)) return;
  try {
    win.webContents.send('mini-player:snapshot', snapshot);
  } catch {
    // ignore if window destroyed during send
  }
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
    x: Math.round(primaryArea.x + (primaryArea.width - width) / 2),
    y: Math.round(primaryArea.y + (primaryArea.height - height) / 2),
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
    }
    if (payload.queue !== undefined) {
      snapshot = {
        ...snapshot,
        queue: payload.queue,
      };
    }
    if (payload.lyric !== undefined) {
      const previousLyric = snapshot.lyric;
      const shouldKeepPreviousLyricLines =
        Array.isArray(payload.lyric.lines) &&
        payload.lyric.lines.length === 0 &&
        (previousLyric?.lines.length ?? 0) > 0 &&
        Boolean(payload.lyric.trackId) &&
        payload.lyric.trackId === previousLyric?.trackId;
      const nextLyric = {
        trackId: null,
        lines: [],
        currentIndex: -1,
        wantTranslation: false,
        wantRomanization: false,
        hasTranslation: false,
        hasRomanization: false,
        desktopLyricEnabled: false,
        ...(previousLyric ?? {}),
        ...payload.lyric,
      };
      snapshot = {
        ...snapshot,
        lyric: shouldKeepPreviousLyricLines
          ? {
              ...nextLyric,
              lines: previousLyric?.lines ?? [],
              hasTranslation: previousLyric?.hasTranslation ?? nextLyric.hasTranslation,
              hasRomanization: previousLyric?.hasRomanization ?? nextLyric.hasRomanization,
              tips: previousLyric?.tips ?? nextLyric.tips,
            }
          : nextLyric,
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
    // 使用固定宽高避免 Windows DPI 缩放导致的尺寸舍入累积
    const height = miniPlayerExpanded ? MINI_PLAYER_EXPANDED_HEIGHT : MINI_PLAYER_HEIGHT;
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: MINI_PLAYER_WIDTH,
      height,
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

  // mini 窗口通知歌词面板可见状态，转发给主渲染进程以调整同步频率
  ipcMain.on('mini-player:lyric-visibility', (_event, visible: boolean) => {
    const mainWindow = getMainRendererWindow();
    if (!mainWindow) return;
    mainWindow.webContents.send('mini-player:lyric-visibility', visible);
  });
};

// 系统主题变化时，根据应用设置决定是否更新 mini player 的深浅色状态
nativeTheme.on('updated', () => {
  if (!canUseWindow(miniPlayerWindow)) return;
  if (!snapshot.appearance) return;
  const theme = getMainAppSettings().theme;
  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  if (snapshot.appearance.isDark === isDark) return;
  snapshot = {
    ...snapshot,
    appearance: { ...snapshot.appearance, isDark },
  };
  sendSnapshot();
});

export const unregisterMiniPlayerHandlers = () => {
  ipcMain.removeHandler('mini-player:get-snapshot');
  ipcMain.removeHandler('mini-player:show');
  ipcMain.removeHandler('mini-player:hide');
  ipcMain.removeHandler('mini-player:get-bounds');
  ipcMain.removeAllListeners('mini-player:sync-snapshot');
  ipcMain.removeAllListeners('mini-player:set-expanded');
  ipcMain.removeAllListeners('mini-player:move');
  ipcMain.removeAllListeners('mini-player:command');
  ipcMain.removeAllListeners('mini-player:lyric-visibility');
};
