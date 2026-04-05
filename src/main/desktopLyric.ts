import { BrowserWindow, app, ipcMain, nativeTheme, screen } from 'electron';
import Conf from 'conf';
import { join } from 'path';
import type {
  DesktopLyricLockPhase,
  DesktopLyricPointerState,
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
  unplayedColor: '#b9b9b9',
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

const DESKTOP_LYRIC_MIN_WIDTH = 320;
const DESKTOP_LYRIC_MIN_HEIGHT = 100;
const DESKTOP_LYRIC_MAX_WIDTH = 1400;
const DESKTOP_LYRIC_MAX_HEIGHT = 300;
const DESKTOP_LYRIC_HORIZONTAL_PADDING = 88;
const DESKTOP_LYRIC_VERTICAL_PADDING = 52;
const DESKTOP_LYRIC_DOUBLE_LINE_WIDTH_SOFT_CAP = 11.5;
const DESKTOP_LYRIC_SINGLE_LINE_WIDTH_SOFT_CAP = 8.8;
const DESKTOP_LYRIC_DOUBLE_LINE_HEIGHT_FACTOR = 2.95;
const DESKTOP_LYRIC_SINGLE_LINE_HEIGHT_FACTOR = 1.72;

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
    unplayedColor: String(raw.unplayedColor || '#b9b9b9'),
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

const resolveInitialBounds = () => {
  const state = getWindowState();
  if (hasVisibleArea(state)) return state;

  const primaryDisplay = screen.getPrimaryDisplay().workArea;
  return {
    width: state.width,
    height: state.height,
    x: Math.round(primaryDisplay.x + (primaryDisplay.width - state.width) / 2),
    y: Math.round(primaryDisplay.y + primaryDisplay.height * 0.72 - state.height / 2),
  };
};

const getEffectiveTheme = (theme: DesktopLyricSettings['theme']) => {
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return theme;
};

const getBackgroundColor = (_theme: DesktopLyricSettings['theme']) => {
  return '#00000000';
};

let desktopLyricWindow: BrowserWindow | null = null;
let desktopLyricHovering = false;
let desktopLyricPointerState: DesktopLyricPointerState = {
  insideWindow: false,
  insideUnlockHotzone: false,
  insideToolbarHotzone: false,
};
let desktopLyricHoverPollTimer: NodeJS.Timeout | null = null;
let desktopLyricUnlockHotzoneBlockedUntil = 0;
let desktopLyricUnlockHotzoneCooldownTimer: NodeJS.Timeout | null = null;
let desktopLyricLockPhaseTimer: NodeJS.Timeout | null = null;
let desktopLyricResizeSession: DesktopLyricResizeSession | null = null;
let desktopLyricClosingFromFailure = false;
let desktopLyricAppIsQuitting = false;

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

const persistWindowBounds = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const bounds = desktopLyricWindow.getBounds();
  const nextFontSize = deriveFontSizeFromWindow(
    bounds.width,
    bounds.height,
    snapshot.settings.doubleLine,
    snapshot.settings.lineGap,
  );

  settingsStore.set('windowState', {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  });

  if (snapshot.settings.width !== bounds.width || snapshot.settings.height !== bounds.height) {
    snapshot = {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        width: bounds.width,
        height: bounds.height,
        fontSize: nextFontSize,
      },
    };
    settingsStore.set('width', bounds.width);
    settingsStore.set('height', bounds.height);
    settingsStore.set('fontSize', nextFontSize);
    sendSnapshot();
  } else if (snapshot.settings.fontSize !== nextFontSize) {
    snapshot = {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        fontSize: nextFontSize,
      },
    };
    settingsStore.set('fontSize', nextFontSize);
    sendSnapshot();
  }
};

const sendSnapshot = () => {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.isDestroyed()) return;
    win.webContents.send('desktop-lyric:snapshot', snapshot);
  });
};

const sendPointerState = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.webContents.send('desktop-lyric:pointer-state', desktopLyricPointerState);
};

