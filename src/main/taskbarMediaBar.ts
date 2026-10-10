import { BrowserWindow, Menu, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import { ipcRegistry } from './ipc/registry';
import { getMainWindow, showMainWindow } from './window';
import { getMainAppSettings, setMainAppSetting } from './storage/settings';
import { getNativeTaskbarLyric, type NativeTaskbarLyricSession } from './native/platform';
import {
  DEFAULT_TASKBAR_LYRIC_SETTINGS,
  normalizeTaskbarLyricSettings,
  resolveTaskbarLyricRegion,
  type NativeTaskbarLayout,
  type TaskbarLyricSettings,
} from '../shared/taskbar';
import log from './logger';
import { bindVisibleNowPlayingWindow } from './nowPlaying';

let win: BrowserWindow | null = null;
let creating: Promise<void> | null = null;
let session: NativeTaskbarLyricSession | null = null;
let enabled = false;
let quitting = false;
let layout: NativeTaskbarLayout | null = null;
let region: ReturnType<typeof resolveTaskbarLyricRegion> = null;
let contentWidth = 160;
let disposeSystem: (() => void) | null = null;
let settings = { ...DEFAULT_TASKBAR_LYRIC_SETTINGS };
let settingsLoaded = false;
const nativeWidth = () => (settings.position === 'left' ? 0 : settings.maxWidth);
function loadSettings(): void {
  if (settingsLoaded) return;
  settings = getMainAppSettings().taskbarLyric;
  settingsLoaded = true;
}
const usable = (value: BrowserWindow | null): value is BrowserWindow =>
  Boolean(value && !value.isDestroyed());
const state = () => ({
  enabled,
  visible: usable(win) && win.isVisible(),
  isDark: layout?.isDark ?? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  anchor: region?.anchor ?? 'left',
  maxWidth: region?.bounds.width ?? settings.maxWidth,
  settings,
});
function broadcastState(): void {
  const value = state();
  if (usable(win)) win.webContents.send('taskbar-player:state', value);
  const main = getMainWindow();
  if (usable(main)) main.webContents.send('taskbar-player:state', value);
}
function applyShape(): void {
  if (!usable(win) || !region) return;
  const width = Math.min(region.bounds.width, Math.max(160, Math.ceil(contentWidth)));
  win.setShape([
    {
      x: region.anchor === 'right' ? region.bounds.width - width : 0,
      y: 0,
      width,
      height: region.bounds.height,
    },
  ]);
}
function present(): void {
  if (!usable(win)) return;
  region = layout ? resolveTaskbarLyricRegion(layout, settings) : null;
  if (!enabled || quitting || !region || getMainWindow()?.isFullScreen()) {
    if (win.isVisible()) win.hide();
  } else {
    const before = win.getBounds();
    if (
      (['x', 'y', 'width', 'height'] as const).some((key) => before[key] !== region!.bounds[key])
    ) {
      win.setBounds(region.bounds, false);
    }
    applyShape();
    if (!win.isVisible()) win.showInactive();
  }
  broadcastState();
}
function release(): void {
  disposeSystem?.();
  disposeSystem = null;
  session?.stop();
  session = null;
  layout = null;
  region = null;
}
async function createBar(): Promise<void> {
  const native = getNativeTaskbarLyric();
  if (!native) throw new Error('任务栏原生组件不可用，请重新构建 echo-platform-adaptor');
  if (!enabled || quitting) return;
  // 嵌入后 Chromium 的透明合成表面只能可靠缩小；初始大小覆盖可用的整个主屏。
  const display = screen.getPrimaryDisplay();
  const candidate = new BrowserWindow({
    width: Math.max(display.bounds.width, 800),
    height: 200,
    minWidth: 0,
    minHeight: 0,
    title: 'EchoMusic 任务栏歌词',
    type: 'toolbar',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
      zoomFactor: 1,
      disableDialogs: true,
    },
  });
  win = candidate;
  let recoverOnClose = true;
  bindVisibleNowPlayingWindow(candidate);
  contentWidth = settings.maxWidth;
  candidate.on('closed', () => {
    if (win !== candidate) return;
    release();
    win = null;
    broadcastState();
    // Explorer 销毁父窗口时可能一并关闭子窗口；重新建立任务栏嵌入。
    if (recoverOnClose && enabled && !quitting && !creating) {
      void setTaskbarPlayerEnabled(true).catch((error) =>
        log.error('[TaskbarLyric] Recovery failed:', error),
      );
    }
  });
  candidate.on('page-title-updated', (event) => event.preventDefault());
  candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  candidate.webContents.on('will-navigate', (event) => event.preventDefault());
  candidate.webContents.on('render-process-gone', (_event, details) => {
    recoverOnClose = false;
    log.error('[TaskbarLyric] Renderer exited:', details);
    if (usable(candidate)) candidate.destroy();
  });
  candidate.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      {
        label: '打开 EchoMusic',
        click: () => {
          void showMainWindow();
        },
      },
      { type: 'separator' },
      {
        label: '关闭任务栏歌词',
        click: () => {
          void setTaskbarPlayerEnabled(false);
        },
      },
    ]).popup({ window: candidate });
  });
  try {
    const dev = process.env.VITE_DEV_SERVER_URL;
    if (dev) await candidate.loadURL(new URL('taskbar-player.html', dev).href);
    else await candidate.loadFile(join(__dirname, '../../dist/taskbar-player.html'));
    if (win !== candidate || !usable(candidate) || !enabled || quitting) return;
    const handle = candidate.getNativeWindowHandle();
    const hwnd =
      handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    session = new native.TaskbarLyricSession(hwnd, nativeWidth(), (value) => {
      if (win !== candidate || !usable(candidate) || !enabled || quitting) return;
      layout = value;
      present();
    });
    const refresh = () => session?.update(nativeWidth());
    const main = getMainWindow();
    screen.on('display-metrics-changed', refresh);
    screen.on('display-added', refresh);
    screen.on('display-removed', refresh);
    nativeTheme.on('updated', refresh);
    main?.on('enter-full-screen', present);
    main?.on('leave-full-screen', refresh);
    disposeSystem = () => {
      screen.off('display-metrics-changed', refresh);
      screen.off('display-added', refresh);
      screen.off('display-removed', refresh);
      nativeTheme.off('updated', refresh);
      main?.off('enter-full-screen', present);
      main?.off('leave-full-screen', refresh);
    };
    broadcastState();
  } catch (error) {
    if (usable(candidate)) candidate.destroy();
    throw error;
  }
}
export async function setTaskbarPlayerEnabled(value: boolean): Promise<ReturnType<typeof state>> {
  if (process.platform !== 'win32') throw new Error('任务栏歌词仅支持 Windows');
  loadSettings();
  enabled = value;
  if (!enabled) {
    if (usable(win)) win.destroy();
    else release();
  }
  try {
    while (enabled && !quitting && (creating || !usable(win))) {
      if (!creating)
        creating = createBar().finally(() => {
          creating = null;
        });
      await creating;
    }
  } catch (error) {
    enabled = false;
    setMainAppSetting('taskbarPlayerEnabled', false);
    broadcastState();
    throw error;
  }
  if (!quitting) setMainAppSetting('taskbarPlayerEnabled', enabled);
  present();
  broadcastState();
  return state();
}
function isSender(senderId: number): boolean {
  const main = getMainWindow();
  return (
    (usable(main) && senderId === main.webContents.id) ||
    (usable(win) && senderId === win.webContents.id)
  );
}
export function registerTaskbarPlayerHandlers(): void {
  ipcRegistry.registerHandler('taskbar-player:set-enabled', (event, value: boolean) => {
    if (!isSender(event.sender.id)) throw new Error('Invalid taskbar sender');
    if (typeof value !== 'boolean') throw new Error('Invalid taskbar state');
    return setTaskbarPlayerEnabled(value);
  });
  ipcRegistry.registerHandler('taskbar-player:get-state', () => {
    loadSettings();
    return state();
  });
  ipcRegistry.registerHandler(
    'taskbar-player:set-settings',
    (event, value: Partial<TaskbarLyricSettings>) => {
      if (!isSender(event.sender.id)) throw new Error('Invalid taskbar sender');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid taskbar settings');
      loadSettings();
      settings = normalizeTaskbarLyricSettings({ ...settings, ...value });
      setMainAppSetting('taskbarLyric', settings);
      session?.update(nativeWidth());
      present();
      return state();
    },
  );
  ipcRegistry.registerListener('taskbar-player:content-width', (event, width: number) => {
    if (
      !usable(win) ||
      event.sender.id !== win.webContents.id ||
      !Number.isFinite(width) ||
      width <= 0
    )
      return;
    contentWidth = Math.min(settings.maxWidth, width);
    applyShape();
  });
  ipcRegistry.registerListener('taskbar-player:show-main', (event) => {
    if (usable(win) && event.sender.id === win.webContents.id) showMainWindow();
  });
}
export function restoreTaskbarPlayer(): void {
  quitting = false;
  if (process.platform === 'win32' && getMainAppSettings().taskbarPlayerEnabled) {
    void setTaskbarPlayerEnabled(true).catch((error) =>
      log.error('[TaskbarLyric] Restore failed:', error),
    );
  }
}
export function cleanupTaskbarPlayer(): void {
  quitting = true;
  release();
  if (usable(win)) win.destroy();
}
