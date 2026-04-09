import { BrowserWindow, app, ipcMain, nativeTheme, screen } from 'electron';
import Conf from 'conf';
import { join } from 'path';
import type {
  DesktopLyricLockPhase,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';

type DesktopLyricWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

type DesktopLyricResizeDirection =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

type DesktopLyricResizeSession = {
  direction: DesktopLyricResizeDirection;
  startBounds: Electron.Rectangle;
  startScreenX: number;
  startScreenY: number;
};

type DesktopLyricDragSession = {
  startBounds: Electron.Rectangle;
  startScreenX: number;
  startScreenY: number;
};

type DesktopLyricPersistedSettings = DesktopLyricSettings & {
  windowState: DesktopLyricWindowState;
};

const DEFAULT_DESKTOP_LYRIC_SETTINGS: DesktopLyricPersistedSettings = {
  enabled: false,
  locked: false,
  clickThrough: true,
  autoShow: true,
  alwaysOnTop: true,
  secondaryEnabled: false,
  theme: 'system',
  opacity: 0.92,
  scale: 1,
  fontFamily:
    'SF Pro Display, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Inter, system-ui, sans-serif',
  inactiveFontSize: 26,
  activeFontSize: 40,
  secondaryFontSize: 18,
  lineGap: 14,
  width: 960,
  height: 220,
  secondaryMode: 'none',
  alignment: 'center',
  fontSize: 30,
  doubleLine: true,
  playedColor: '#31cfa1',
  unplayedColor: '#7a7a7a',
  strokeColor: '#f1b8b3',
  strokeEnabled: false,
  bold: false,
  windowState: {
    width: 960,
    height: 220,
  },
};

const settingsStore = new Conf<DesktopLyricPersistedSettings>({
  projectName: app.getName(),
  configName: 'desktop-lyric',
  defaults: DEFAULT_DESKTOP_LYRIC_SETTINGS,
});

const DESKTOP_LYRIC_MIN_WIDTH = 380;
const DESKTOP_LYRIC_MIN_HEIGHT = 140;
const DESKTOP_LYRIC_MAX_WIDTH = 1400;
const DESKTOP_LYRIC_MAX_HEIGHT = 360;
const DESKTOP_LYRIC_HORIZONTAL_PADDING = 88;
const DESKTOP_LYRIC_VERTICAL_PADDING = 52;
const DESKTOP_LYRIC_DOUBLE_LINE_WIDTH_SOFT_CAP = 11.5;
const DESKTOP_LYRIC_SINGLE_LINE_WIDTH_SOFT_CAP = 8.8;
const DESKTOP_LYRIC_DOUBLE_LINE_HEIGHT_FACTOR = 2.95;
const DESKTOP_LYRIC_SINGLE_LINE_HEIGHT_FACTOR = 1.72;
const DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS = 320;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const snapEven = (value: number) => {
  const rounded = Math.round(value / 2) * 2;
  return rounded % 2 === 0 ? rounded : rounded + 1;
};

const deriveFontSizeFromWindow = (
  width: number,
  height: number,
  doubleLine: boolean,
  lineGap: number,
) => {
  const availableWidth = Math.max(0, width - DESKTOP_LYRIC_HORIZONTAL_PADDING);
  const availableHeight = Math.max(0, height - DESKTOP_LYRIC_VERTICAL_PADDING);
  const effectiveGap = clamp(lineGap, 6, 20);
  const heightBased = doubleLine
    ? (availableHeight - effectiveGap) / DESKTOP_LYRIC_DOUBLE_LINE_HEIGHT_FACTOR
    : availableHeight / DESKTOP_LYRIC_SINGLE_LINE_HEIGHT_FACTOR;
  const widthBased = doubleLine
    ? availableWidth / DESKTOP_LYRIC_DOUBLE_LINE_WIDTH_SOFT_CAP
    : availableWidth / DESKTOP_LYRIC_SINGLE_LINE_WIDTH_SOFT_CAP;

  return clamp(snapEven(Math.min(heightBased, widthBased)), 12, 80);
};

const deriveMinimumWindowSizeFromFont = (
  fontSize: number,
  doubleLine: boolean,
  lineGap: number,
) => {
  const effectiveFontSize = clamp(snapEven(fontSize), 12, 80);
  const effectiveGap = clamp(lineGap, 6, 20);
  const minHeight = clamp(
    Math.ceil(
      DESKTOP_LYRIC_VERTICAL_PADDING +
        (doubleLine
          ? effectiveFontSize * DESKTOP_LYRIC_DOUBLE_LINE_HEIGHT_FACTOR + effectiveGap * 0.2
          : effectiveFontSize * DESKTOP_LYRIC_SINGLE_LINE_HEIGHT_FACTOR),
    ),
    DESKTOP_LYRIC_MIN_HEIGHT,
    DESKTOP_LYRIC_MAX_HEIGHT,
  );

  return {
    width: DESKTOP_LYRIC_MIN_WIDTH,
    height: minHeight,
  };
};

function getDesktopLyricSettings(): DesktopLyricSettings {
  const raw = settingsStore.store;
  return {
    enabled: Boolean(raw.enabled),
    locked: Boolean(raw.locked),
    clickThrough: Boolean(raw.clickThrough),
    autoShow: Boolean(raw.autoShow),
    alwaysOnTop: Boolean(raw.alwaysOnTop),
    secondaryEnabled: Boolean(raw.secondaryEnabled),
    theme: raw.theme ?? 'system',
    opacity: clamp(Number(raw.opacity) || DEFAULT_DESKTOP_LYRIC_SETTINGS.opacity, 0.25, 1),
    scale: clamp(Number(raw.scale) || DEFAULT_DESKTOP_LYRIC_SETTINGS.scale, 0.75, 1.5),
    fontFamily: String(raw.fontFamily || DEFAULT_DESKTOP_LYRIC_SETTINGS.fontFamily),
    inactiveFontSize: clamp(
      Math.round(Number(raw.inactiveFontSize) || DEFAULT_DESKTOP_LYRIC_SETTINGS.inactiveFontSize),
      18,
      56,
    ),
    activeFontSize: clamp(
      Math.round(Number(raw.activeFontSize) || DEFAULT_DESKTOP_LYRIC_SETTINGS.activeFontSize),
      24,
      76,
    ),
    secondaryFontSize: clamp(
      Math.round(Number(raw.secondaryFontSize) || DEFAULT_DESKTOP_LYRIC_SETTINGS.secondaryFontSize),
      12,
      36,
    ),
    lineGap: clamp(
      Math.round(Number(raw.lineGap) || DEFAULT_DESKTOP_LYRIC_SETTINGS.lineGap),
      4,
      28,
    ),
    width: clamp(
      Math.round(Number(raw.width) || DEFAULT_DESKTOP_LYRIC_SETTINGS.width),
      DESKTOP_LYRIC_MIN_WIDTH,
      DESKTOP_LYRIC_MAX_WIDTH,
    ),
    height: clamp(
      Math.round(Number(raw.height) || DEFAULT_DESKTOP_LYRIC_SETTINGS.height),
      DESKTOP_LYRIC_MIN_HEIGHT,
      DESKTOP_LYRIC_MAX_HEIGHT,
    ),
    secondaryMode: raw.secondaryMode ?? 'none',
    alignment: raw.alignment ?? 'center',
    fontSize: clamp(Math.round(Number(raw.fontSize) || 30), 12, 80),
    doubleLine: typeof raw.doubleLine === 'boolean' ? raw.doubleLine : true,
    playedColor: String(raw.playedColor || '#31cfa1'),
    unplayedColor: String(raw.unplayedColor || '#7a7a7a'),
    strokeColor: String(raw.strokeColor || '#f1b8b3'),
    strokeEnabled: Boolean(raw.strokeEnabled),
    bold: Boolean(raw.bold),
  };
}

const getWindowState = (): DesktopLyricWindowState => {
  const state = settingsStore.get('windowState', DEFAULT_DESKTOP_LYRIC_SETTINGS.windowState);
  return {
    width: clamp(
      Math.round(Number(state.width) || DEFAULT_DESKTOP_LYRIC_SETTINGS.width),
      DESKTOP_LYRIC_MIN_WIDTH,
      DESKTOP_LYRIC_MAX_WIDTH,
    ),
    height: clamp(
      Math.round(Number(state.height) || DEFAULT_DESKTOP_LYRIC_SETTINGS.height),
      DESKTOP_LYRIC_MIN_HEIGHT,
      DESKTOP_LYRIC_MAX_HEIGHT,
    ),
    ...(typeof state.x === 'number' ? { x: state.x } : {}),
    ...(typeof state.y === 'number' ? { y: state.y } : {}),
  };
};

const hasVisibleArea = (bounds: DesktopLyricWindowState) => {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const x = bounds.x ?? area.x;
    const y = bounds.y ?? area.y;
    return (
      x < area.x + area.width &&
      x + bounds.width > area.x &&
      y < area.y + area.height &&
      y + bounds.height > area.y
    );
  });
};