const getCursorRelativeState = (): DesktopLyricPointerState => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || !desktopLyricWindow.isVisible()) {
    return {
      insideWindow: false,
      insideUnlockHotzone: false,
      insideToolbarHotzone: false,
    };
  }

  const point = screen.getCursorScreenPoint();
  const bounds = desktopLyricWindow.getBounds();
  const insideWindow =
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height;

  const unlockHotzoneWidth = 70;
  const unlockHotzoneHeight = 28;
  const unlockHotzoneTop = 8;
  const unlockHotzoneLeft = bounds.x + Math.round((bounds.width - unlockHotzoneWidth) / 2);
  const insideUnlockHotzone =
    insideWindow &&
    point.x >= unlockHotzoneLeft &&
    point.x <= unlockHotzoneLeft + unlockHotzoneWidth &&
    point.y >= bounds.y + unlockHotzoneTop &&
    point.y <= bounds.y + unlockHotzoneTop + unlockHotzoneHeight;

  // toolbar: 3 控制按钮 + 分割线 + 2 文本按钮 + 2 控制按钮，保守放宽热区
  const toolbarHotzoneWidth = 428;
  const toolbarHotzoneHeight = 28;
  const toolbarHotzoneTop = 8;
  const toolbarHotzoneLeft = bounds.x + Math.round((bounds.width - toolbarHotzoneWidth) / 2);
  const insideToolbarHotzone =
    insideWindow &&
    point.x >= toolbarHotzoneLeft &&
    point.x <= toolbarHotzoneLeft + toolbarHotzoneWidth &&
    point.y >= bounds.y + toolbarHotzoneTop &&
    point.y <= bounds.y + toolbarHotzoneTop + toolbarHotzoneHeight;

  return {
    insideWindow,
    insideUnlockHotzone,
    insideToolbarHotzone,
  };
};

const setDesktopLyricHovering = (hovering: boolean) => {
  const nextHovering = Boolean(hovering);
  if (desktopLyricHovering === nextHovering) return;
  desktopLyricHovering = nextHovering;
};

const setDesktopLyricPointerState = (nextState: DesktopLyricPointerState) => {
  const changed =
    desktopLyricPointerState.insideWindow !== nextState.insideWindow ||
    desktopLyricPointerState.insideUnlockHotzone !== nextState.insideUnlockHotzone;

  if (!changed) return;

  desktopLyricPointerState = nextState;
  sendPointerState();
  applyWindowInteractivity();
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

const startDesktopLyricResize = (
  direction: DesktopLyricResizeDirection,
  screenX: number,
  screenY: number,
) => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
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
  applyWindowInteractivity();
};

const clearDesktopLyricLockPhaseTimer = () => {
  if (desktopLyricLockPhaseTimer) {
    clearTimeout(desktopLyricLockPhaseTimer);
    desktopLyricLockPhaseTimer = null;
  }
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
  }, 320);
};

const clearUnlockHotzoneCooldownTimer = () => {
  if (desktopLyricUnlockHotzoneCooldownTimer) {
    clearTimeout(desktopLyricUnlockHotzoneCooldownTimer);
    desktopLyricUnlockHotzoneCooldownTimer = null;
  }
};

const scheduleUnlockHotzoneRefresh = () => {
  clearUnlockHotzoneCooldownTimer();
  const delay = desktopLyricUnlockHotzoneBlockedUntil - Date.now();
  if (delay <= 0) {
    applyWindowInteractivity();
    return;
  }

  desktopLyricUnlockHotzoneCooldownTimer = setTimeout(() => {
    desktopLyricUnlockHotzoneCooldownTimer = null;
    applyWindowInteractivity();
  }, delay);
};

const stopDesktopLyricHoverTracking = () => {
  if (desktopLyricHoverPollTimer) {
    clearInterval(desktopLyricHoverPollTimer);
    desktopLyricHoverPollTimer = null;
  }
};

