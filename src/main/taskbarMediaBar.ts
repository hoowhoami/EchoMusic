import { BrowserWindow, Menu, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import { ipcRegistry } from './ipc/registry';
import { getMainWindow, showMainWindow } from './window';
import { getMainAppSettings, setMainAppSetting } from './storage/settings';
import { bindWindowBoundsPersistenceEvents } from './windowBoundsPersistence';
import { calculateTaskbarDock, type TaskbarDockPlacement } from './taskbarDock';
import {
  getTaskbarShellLayout,
  refreshTaskbarShellLayout,
  setTaskbarProbeWindow,
} from './taskbarShell';
import log from './logger';

let win: BrowserWindow | null = null;
let creating: Promise<void> | null = null;
let enabled = false;
let detached = false;
let quitting = false;
let ready = false;
let placement: TaskbarDockPlacement | null = null;
let disposeSystem: (() => void) | null = null;
const usable = (value: BrowserWindow | null): value is BrowserWindow =>
  Boolean(value && !value.isDestroyed());
const display = () => {
  const main = getMainWindow();
  return usable(main) ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
};
const resolvePlacement = () =>
  calculateTaskbarDock(display(), placement?.edge, getTaskbarShellLayout(display().id));

function present(force = false): void {
  if (!usable(win) || !ready) return;
  const shell = getTaskbarShellLayout(display().id);
  if (
    !enabled ||
    quitting ||
    (!detached && (shell?.foregroundFullscreen || getMainWindow()?.isFullScreen()))
  ) {
    win.hide();
    return;
  }
  if (!detached) {
    placement = resolvePlacement();
    const before = win.getBounds();
    if (
      (['x', 'y', 'width', 'height'] as const).some(
        (key) => Math.abs(before[key] - placement!.bounds[key]) > 1,
      )
    ) {
      win.setBounds(placement.bounds, false);
    }
  }
  const level = !detached && placement?.mode === 'taskbar' ? 'pop-up-menu' : 'floating';
  win.setAlwaysOnTop(true, level);
  if (
    force ||
    !win.isVisible() ||
    (!detached && (shell?.playerVisible === false || shell?.shellAbovePlayer === true))
  ) {
    win.showInactive();
    win.moveTop();
    win.webContents.invalidate();
  }
  win.webContents.send('taskbar-player:state', {
    detached,
    mode: detached ? 'detached' : placement?.mode,
    // Windows can use a dark taskbar with light apps (or the reverse).
    isDark: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  });
}

async function refresh(): Promise<void> {
  if (!enabled || quitting) return;
  await refreshTaskbarShellLayout();
  if (!quitting) present();
}

function installSystemListeners(): void {
  if (disposeSystem) return;
  const tick = () => {
    void refresh();
  };
  const recoverDisplay = () => {
    if (detached && usable(win)) {
      const b = win.getBounds();
      if (
        !screen
          .getAllDisplays()
          .some(
            ({ workArea: a }) =>
              Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 80 &&
              Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 24,
          )
      )
        detached = false;
    }
    tick();
  };
  const theme = () => present();
  const main = getMainWindow();
  const poll = setInterval(tick, 2000);
  poll.unref();
  screen.on('display-metrics-changed', recoverDisplay);
  screen.on('display-added', recoverDisplay);
  screen.on('display-removed', recoverDisplay);
  nativeTheme.on('updated', theme);
  main?.on('enter-full-screen', theme);
  main?.on('leave-full-screen', tick);
  disposeSystem = () => {
    clearInterval(poll);
    screen.off('display-metrics-changed', recoverDisplay);
    screen.off('display-added', recoverDisplay);
    screen.off('display-removed', recoverDisplay);
    nativeTheme.off('updated', theme);
    main?.off('enter-full-screen', theme);
    main?.off('leave-full-screen', tick);
    disposeSystem = null;
  };
}

async function createBar(): Promise<void> {
  await refreshTaskbarShellLayout();
  if (!enabled || quitting || usable(win)) return;
  placement = resolvePlacement();
  const candidate = new BrowserWindow({
    ...placement.bounds,
    title: 'EchoMusic 任务栏快捷播控',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win = candidate;
  ready = false;
  setTaskbarProbeWindow(candidate.getNativeWindowHandle());
  // Reuse upstream's manual-move gate. Async setBounds events cannot detach the bar.
  bindWindowBoundsPersistenceEvents(candidate, () => {
    const b = candidate.getBounds(),
      dock = resolvePlacement().bounds;
    detached = Math.abs(b.x - dock.x) > 72 || Math.abs(b.y - dock.y) > 28;
    present();
  });
  candidate.on('closed', () => {
    if (win === candidate) {
      win = null;
      ready = false;
      setTaskbarProbeWindow();
    }
  });
  candidate.on('page-title-updated', (event) => event.preventDefault());
  candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  candidate.webContents.on('will-navigate', (event) => event.preventDefault());
  candidate.webContents.on('render-process-gone', (_event, details) => {
    log.error('[TaskbarMediaBar] Renderer exited; use show to reopen', details);
    if (usable(candidate)) candidate.destroy();
  });
  candidate.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      {
        label: '贴回任务栏',
        click: () => {
          detached = false;
          present(true);
        },
      },
      {
        label: '展开为小窗',
        click: () => {
          detached = true;
          const area = display().workArea;
          candidate.setBounds({
            x: area.x + 16,
            y: area.y + area.height - 80,
            width: 420,
            height: 54,
          });
          present(true);
        },
      },
      { type: 'separator' },
      {
        label: '关闭快捷播控',
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
    if (win !== candidate || !usable(candidate)) return;
    ready = true;
    installSystemListeners();
    await refreshTaskbarShellLayout();
    present(true);
  } catch (error) {
    if (usable(candidate)) candidate.destroy();
    throw error;
  }
}

export async function setTaskbarPlayerEnabled(
  value: boolean,
): Promise<{ enabled: boolean; visible: boolean }> {
  if (process.platform !== 'win32') throw new Error('任务栏快捷播控仅支持 Windows');
  enabled = value;
  setMainAppSetting('taskbarPlayerEnabled', value);
  if (enabled && !usable(win)) {
    if (!creating)
      creating = createBar().finally(() => {
        creating = null;
      });
    await creating;
  }
  present(true);
  if (!enabled) disposeSystem?.();
  else installSystemListeners();
  return { enabled, visible: usable(win) && win.isVisible() };
}

export function registerTaskbarPlayerHandlers(): void {
  ipcRegistry.registerHandler('taskbar-player:set-enabled', (event, value: boolean) => {
    const main = getMainWindow();
    if (
      (!usable(main) || event.sender.id !== main.webContents.id) &&
      (!usable(win) || event.sender.id !== win.webContents.id)
    )
      throw new Error('Invalid taskbar sender');
    if (typeof value !== 'boolean') throw new Error('Invalid taskbar state');
    return setTaskbarPlayerEnabled(value);
  });
  ipcRegistry.registerHandler('taskbar-player:get-state', () => ({
    enabled,
    visible: usable(win) && win.isVisible(),
    isDark: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  }));
  ipcRegistry.registerListener('taskbar-player:show-main', (event) => {
    if (usable(win) && event.sender.id === win.webContents.id) showMainWindow();
  });
}

export function restoreTaskbarPlayer(): void {
  quitting = false;
  if (process.platform === 'win32' && getMainAppSettings().taskbarPlayerEnabled) {
    void setTaskbarPlayerEnabled(true).catch((error) =>
      log.error('[TaskbarMediaBar] Restore failed:', error),
    );
  }
}

export function cleanupTaskbarPlayer(): void {
  quitting = true;
  disposeSystem?.();
  if (usable(win)) win.destroy();
}