const getBestDisplayForBounds = (bounds: DesktopLyricWindowState) => {
  const displays = screen.getAllDisplays();
  const centerX = (bounds.x ?? 0) + bounds.width / 2;
  const centerY = (bounds.y ?? 0) + bounds.height / 2;
  const displayByPoint = screen.getDisplayNearestPoint({
    x: Math.round(centerX),
    y: Math.round(centerY),
  });
  if (displayByPoint) return displayByPoint;
  return displays[0] ?? screen.getPrimaryDisplay();
};

const constrainBoundsToDisplay = (bounds: DesktopLyricWindowState): DesktopLyricWindowState => {
  const display = getBestDisplayForBounds(bounds);
  const area = display.workArea;
  const width = clamp(
    bounds.width,
    DESKTOP_LYRIC_MIN_WIDTH,
    Math.min(DESKTOP_LYRIC_MAX_WIDTH, area.width),
  );
  const height = clamp(
    bounds.height,
    DESKTOP_LYRIC_MIN_HEIGHT,
    Math.min(DESKTOP_LYRIC_MAX_HEIGHT, area.height),
  );
  const rawX =
    typeof bounds.x === 'number' ? bounds.x : area.x + Math.round((area.width - width) / 2);
  const rawY =
    typeof bounds.y === 'number' ? bounds.y : area.y + Math.round(area.height * 0.72 - height / 2);

  return {
    width,
    height,
    x: clamp(rawX, area.x, area.x + area.width - width),
    y: clamp(rawY, area.y, area.y + area.height - height),
  };
};

