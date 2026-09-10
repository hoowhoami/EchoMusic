import type { BrowserWindow } from 'electron';
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
    // WM_NCLBUTTONDOWN / WM_NCRBUTTONDOWN, HTCAPTION only (not resize/system controls).
    for (const message of [0x00a1, 0x00a4]) {
      win.hookWindowMessage(message, (hitTest) => {
        if (hitTest.readUInt32LE(0) === 2) send();
      });
    }
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
