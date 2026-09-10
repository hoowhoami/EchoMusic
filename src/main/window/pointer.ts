import { screen, type BrowserWindow } from 'electron';
import { getNativeWindowPointer } from '../native/platform';
import log from '../logger';
import { titleBarHeight } from '../../shared/window-zoom';

// Native drag regions bypass DOM pointerdown. Observe them without changing hit testing.
export function installWindowPointerEvents(win: BrowserWindow) {
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
    const clientClick = (source: string) => {
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
        log.debug('[TitlebarPointer]', { source, decision: 'outside-titlebar' });
        return;
      }
      const zoom = win.webContents.getZoomFactor();
      notify(source, { x: x / zoom, y: y / zoom });
    };
    // Frameless Chromium/WCO can route clicks as client/child-window messages.
    // Keep the non-client path, but do not depend on HTCAPTION being delivered.
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
    win.hookWindowMessage(0x0112, (param) => {
      if (param.length < 4) return;
      const command = param.readUInt32LE(0) & 0xfff0;
      if ([0xf010, 0xf030, 0xf120].includes(command)) notify('WM_SYSCOMMAND');
    });
    report('install', 'ready', {
      messages: ['NC-button', 'client-button', 'parent-notify', 'system-command'],
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