const resolveInitialBounds = () => {
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const screenWidth = primaryArea.width;
  const screenHeight = primaryArea.height;
  const defaultWidth = Math.floor(screenWidth * 0.7);
  const defaultHeight = 200;

  const savedState = getWindowState();
  let x = savedState.x;
  let y = savedState.y;
  let width = savedState.width || defaultWidth;
  let height = savedState.height || defaultHeight;

  width = Math.min(width, screenWidth);
  height = Math.min(height, screenHeight);

  const isValidPosition =
    x !== undefined &&
    y !== undefined &&
    x >= primaryArea.x &&
    x <= primaryArea.x + screenWidth &&
    y >= primaryArea.y &&
    y <= primaryArea.y + screenHeight;

  if (!isValidPosition) {
    x = Math.floor(primaryArea.x + (screenWidth - width) / 2);
    y = Math.floor(primaryArea.y + screenHeight - height);
  }

  return constrainBoundsToDisplay({ width, height, x, y });
};

const getBackgroundColor = () => '#00000000';

let desktopLyricWindow: BrowserWindow | null = null;
// 独立的锁定状态（复刻 SPlayer，不与 clickThrough 耦合）
let desktopLyricIsLocked = false;
let desktopLyricResizeSession: DesktopLyricResizeSession | null = null;
let desktopLyricDragSession: DesktopLyricDragSession | null = null;
let desktopLyricClosingFromFailure = false;
let desktopLyricAppIsQuitting = false;
let desktopLyricDisplayMetricsTimer: NodeJS.Timeout | null = null;
let desktopLyricLockPhaseTimer: NodeJS.Timeout | null = null;
// 主窗口 move/resize 时的穿透防抖定时器
let desktopLyricForwardRestoreTimer: NodeJS.Timeout | null = null;

app.on('before-quit', () => {
  desktopLyricAppIsQuitting = true;
});

let snapshot: DesktopLyricSnapshot = {
  playback: null,
  lyrics: [],
  currentIndex: -1,
  settings: getDesktopLyricSettings(),
  lockPhase: 'idle',
};

const sendSnapshot = () => {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.isDestroyed()) return;
    win.webContents.send('desktop-lyric:snapshot', snapshot);
  });
};

const clearDesktopLyricLockPhaseTimer = () => {
  if (!desktopLyricLockPhaseTimer) return;
  clearTimeout(desktopLyricLockPhaseTimer);
  desktopLyricLockPhaseTimer = null;
};

const setDesktopLyricLockPhase = (phase: DesktopLyricLockPhase, withCooldown = false) => {
  clearDesktopLyricLockPhaseTimer();
  if (snapshot.lockPhase !== phase) {
    snapshot = {
      ...snapshot,
      lockPhase: phase,
    };
    sendSnapshot();
  }
  if (!withCooldown || phase === 'idle') return;
  desktopLyricLockPhaseTimer = setTimeout(() => {
    desktopLyricLockPhaseTimer = null;
    setDesktopLyricLockPhase('idle');
  }, DESKTOP_LYRIC_LOCK_PHASE_DURATION_MS);
};

// 保存窗口位置（复刻 SPlayer：只保存，不算字体，不广播）
const persistWindowBounds = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const bounds = desktopLyricWindow.getBounds();
  settingsStore.set('windowState', {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  });
};

const reconcileDesktopLyricBounds = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const bounds = desktopLyricWindow.getBounds();
  const nextBounds = constrainBoundsToDisplay(bounds);
  const changed =
    bounds.x !== nextBounds.x ||
    bounds.y !== nextBounds.y ||
    bounds.width !== nextBounds.width ||
    bounds.height !== nextBounds.height;
  if (!changed) return;
  desktopLyricWindow.setBounds({
    x: nextBounds.x ?? bounds.x,
    y: nextBounds.y ?? bounds.y,
    width: nextBounds.width,
    height: nextBounds.height,
  });
  persistWindowBounds();
};

const clearDesktopLyricDisplayMetricsTimer = () => {
  if (!desktopLyricDisplayMetricsTimer) return;
  clearTimeout(desktopLyricDisplayMetricsTimer);
  desktopLyricDisplayMetricsTimer = null;
};

