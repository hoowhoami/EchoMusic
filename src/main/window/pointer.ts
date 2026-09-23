import { screen, type BrowserWindow } from 'electron';
import { getNativeWindowPointer, getWindowsDoubleClickMonitor } from '../native/platform';
import log from '../logger';
import { titleBarHeight } from '../../shared/windowZoom';

type WindowPointerOptions = {
  /**
   * Transparent Windows windows have neither WS_CAPTION nor WS_MAXIMIZEBOX
   * (Electron and Chromium strip both for translucent widgets), so DefWindowProc
   * never turns a caption double-click into SC_MAXIMIZE. Drive the emulated
   * maximize/unmaximize ourselves: a native WH_MOUSE hook observes the child
   * HWND's WM_LBUTTONDBLCLK (the double-click the pairing of presses could never
   * reconstruct), and the renderer confirms the point is a drag region before it
   * triggers the regular maximize toggle. win.isMaximized() is the single source
   * of truth; Electron reports the emulated state by comparing bounds with the
   * work area.
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
    // Convert a screen point to content-relative CSS pixels. The native hook
    // reports physical pixels, which on mixed-DPI monitors differ from the DIPs
    // that Electron's screen API and content bounds use.
    const contentPoint = (screenPoint: { x: number; y: number }, physical: boolean) => {
      if (physical) screenPoint = screen.screenToDipPoint(screenPoint);
      const bounds = win.getContentBounds();
      const x = screenPoint.x - bounds.x;
      const y = screenPoint.y - bounds.y;
      if (
        x < 0 ||
        x >= bounds.width ||
        y < 0 ||
        y > titleBarHeight(win.webContents.getZoomLevel())
      ) {
        return null;
      }
      const zoom = win.webContents.getZoomFactor();
      return { x: x / zoom, y: y / zoom };
    };
    // Counters distinguish "the OS never produced a double-click" from "it was
    // dropped by gating" when a transparent/acrylic window misbehaves.
    let monitorDiagnostics:
      | { installed: boolean; totalDblclick: number; foregroundDblclick: number }
      | undefined;
    const readDblclickDiagnostics = () => {
      const native = getWindowsDoubleClickMonitor();
      if (native?.getWindowsDoubleClickDiagnostics) {
        monitorDiagnostics = native.getWindowsDoubleClickDiagnostics();
      }
      return monitorDiagnostics ?? {};
    };
    // A real double-click on the child/top-level HWND: forward it so the renderer
    // can confirm the point is a drag region and then run the regular toggle.
    const clientDoubleClick = (
      source: string,
      screenPoint: { x: number; y: number },
      physical: boolean,
    ) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (options.isFullscreen?.()) {
        report(source, 'ignored-maximize-while-fullscreen');
        return;
      }
      const point = contentPoint(screenPoint, physical);
      if (!point) {
        report(source, 'outside-titlebar');
        return;
      }
      const eventId = ++sequence;
      report(source, 'forward-dblclick', { eventId, ...readDblclickDiagnostics() });
      win.webContents.send('window:native-dblclick', point, { source, eventId });
    };
    const clientClick = (source: string) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      // Electron returns both values in screen DIPs, including on mixed-DPI monitors.
      // Read synchronously in the native message callback, before a drag moves the window.
      const cursor = screen.getCursorScreenPoint();
      const point = contentPoint(cursor, false);
      if (!point) {
        log.debug('[TitlebarPointer]', { source, decision: 'outside-titlebar' });
        return;
      }
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
    for (const [message, source] of [
      [0x0201, 'WM_LBUTTONDOWN'],
      [0x0204, 'WM_RBUTTONDOWN'],
    ] as const) {
      win.hookWindowMessage(message, () => clientClick(source));
    }
    win.hookWindowMessage(0x0210, (param) => {
      if (param.length < 4) return;
      const event = param.readUInt32LE(0) & 0xffff;
      if (event === 0x0201 || event === 0x0204) clientClick('WM_PARENTNOTIFY');
    });
    // The child HWND's WM_LBUTTONDBLCLK is the only reliable double-click signal on
    // a captionless transparent window. A WH_MOUSE_LL hook inherits the OS
    // double-click timing/distance rules and never intercepts the message itself.
    if (options.emulatedMaximize) {
      const native = getWindowsDoubleClickMonitor();
      if (native) {
        try {
          native.startWindowsDoubleClickMonitor(win.getNativeWindowHandle(), (error, point) => {
            if (error) {
              report('WM_LBUTTONDBLCLK', 'monitor-error', { error: String(error) });
              return;
            }
            clientDoubleClick('WM_LBUTTONDBLCLK', point, true);
          });
          stopMonitor = () => native.stopWindowsDoubleClickMonitor();
          report('native-dblclick', 'installed', readDblclickDiagnostics());
          // Observe, never consume: if the top-level still hit-tests the titlebar
          // as HTCAPTION, the system runs its own SC_MAXIMIZE on the double-click.
          win.hookWindowMessage(0x00a3, (hitTest) => {
            const hit = hitTest.length >= 4 ? hitTest.readUInt32LE(0) : -1;
            if (hit === 2) report('WM_NCLBUTTONDBLCLK', 'caption-dblclick-observed');
          });
        } catch (error) {
          log.warn('[TitlebarPointer] Could not install the native double-click monitor:', error);
        }
      }
    }
    win.hookWindowMessage(0x0112, (param) => {
      if (param.length < 4) return;
      const command = param.readUInt32LE(0) & 0xfff0;
      if ([0xf010, 0xf030, 0xf120].includes(command)) notify('WM_SYSCOMMAND');
    });
    report('install', 'ready', {
      messages: ['NC-button', 'client-button', 'parent-notify', 'system-command'],
      emulatedMaximize: Boolean(options.emulatedMaximize),
    });
  }
  // Also dismiss when dragging or leaving the window, including native-addon fallback.
  const dismiss = () => send();
  win.on('move', dismiss);
  win.on('blur', dismiss);
  win.once('closed', () => {
    stopMonitor?.();
    win.removeListener('move', dismiss);
    win.removeListener('blur', dismiss);
  });
}
