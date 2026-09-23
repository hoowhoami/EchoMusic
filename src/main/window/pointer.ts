import { screen, type BrowserWindow } from 'electron';
import { getNativeWindowPointer } from '../native/platform';
import log from '../logger';
import { titleBarHeight } from '../../shared/windowZoom';

const DOUBLE_CLICK_MS = 500;
const MIN_CLICK_GAP_MS = 60;
const DOUBLE_CLICK_PX = 6;

type WindowPointerOptions = {
  /**
   * Transparent Windows windows have neither WS_CAPTION nor WS_MAXIMIZEBOX
   * (Electron and Chromium strip both for translucent widgets), so DefWindowProc
   * never turns a caption double-click into SC_MAXIMIZE. Drive the emulated
   * maximize/unmaximize ourselves: WCO routes drag-region clicks to a child HWND,
   * so the top-level only sees them as client/PARENTNOTIFY messages and never as
   * a non-client double-click. Pair two close titlebar presses in time and space,
   * and keep the maximized state independently of isMaximized(), which compares
   * bounds to the work area and can disagree with the visible window.
   */
  emulatedMaximize?: boolean;
  isFullscreen?: () => boolean;
};

// Native drag regions bypass DOM pointerdown. Observe them without changing hit testing.
export function installWindowPointerEvents(win: BrowserWindow, options: WindowPointerOptions = {}) {
  const send = (point?: { x: number; y: number }) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('window:native-pointerdown', point);
    }
  };
  let stopMonitor: (() => void) | undefined;
  let titlebarClick: { at: number; x: number; y: number } | null = null;
  const resetDoubleClick = () => {
    titlebarClick = null;
  };
  if (process.platform === 'darwin') {
    const native = getNativeWindowPointer();
    if (native) {
      try {
        native.startWindowPointerMonitor(win.getNativeWindowHandle(), (error, point) => {
          if (error || win.isDestroyed() || win.webContents.isDestroyed()) return;
          if (point.y < 0 || point.y > titleBarHeight(win.webContents.getZoomLevel())) return;
          const zoom = win.webContents.getZoomFactor();
          send({ x: point.x / zoom, y: point.y / zoom });
        });
        stopMonitor = () => native.stopWindowPointerMonitor();
      } catch (error) {
        log.warn('[Window] Could not observe native pointer events:', error);
      }
    }
  } else if (process.platform === 'win32') {
    let sequence = 0;
    const report = (source: string, decision: string, detail: Record<string, unknown> = {}) => {
      log.info('[TitlebarPointer]', { windowId: win.id, source, decision, ...detail });
    };
    const notify = (source: string, point?: { x: number; y: number }) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      const eventId = ++sequence;
      report(source, 'notify-renderer', { eventId });
      win.webContents.send('window:native-pointerdown', point, { source, eventId });
    };
    // Emulated maximize swaps bounds for state, so keep our own flip. Electron reports
    // "maximized" by comparing the bounds to the work area, and Unmaximize() silently
    // no-ops when that comparison is false, which can leave a maximized-looking window
    // stuck. Track the state and reconcile it with the maximize/unmaximize events.
    let maximized: boolean | undefined;
    const setMaximized = (value: boolean, origin = 'state') => {
      if (maximized === value) return;
      maximized = value;
      report('maximize-state', value ? 'maximized' : 'restored', { origin });
    };
    if (options.emulatedMaximize) {
      win.on('maximize', () => setMaximized(true, 'event'));
      win.on('unmaximize', () => setMaximized(false, 'event'));
      win.on('restore', () => setMaximized(false, 'event'));
    }
    const toggleEmulatedMaximize = (source: string) => {
      // Leave the message handler before changing bounds; Electron emulates both
      // directions with SetBounds and reports maximized by comparing to the work area.
      setImmediate(() => {
        if (win.isDestroyed()) return;
        if (options.isFullscreen?.()) {
          report(source, 'ignored-maximize-while-fullscreen');
          return;
        }
        const next = maximized ?? win.isMaximized();
        report(source, next ? 'emulated-unmaximize' : 'emulated-maximize');
        setMaximized(!next);
        if (next) win.unmaximize();
        else win.maximize();
      });
    };
    const clientClick = (source: string, button: 'left' | 'right' = 'left') => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      // Electron returns both values in screen DIPs, including on mixed-DPI monitors.
      // Read synchronously in the native message callback, before a drag moves the window.
      const cursor = screen.getCursorScreenPoint();
      const bounds = win.getContentBounds();
      const x = cursor.x - bounds.x;
      const y = cursor.y - bounds.y;
      if (
        x < 0 ||
        x >= bounds.width ||
        y < 0 ||
        y > titleBarHeight(win.webContents.getZoomLevel())
      ) {
        resetDoubleClick();
        log.debug('[TitlebarPointer]', { source, decision: 'outside-titlebar' });
        return;
      }
      const zoom = win.webContents.getZoomFactor();
      const point = { x: x / zoom, y: y / zoom };
      if (button !== 'left' || !options.emulatedMaximize) {
        if (button !== 'left') resetDoubleClick();
        notify(source, point);
        return;
      }
      // The drag-region clicks arrive on a child window, which the top-level HWND
      // only sees as WM_LBUTTONDOWN/WM_PARENTNOTIFY (never as a non-client
      // double-click). Pair two close titlebar presses in time and space instead.
      const now = Date.now();
      const last = titlebarClick;
      if (!last || now - last.at > DOUBLE_CLICK_MS) {
        titlebarClick = { at: now, ...point };
        notify(source, point);
        return;
      }
      // The same physical press is sometimes reported through several hooks.
      if (now - last.at < MIN_CLICK_GAP_MS) return;
      const distancePx = Math.hypot(last.x - point.x, last.y - point.y);
      if (distancePx <= DOUBLE_CLICK_PX) {
        titlebarClick = null;
        report(source, 'emulated-dblclick', { intervalMs: now - last.at, distancePx });
        toggleEmulatedMaximize(source);
        return;
      }
      titlebarClick = { at: now, ...point };
      notify(source, point);
    };
    for (const [message, source] of [
      [0x00a1, 'WM_NCLBUTTONDOWN'],
      [0x00a4, 'WM_NCRBUTTONDOWN'],
    ] as const) {
      win.hookWindowMessage(message, (hitTest) => {
        const hit = hitTest.length >= 4 ? hitTest.readUInt32LE(0) : -1;
        if (hit === 2) notify(source);
        else report(source, 'ignored-non-caption', { hitTest: hit });
      });
    }
    for (const [message, source, button] of [
      [0x0201, 'WM_LBUTTONDOWN', 'left'],
      [0x0204, 'WM_RBUTTONDOWN', 'right'],
    ] as const) {
      win.hookWindowMessage(message, () => clientClick(source, button));
    }
    win.hookWindowMessage(0x0210, (param) => {
      if (param.length < 4) return;
      const event = param.readUInt32LE(0) & 0xffff;
      if (event === 0x0201) clientClick('WM_PARENTNOTIFY', 'left');
      else if (event === 0x0204) clientClick('WM_PARENTNOTIFY', 'right');
    });
    if (options.emulatedMaximize) {
      // Complementary non-client path for setups that do hit-test the drag region
      // as HTCAPTION (e.g. opaque windows): a caption double-click toggles directly.
      win.hookWindowMessage(0x00a3, (hitTest) => {
        const hit = hitTest.length >= 4 ? hitTest.readUInt32LE(0) : -1;
        if (hit === 2) toggleEmulatedMaximize('WM_NCLBUTTONDBLCLK');
        else report('WM_NCLBUTTONDBLCLK', 'ignored-non-caption', { hitTest: hit });
      });
    }
    win.hookWindowMessage(0x0112, (param) => {
      if (param.length < 4) return;
      const command = param.readUInt32LE(0) & 0xfff0;
      if ([0xf010, 0xf030, 0xf120].includes(command)) notify('WM_SYSCOMMAND');
    });
    report('install', 'ready', {
      messages: [
        'NC-button',
        'client-button',
        'parent-notify',
        'system-command',
        ...(options.emulatedMaximize ? ['client-dblclick', 'maximize-state'] : []),
      ],
      emulatedMaximize: Boolean(options.emulatedMaximize),
    });
  }
  // Also dismiss when dragging or leaving the window, including native-addon fallback.
  const dismiss = () => send();
  const inert = () => {
    resetDoubleClick();
    dismiss();
  };
  win.on('move', inert);
  win.on('blur', inert);
  win.once('closed', () => {
    stopMonitor?.();
    win.removeListener('move', inert);
    win.removeListener('blur', inert);
  });
}