const scheduleDesktopLyricBoundsReconcile = () => {
  clearDesktopLyricDisplayMetricsTimer();
  desktopLyricDisplayMetricsTimer = setTimeout(() => {
    desktopLyricDisplayMetricsTimer = null;
    reconcileDesktopLyricBounds();
  }, 120);
};

const syncWindowPresentation = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBackgroundColor(getBackgroundColor());
  desktopLyricWindow.setAlwaysOnTop(true, 'screen-saver');
  desktopLyricWindow.setSkipTaskbar(true);
};

// 主窗口 move/resize 时临时禁用 forward，防止锁定状态下穿透闪烁
const setDesktopLyricForward = (enableForward: boolean) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  if (!snapshot.settings.locked) return;
  desktopLyricWindow.setIgnoreMouseEvents(true, enableForward ? { forward: true } : undefined);
};

const onMainWindowMoveOrResize = () => {
  if (!snapshot.settings.locked) return;
  setDesktopLyricForward(false);
  if (desktopLyricForwardRestoreTimer) clearTimeout(desktopLyricForwardRestoreTimer);
  desktopLyricForwardRestoreTimer = setTimeout(() => {
    desktopLyricForwardRestoreTimer = null;
    setDesktopLyricForward(true);
  }, 300);
};

const onMainWindowMoveOrResizeEnd = () => {
  if (!snapshot.settings.locked) return;
  if (desktopLyricForwardRestoreTimer) clearTimeout(desktopLyricForwardRestoreTimer);
  desktopLyricForwardRestoreTimer = null;
  setDesktopLyricForward(true);
};

let desktopLyricMainWindowBound = false;

const bindMainWindowEvents = () => {
  if (desktopLyricMainWindowBound) return;
  const allWindows = BrowserWindow.getAllWindows();
  const mainWin = allWindows.find((w) => w !== desktopLyricWindow && !w.isDestroyed());
  if (!mainWin) return;
  desktopLyricMainWindowBound = true;
  mainWin.on('move', onMainWindowMoveOrResize);
  mainWin.on('resize', onMainWindowMoveOrResize);
  if (process.platform !== 'linux') {
    mainWin.on('moved', onMainWindowMoveOrResizeEnd);
    mainWin.on('resized', onMainWindowMoveOrResizeEnd);
  }
};

const unbindMainWindowEvents = () => {
  if (!desktopLyricMainWindowBound) return;
  desktopLyricMainWindowBound = false;
  const allWindows = BrowserWindow.getAllWindows();
  const mainWin = allWindows.find((w) => w !== desktopLyricWindow && !w.isDestroyed());
  if (!mainWin) return;
  mainWin.removeListener('move', onMainWindowMoveOrResize);
  mainWin.removeListener('resize', onMainWindowMoveOrResize);
  if (process.platform !== 'linux') {
    mainWin.removeListener('moved', onMainWindowMoveOrResizeEnd);
    mainWin.removeListener('resized', onMainWindowMoveOrResizeEnd);
  }
  if (desktopLyricForwardRestoreTimer) {
    clearTimeout(desktopLyricForwardRestoreTimer);
    desktopLyricForwardRestoreTimer = null;
  }
};

const destroyDesktopLyricWindowFromFailure = (reason: 'unresponsive' | 'render-process-gone') => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || desktopLyricClosingFromFailure)
    return;
  desktopLyricClosingFromFailure = true;
  console.error(`[DesktopLyric] Window destroyed due to ${reason}`);
  desktopLyricWindow.destroy();
};

const applyResizeBounds = (
  session: DesktopLyricResizeSession,
  screenX: number,
  screenY: number,
) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;

  const deltaX = screenX - session.startScreenX;
  const deltaY = screenY - session.startScreenY;
  const start = session.startBounds;

  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (session.direction.includes('left')) {
    const nextWidth = clamp(start.width - deltaX, DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MAX_WIDTH);
    x = start.x + (start.width - nextWidth);
    width = nextWidth;
  }

  if (session.direction.includes('right')) {
    width = clamp(start.width + deltaX, DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MAX_WIDTH);
  }

  if (session.direction.includes('top')) {
    const nextHeight = clamp(
      start.height - deltaY,
      DESKTOP_LYRIC_MIN_HEIGHT,
      DESKTOP_LYRIC_MAX_HEIGHT,
    );
    y = start.y + (start.height - nextHeight);
    height = nextHeight;
  }

  if (session.direction.includes('bottom')) {
    height = clamp(start.height + deltaY, DESKTOP_LYRIC_MIN_HEIGHT, DESKTOP_LYRIC_MAX_HEIGHT);
  }

  desktopLyricWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
};

const applyDragBounds = (session: DesktopLyricDragSession, screenX: number, screenY: number) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBounds({
    x: Math.round(screenX),
    y: Math.round(screenY),
    width: session.startBounds.width,
    height: session.startBounds.height,
  });
};