const syncDesktopLyricHoverTracking = () => {
  const shouldTrack = Boolean(
    desktopLyricWindow &&
    !desktopLyricWindow.isDestroyed() &&
    desktopLyricWindow.isVisible() &&
    snapshot.settings.enabled,
  );

  if (!shouldTrack) {
    stopDesktopLyricHoverTracking();
    clearUnlockHotzoneCooldownTimer();
    clearDesktopLyricLockPhaseTimer();
    setDesktopLyricHovering(false);
    setDesktopLyricPointerState({ insideWindow: false, insideUnlockHotzone: false, insideToolbarHotzone: false });
    return;
  }

  if (!desktopLyricHoverPollTimer) {
    desktopLyricHoverPollTimer = setInterval(() => {
      setDesktopLyricPointerState(getCursorRelativeState());
    }, 80);
  }

  setDesktopLyricPointerState(getCursorRelativeState());
};

const applyWindowInteractivity = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const { locked, alwaysOnTop } = snapshot.settings;
  const unlockHotzoneReady = Date.now() >= desktopLyricUnlockHotzoneBlockedUntil;
  const shouldIgnoreMouse = locked
    ? !unlockHotzoneReady || !desktopLyricPointerState.insideUnlockHotzone
    : !desktopLyricPointerState.insideWindow;
  desktopLyricWindow.setIgnoreMouseEvents(shouldIgnoreMouse, { forward: true });
  desktopLyricWindow.setFocusable(false);
  if (desktopLyricWindow.isFocused()) {
    desktopLyricWindow.blur();
  }
  desktopLyricWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver', 1);
  desktopLyricWindow.setVisibleOnAllWorkspaces(alwaysOnTop, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  desktopLyricWindow.setSkipTaskbar(true);
  syncDesktopLyricHoverTracking();
};

const syncWindowAppearance = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.setBackgroundColor(getBackgroundColor(snapshot.settings.theme));
  applyWindowInteractivity();
};

const destroyDesktopLyricWindowFromFailure = (reason: 'unresponsive' | 'render-process-gone') => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed() || desktopLyricClosingFromFailure) return;
  desktopLyricClosingFromFailure = true;
  console.error(`[DesktopLyric] Window destroyed due to ${reason}`);
  desktopLyricWindow.destroy();
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
    backgroundColor: getBackgroundColor(snapshot.settings.theme),
    show: false,
    resizable: true,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: 'panel',
    fullscreenable: false,
    roundedCorners: false,
    focusable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
    },
  });

  desktopLyricWindow.once('ready-to-show', () => {
    if (snapshot.settings.enabled) {
      desktopLyricWindow?.showInactive();
    }
    syncWindowAppearance();
    sendSnapshot();
  });

  desktopLyricWindow.on('move', () => {
    persistWindowBounds();
    syncDesktopLyricHoverTracking();
  });
  desktopLyricWindow.on('resize', () => {
    persistWindowBounds();
    syncDesktopLyricHoverTracking();
  });
  desktopLyricWindow.on('show', () => {
    desktopLyricWindow?.blur();
    syncDesktopLyricHoverTracking();
  });
  desktopLyricWindow.on('focus', () => {
    desktopLyricWindow?.blur();
  });
  desktopLyricWindow.on('unresponsive', () => {
    destroyDesktopLyricWindowFromFailure('unresponsive');
  });
  desktopLyricWindow.webContents.on('render-process-gone', () => {
    destroyDesktopLyricWindowFromFailure('render-process-gone');
  });
  desktopLyricWindow.on('hide', () => {
    stopDesktopLyricHoverTracking();
    clearUnlockHotzoneCooldownTimer();
    clearDesktopLyricLockPhaseTimer();
    setDesktopLyricHovering(false);
    setDesktopLyricPointerState({ insideWindow: false, insideUnlockHotzone: false, insideToolbarHotzone: false });
    setDesktopLyricLockPhase('idle');
  });
  desktopLyricWindow.on('closed', () => {
    stopDesktopLyricHoverTracking();
    clearUnlockHotzoneCooldownTimer();
    clearDesktopLyricLockPhaseTimer();
    desktopLyricResizeSession = null;
    desktopLyricHovering = false;
    desktopLyricPointerState = { insideWindow: false, insideUnlockHotzone: false, insideToolbarHotzone: false };
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

  if (url) {
    await desktopLyricWindow.loadURL(`${url}#/desktop-lyric`);
  } else {
    await desktopLyricWindow.loadFile(indexHtml, { hash: '/desktop-lyric' });
  }

  return desktopLyricWindow;
};

export const showDesktopLyricWindow = async () => {
  const win = await ensureDesktopLyricWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  syncWindowAppearance();
  sendSnapshot();
  return win;
};

export const hideDesktopLyricWindow = () => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  desktopLyricWindow.hide();
};