const startDesktopLyricResize = (
  direction: DesktopLyricResizeDirection,
  screenX: number,
  screenY: number,
) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || snapshot.settings.locked) return;
  desktopLyricResizeSession = {
    direction,
    startBounds: desktopLyricWindow.getBounds(),
    startScreenX: screenX,
    startScreenY: screenY,
  };
  desktopLyricWindow.setIgnoreMouseEvents(false);
};

const updateDesktopLyricResize = (screenX: number, screenY: number) => {
  if (!desktopLyricResizeSession) return;
  applyResizeBounds(desktopLyricResizeSession, screenX, screenY);
};

const endDesktopLyricResize = () => {
  if (!desktopLyricResizeSession) return;
  desktopLyricResizeSession = null;
  if (desktopLyricIsLocked) {
    desktopLyricWindow?.setIgnoreMouseEvents(true, { forward: true });
  } else if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.setIgnoreMouseEvents(false);
  }
};

const startDesktopLyricDrag = (screenX: number, screenY: number) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || snapshot.settings.locked) return;
  desktopLyricDragSession = {
    startBounds: desktopLyricWindow.getBounds(),
    startScreenX: screenX,
    startScreenY: screenY,
  };
  desktopLyricWindow.setIgnoreMouseEvents(false);
};

const updateDesktopLyricDrag = (screenX: number, screenY: number) => {
  if (!desktopLyricDragSession) return;
  applyDragBounds(desktopLyricDragSession, screenX, screenY);
};

const endDesktopLyricDrag = () => {
  if (!desktopLyricDragSession) return;
  desktopLyricDragSession = null;
  persistWindowBounds();
  if (desktopLyricIsLocked) {
    desktopLyricWindow?.setIgnoreMouseEvents(true, { forward: true });
  } else if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.setIgnoreMouseEvents(false);
  }
};

export const getDesktopLyricWindow = () => desktopLyricWindow;

export const ensureDesktopLyricWindow = async () => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) return desktopLyricWindow;

  const preload = join(__dirname, '../preload/index.js');
  const url = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = join(__dirname, '../../dist/index.html');
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

  desktopLyricWindow.once('ready-to-show', () => {
    syncWindowPresentation();
    // 根据锁定状态设置穿透
    if (desktopLyricIsLocked) {
      desktopLyricWindow?.setIgnoreMouseEvents(true, { forward: true });
    } else {
      desktopLyricWindow?.setIgnoreMouseEvents(false);
    }
    if (snapshot.settings.enabled) {
      desktopLyricWindow?.showInactive();
    }
    sendSnapshot();
    // 绑定主窗口事件，实现锁定状态下的穿透防抖
    bindMainWindowEvents();
  });

  // 强制重置缩放为 1.0，防止跟随主窗口缩放
  desktopLyricWindow.webContents.on('did-finish-load', () => {
    desktopLyricWindow?.webContents.setZoomFactor(1.0);
  });

  desktopLyricWindow.on('move', persistWindowBounds);
  desktopLyricWindow.on('resize', persistWindowBounds);
  desktopLyricWindow.on('hide', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    unbindMainWindowEvents();
    desktopLyricResizeSession = null;
    desktopLyricDragSession = null;
    setDesktopLyricLockPhase('idle');
  });
  desktopLyricWindow.on('closed', () => {
    clearDesktopLyricDisplayMetricsTimer();
    clearDesktopLyricLockPhaseTimer();
    unbindMainWindowEvents();
    desktopLyricResizeSession = null;
    desktopLyricDragSession = null;
    desktopLyricWindow = null;
    desktopLyricClosingFromFailure = false;

    const appIsQuitting = !app.isReady() || desktopLyricAppIsQuitting;
    snapshot = {
      ...snapshot,
      lockPhase: 'idle',
      settings: {
        ...snapshot.settings,
        enabled: appIsQuitting ? snapshot.settings.enabled : false,
      },
    };

    if (!appIsQuitting) {
      settingsStore.set('enabled', false);
      sendSnapshot();
    }
  });
  desktopLyricWindow.on('unresponsive', () => {
    destroyDesktopLyricWindowFromFailure('unresponsive');
  });
  desktopLyricWindow.webContents.on('render-process-gone', () => {
    destroyDesktopLyricWindowFromFailure('render-process-gone');
  });

  if (url) {
    await desktopLyricWindow.loadURL(`${url}#/desktop-lyric`);
  } else {
    await desktopLyricWindow.loadFile(indexHtml, { hash: '/desktop-lyric' });
  }

  return desktopLyricWindow;
};

export const showDesktopLyricWindow = async () => {
  const win = await ensureDesktopLyricWindow();
  if (win.isMinimized()) {
    if (typeof win.restore === 'function') win.restore();
    win.showInactive();
  }
  if (!win.isVisible()) win.showInactive();
  // 根据锁定状态设置穿透
  if (desktopLyricIsLocked) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
  }
  setTimeout(() => {
    syncWindowPresentation();
  }, 100);
  bindMainWindowEvents();
  sendSnapshot();
  return snapshot;
};

export const closeDesktopLyricWindow = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.close();
};