export const updateDesktopLyricSettings = async (partial: Partial<DesktopLyricSettings>) => {
  const wasLocked = snapshot.settings.locked;
  const requestedWidth = clamp(
    Math.round(Number(partial.width ?? snapshot.settings.width)),
    DESKTOP_LYRIC_MIN_WIDTH,
    DESKTOP_LYRIC_MAX_WIDTH,
  );
  const requestedHeight = clamp(
    Math.round(Number(partial.height ?? snapshot.settings.height)),
    DESKTOP_LYRIC_MIN_HEIGHT,
    DESKTOP_LYRIC_MAX_HEIGHT,
  );
  const mergedLineGap = clamp(
    Math.round(Number(partial.lineGap ?? snapshot.settings.lineGap)),
    4,
    28,
  );
  const mergedDoubleLine = Boolean(partial.doubleLine ?? snapshot.settings.doubleLine);
  const mergedFontSize =
    partial.fontSize == null
      ? deriveFontSizeFromWindow(requestedWidth, requestedHeight, mergedDoubleLine, mergedLineGap)
      : clamp(Math.round(Number(partial.fontSize)), 12, 80);
  const minimumWindowSize = deriveMinimumWindowSizeFromFont(
    mergedFontSize,
    mergedDoubleLine,
    mergedLineGap,
  );
  const mergedWidth = clamp(
    Math.max(requestedWidth, partial.fontSize == null ? requestedWidth : minimumWindowSize.width),
    DESKTOP_LYRIC_MIN_WIDTH,
    DESKTOP_LYRIC_MAX_WIDTH,
  );
  const mergedHeight = clamp(
    Math.max(
      requestedHeight,
      partial.fontSize == null ? requestedHeight : minimumWindowSize.height,
    ),
    DESKTOP_LYRIC_MIN_HEIGHT,
    DESKTOP_LYRIC_MAX_HEIGHT,
  );

  const merged: DesktopLyricSettings = {
    ...snapshot.settings,
    ...partial,
    clickThrough: Boolean(partial.locked ?? snapshot.settings.locked),
    opacity: clamp(Number(partial.opacity ?? snapshot.settings.opacity), 0.25, 1),
    scale: clamp(Number(partial.scale ?? snapshot.settings.scale), 0.75, 1.5),
    inactiveFontSize: clamp(
      Math.round(Number(partial.inactiveFontSize ?? snapshot.settings.inactiveFontSize)),
      18,
      56,
    ),
    activeFontSize: clamp(
      Math.round(Number(partial.activeFontSize ?? snapshot.settings.activeFontSize)),
      24,
      76,
    ),
    secondaryFontSize: clamp(
      Math.round(Number(partial.secondaryFontSize ?? snapshot.settings.secondaryFontSize)),
      12,
      36,
    ),
    lineGap: mergedLineGap,
    width: mergedWidth,
    height: mergedHeight,
    fontFamily: String(partial.fontFamily ?? snapshot.settings.fontFamily),
    alignment: partial.alignment ?? snapshot.settings.alignment,
    fontSize: mergedFontSize,
    doubleLine: mergedDoubleLine,
    playedColor: String(partial.playedColor ?? snapshot.settings.playedColor),
    unplayedColor: String(partial.unplayedColor ?? snapshot.settings.unplayedColor),
    strokeColor: String(partial.strokeColor ?? snapshot.settings.strokeColor),
    strokeEnabled: Boolean(partial.strokeEnabled ?? snapshot.settings.strokeEnabled),
    bold: Boolean(partial.bold ?? snapshot.settings.bold),
  };

  snapshot = {
    ...snapshot,
    settings: merged,
  };

  if (!wasLocked && merged.locked) {
    desktopLyricUnlockHotzoneBlockedUntil = Date.now() + 320;
    scheduleUnlockHotzoneRefresh();
  } else if (!merged.locked) {
    desktopLyricUnlockHotzoneBlockedUntil = 0;
    clearUnlockHotzoneCooldownTimer();
  }

  for (const [key, value] of Object.entries(merged)) {
    settingsStore.set(key as keyof DesktopLyricPersistedSettings, value as never);
  }

  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    const bounds = desktopLyricWindow.getBounds();
    if (bounds.width !== merged.width || bounds.height !== merged.height) {
      desktopLyricWindow.setBounds({ ...bounds, width: merged.width, height: merged.height });
    }
    syncWindowAppearance();
  }

  if (merged.enabled) {
    await showDesktopLyricWindow();
  } else {
    hideDesktopLyricWindow();
  }

  sendSnapshot();
  return snapshot;
};