const sanitizeDesktopLyricSettings = (
  partial: Partial<DesktopLyricSettings>,
  current: DesktopLyricSettings,
): DesktopLyricSettings => {
  const mergedBase = {
    ...current,
    ...partial,
  };

  const minSize = deriveMinimumWindowSizeFromFont(
    Number(mergedBase.fontSize) || current.fontSize,
    Boolean(mergedBase.doubleLine),
    Number(mergedBase.lineGap) || current.lineGap,
  );

  const width = clamp(
    Math.round(Number(mergedBase.width) || current.width),
    minSize.width,
    DESKTOP_LYRIC_MAX_WIDTH,
  );
  const height = clamp(
    Math.round(Number(mergedBase.height) || current.height),
    minSize.height,
    DESKTOP_LYRIC_MAX_HEIGHT,
  );

  const fontSizeFromWindow = deriveFontSizeFromWindow(
    width,
    height,
    Boolean(mergedBase.doubleLine),
    Number(mergedBase.lineGap) || current.lineGap,
  );
  const requestedFontSize = Math.round(Number(mergedBase.fontSize) || current.fontSize);
  const fontSize = clamp(
    partial.fontSize === undefined ? fontSizeFromWindow : requestedFontSize,
    12,
    80,
  );

  return {
    enabled: Boolean(mergedBase.enabled),
    locked: Boolean(mergedBase.locked),
    clickThrough: Boolean(mergedBase.clickThrough),
    autoShow: Boolean(mergedBase.autoShow),
    alwaysOnTop: Boolean(mergedBase.alwaysOnTop),
    secondaryEnabled: Boolean(mergedBase.secondaryEnabled),
    theme: mergedBase.theme ?? current.theme,
    opacity: clamp(Number(mergedBase.opacity) || current.opacity, 0.25, 1),
    scale: clamp(Number(mergedBase.scale) || current.scale, 0.75, 1.5),
    fontFamily: String(mergedBase.fontFamily || current.fontFamily),
    inactiveFontSize: clamp(
      Math.round(Number(mergedBase.inactiveFontSize) || current.inactiveFontSize),
      18,
      56,
    ),
    activeFontSize: clamp(
      Math.round(Number(mergedBase.activeFontSize) || current.activeFontSize),
      24,
      76,
    ),
    secondaryFontSize: clamp(
      Math.round(Number(mergedBase.secondaryFontSize) || current.secondaryFontSize),
      12,
      36,
    ),
    lineGap: clamp(Math.round(Number(mergedBase.lineGap) || current.lineGap), 4, 28),
    width,
    height,
    secondaryMode: mergedBase.secondaryMode ?? current.secondaryMode,
    alignment: mergedBase.alignment ?? current.alignment,
    fontSize,
    doubleLine: Boolean(mergedBase.doubleLine),
    playedColor: String(mergedBase.playedColor || current.playedColor),
    unplayedColor: String(mergedBase.unplayedColor || current.unplayedColor),
    strokeColor: String(mergedBase.strokeColor || current.strokeColor),
    strokeEnabled: Boolean(mergedBase.strokeEnabled),
    bold: Boolean(mergedBase.bold),
  };
};

export const updateDesktopLyricSettings = async (partial: Partial<DesktopLyricSettings>) => {
  const current = snapshot.settings;
  const nextSettings = sanitizeDesktopLyricSettings(partial, current);

  snapshot = {
    ...snapshot,
    settings: nextSettings,
  };

  settingsStore.set({
    enabled: nextSettings.enabled,
    locked: nextSettings.locked,
    clickThrough: nextSettings.clickThrough,
    autoShow: nextSettings.autoShow,
    alwaysOnTop: nextSettings.alwaysOnTop,
    secondaryEnabled: nextSettings.secondaryEnabled,
    theme: nextSettings.theme,
    opacity: nextSettings.opacity,
    scale: nextSettings.scale,
    fontFamily: nextSettings.fontFamily,
    inactiveFontSize: nextSettings.inactiveFontSize,
    activeFontSize: nextSettings.activeFontSize,
    secondaryFontSize: nextSettings.secondaryFontSize,
    lineGap: nextSettings.lineGap,
    width: nextSettings.width,
    height: nextSettings.height,
    secondaryMode: nextSettings.secondaryMode,
    alignment: nextSettings.alignment,
    fontSize: nextSettings.fontSize,
    doubleLine: nextSettings.doubleLine,
    playedColor: nextSettings.playedColor,
    unplayedColor: nextSettings.unplayedColor,
    strokeColor: nextSettings.strokeColor,
    strokeEnabled: nextSettings.strokeEnabled,
    bold: nextSettings.bold,
  });

  const storedWindowState = getWindowState();
  const nextWindowState = constrainBoundsToDisplay({
    width: nextSettings.width,
    height: nextSettings.height,
    x: storedWindowState.x,
    y: storedWindowState.y,
  });
  settingsStore.set('windowState', nextWindowState);

  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.setMinimumSize(DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MIN_HEIGHT);
    desktopLyricWindow.setMaximumSize(DESKTOP_LYRIC_MAX_WIDTH, DESKTOP_LYRIC_MAX_HEIGHT);
    const bounds = desktopLyricWindow.getBounds();
    const shouldResize =
      bounds.width !== nextWindowState.width ||
      bounds.height !== nextWindowState.height ||
      bounds.x !== (nextWindowState.x ?? bounds.x) ||
      bounds.y !== (nextWindowState.y ?? bounds.y);
    if (shouldResize) {
      desktopLyricWindow.setBounds({
        x: nextWindowState.x ?? bounds.x,
        y: nextWindowState.y ?? bounds.y,
        width: nextWindowState.width,
        height: nextWindowState.height,
      });
    }
    syncWindowPresentation();

    if (nextSettings.enabled) {
      if (!desktopLyricWindow.isVisible()) desktopLyricWindow.showInactive();
    } else if (desktopLyricWindow.isVisible()) {
      desktopLyricWindow.hide();
    }
  } else if (nextSettings.enabled) {
    await showDesktopLyricWindow();
  }

  sendSnapshot();
  return snapshot;
};