export const updateDesktopLyricSnapshot = async (partial: DesktopLyricSnapshotPatch) => {
  if (partial.settings) {
    await updateDesktopLyricSettings(partial.settings);
  }

  snapshot = {
    ...snapshot,
    ...partial,
    settings: snapshot.settings,
  };

  const shouldAutoShow =
    snapshot.settings.enabled &&
    snapshot.settings.autoShow &&
    Boolean(snapshot.playback?.trackId) &&
    Boolean(snapshot.playback?.isPlaying);

  if (shouldAutoShow) {
    await showDesktopLyricWindow();
  } else if (!snapshot.settings.enabled) {
    hideDesktopLyricWindow();
  }

  sendSnapshot();
  return snapshot;
};

export const toggleDesktopLyricLock = async () => {
  if (snapshot.lockPhase !== 'idle') return snapshot;

  const nextLocked = !snapshot.settings.locked;
  setDesktopLyricLockPhase(nextLocked ? 'locking' : 'unlocking', true);
  return updateDesktopLyricSettings({
    locked: nextLocked,
    clickThrough: nextLocked,
  });
};

export const getDesktopLyricSnapshot = () => snapshot;

export const registerDesktopLyricHandlers = () => {
  ipcMain.handle('desktop-lyric:get-snapshot', () => snapshot);

  ipcMain.handle('desktop-lyric:show', async () => {
    snapshot.settings.enabled = true;
    settingsStore.set('enabled', true);
    await showDesktopLyricWindow();
    sendSnapshot();
    return snapshot;
  });

  ipcMain.handle('desktop-lyric:hide', () => {
    snapshot.settings.enabled = false;
    settingsStore.set('enabled', false);
    hideDesktopLyricWindow();
    sendSnapshot();
    return snapshot;
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

  ipcMain.handle(
    'desktop-lyric:sync-snapshot',
    async (_event, payload: DesktopLyricSnapshotPatch) => {
      return updateDesktopLyricSnapshot(payload ?? {});
    },
  );

  ipcMain.on('desktop-lyric:drag-mode', (_event, enabled: boolean) => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
    if (enabled) {
      desktopLyricWindow.setIgnoreMouseEvents(false);
      return;
    }
    applyWindowInteractivity();
  });

  ipcMain.on('desktop-lyric:hover', (_event, hovering: boolean) => {
    setDesktopLyricHovering(hovering);
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
    (_event, command: 'togglePlayback' | 'previousTrack' | 'nextTrack' | 'toggleLyricsMode') => {
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
  syncWindowAppearance();
  sendSnapshot();
});