export const toggleDesktopLyricLock = async () => {
  const nextLocked = !desktopLyricIsLocked;
  desktopLyricIsLocked = nextLocked;
  setDesktopLyricLockPhase(nextLocked ? 'locking' : 'unlocking', true);

  // 设置穿透
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    if (nextLocked) {
      desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      desktopLyricWindow.setIgnoreMouseEvents(false);
    }
  }

  // 只更新 snapshot 和持久化，不动窗口
  snapshot = { ...snapshot, settings: { ...snapshot.settings, locked: nextLocked } };
  settingsStore.set('locked', nextLocked);
  sendSnapshot();
  return snapshot;
};

export const getDesktopLyricSnapshot = () => snapshot;

export const registerDesktopLyricHandlers = () => {
  ipcMain.handle('desktop-lyric:get-snapshot', () => getDesktopLyricSnapshot());

  ipcMain.handle('desktop-lyric:show', async () => {
    const result = await updateDesktopLyricSettings({ enabled: true });
    await showDesktopLyricWindow();
    return result;
  });

  ipcMain.handle('desktop-lyric:hide', async () => {
    const result = await updateDesktopLyricSettings({ enabled: false });
    closeDesktopLyricWindow();
    return result;
  });

  ipcMain.handle('desktop-lyric:toggle-lock', async () => {
    return toggleDesktopLyricLock();
  });

  ipcMain.handle(
    'desktop-lyric:update-settings',
    async (_event, payload: Partial<DesktopLyricSettings>) => {
      return updateDesktopLyricSettings(payload ?? {});
    },
  );

  // SPlayer 风格：单向推送，不等待返回
  ipcMain.on('desktop-lyric:sync-snapshot', (_event, payload: DesktopLyricSnapshotPatch) => {
    if (!payload) return;
    // 只更新内存中的 snapshot，不走 updateDesktopLyricSettings
    if (payload.playback !== undefined) snapshot = { ...snapshot, playback: payload.playback };
    if (payload.lyrics !== undefined) snapshot = { ...snapshot, lyrics: payload.lyrics };
    if (payload.currentIndex !== undefined)
      snapshot = { ...snapshot, currentIndex: payload.currentIndex };
    if (payload.settings) {
      snapshot = { ...snapshot, settings: { ...snapshot.settings, ...payload.settings } };
    }
    sendSnapshot();
  });

  ipcMain.on('desktop-lyric:set-ignore-mouse-events', (_event, ignore: boolean) => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
    if (ignore) {
      desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      desktopLyricWindow.setIgnoreMouseEvents(false);
    }
  });

  // 复刻 SPlayer 的 desktop-lyric:set-option：只保存配置，不动窗口
  ipcMain.on(
    'desktop-lyric:set-option',
    (_event, option: Record<string, any>, callback?: boolean) => {
      if (!option) return;
      // 增量更新 snapshot 中的 settings
      snapshot = {
        ...snapshot,
        settings: { ...snapshot.settings, ...option },
      };
      // 持久化
      for (const [key, value] of Object.entries(option)) {
        settingsStore.set(key as any, value);
      }
      // 通知歌词窗口更新配置
      if (callback && desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
        sendSnapshot();
      }
    },
  );

  // SPlayer 风格的锁定/解锁（支持 temp 临时切换）
  ipcMain.on(
    'desktop-lyric:toggle-lock-sync',
    (_event, payload: { lock: boolean; temp?: boolean }) => {
      if (!payload) return;
      const { lock, temp } = payload;

      // 更新锁定状态（非临时时才更新）
      if (!temp) desktopLyricIsLocked = lock;

      // 设置穿透
      if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
        if (lock) {
          desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true });
        } else {
          desktopLyricWindow.setIgnoreMouseEvents(false);
        }
      }

      if (temp) return;
      // 只更新 snapshot 和持久化，不动窗口（复刻 SPlayer）
      snapshot = { ...snapshot, settings: { ...snapshot.settings, locked: lock } };
      settingsStore.set('locked', lock);
      sendSnapshot();
    },
  );

  ipcMain.on(
    'desktop-lyric:move',
    (_event, x: number, y: number, width: number, height: number) => {
      if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
      desktopLyricWindow.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
      settingsStore.set('windowState', { width, height, x, y });
    },
  );

  ipcMain.on('desktop-lyric:resize', (_event, width: number, height: number) => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
    const bounds = desktopLyricWindow.getBounds();
    desktopLyricWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.round(width),
      height: Math.round(height),
    });
    settingsStore.set('windowState', {
      ...settingsStore.get('windowState'),
      width,
      height,
    });
  });

  // 更新高度
  ipcMain.on('desktop-lyric:set-height', (_event, height: number) => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || !height) return;
    const bounds = desktopLyricWindow.getBounds();
    desktopLyricWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: Math.round(height),
    });
    settingsStore.set('windowState', { ...settingsStore.get('windowState'), height });
  });

  // 固定/恢复最大宽高（拖拽时防止 DPI 缩放 bug）
  ipcMain.on(
    'desktop-lyric:toggle-fixed-size',
    (_event, options: { width: number; height: number; fixed: boolean }) => {
      if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
      if (options.fixed) {
        desktopLyricWindow.setMaximumSize(options.width, options.height);
      } else {
        desktopLyricWindow.setMaximumSize(DESKTOP_LYRIC_MAX_WIDTH, DESKTOP_LYRIC_MAX_HEIGHT);
      }
    },
  );

  // 获取窗口位置
  ipcMain.handle('desktop-lyric:get-bounds', () => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return {};
    return desktopLyricWindow.getBounds();
  });

  // 获取多屏虚拟边界
  ipcMain.handle('desktop-lyric:get-virtual-screen-bounds', () => {
    const displays = screen.getAllDisplays();
    const bounds = displays.map((d) => d.workArea);
    return {
      minX: Math.min(...bounds.map((b) => b.x)),
      minY: Math.min(...bounds.map((b) => b.y)),
      maxX: Math.max(...bounds.map((b) => b.x + b.width)),
      maxY: Math.max(...bounds.map((b) => b.y + b.height)),
    };
  });

  ipcMain.on(
    'desktop-lyric:drag-start',
    (_event, payload: { screenX: number; screenY: number }) => {
      if (!payload) return;
      startDesktopLyricDrag(Number(payload.screenX) || 0, Number(payload.screenY) || 0);
    },
  );

  ipcMain.on(
    'desktop-lyric:drag-update',
    (_event, payload: { screenX: number; screenY: number }) => {
      if (!payload) return;
      updateDesktopLyricDrag(Number(payload.screenX) || 0, Number(payload.screenY) || 0);
    },
  );

  ipcMain.on('desktop-lyric:drag-end', () => {
    endDesktopLyricDrag();
  });

  ipcMain.on(
    'desktop-lyric:resize-start',
    (
      _event,
      payload: { direction: DesktopLyricResizeDirection; screenX: number; screenY: number },
    ) => {
      if (!payload) return;
      startDesktopLyricResize(
        payload.direction,
        Number(payload.screenX) || 0,
        Number(payload.screenY) || 0,
      );
    },
  );

  ipcMain.on(
    'desktop-lyric:resize-update',
    (_event, payload: { screenX: number; screenY: number }) => {
      if (!payload) return;
      updateDesktopLyricResize(Number(payload.screenX) || 0, Number(payload.screenY) || 0);
    },
  );

  ipcMain.on('desktop-lyric:resize-end', () => {
    endDesktopLyricResize();
  });

  ipcMain.on(
    'desktop-lyric:command',
    (
      _event,
      command:
        | 'togglePlayback'
        | 'previousTrack'
        | 'nextTrack'
        | 'toggleLyricsMode'
        | 'cycleLyricsMode',
    ) => {
      const focusedMainWindow = BrowserWindow.getAllWindows().find(
        (win) => win !== desktopLyricWindow && !win.isDestroyed(),
      );
      if (!focusedMainWindow) return;
      focusedMainWindow.webContents.send('shortcut-trigger', command);
    },
  );
};

nativeTheme.on('updated', () => {
  if (snapshot.settings.theme !== 'system') return;
  sendSnapshot();
});

let desktopLyricDisplayListenersInstalled = false;

const installDesktopLyricDisplayListeners = () => {
  if (desktopLyricDisplayListenersInstalled) return;
  desktopLyricDisplayListenersInstalled = true;
  screen.on('display-added', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-removed', scheduleDesktopLyricBoundsReconcile);
  screen.on('display-metrics-changed', scheduleDesktopLyricBoundsReconcile);
};

if (app.isReady()) {
  installDesktopLyricDisplayListeners();
} else {
  void app.whenReady().then(() => {
    installDesktopLyricDisplayListeners();
  });
}
