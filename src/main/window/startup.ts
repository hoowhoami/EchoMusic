import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

// Hidden windows do not paint, so neither ready-to-show nor animation frames
// can gate startup. A trusted mounted-DOM signal also allows early tray restores.
export function waitForMainWindowStartup(window: BrowserWindow, onReady: () => void) {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      ipcMain.removeListener('main-window:page-mounted', onPageMounted);
      window.removeListener('closed', onClosed);
    };
    const onPageMounted = (event: IpcMainEvent) => {
      if (
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        return;
      cleanup();
      resolve();
      onReady();
    };
    const onClosed = () => {
      cleanup();
      resolve();
    };
    ipcMain.on('main-window:page-mounted', onPageMounted);
    window.once('closed', onClosed);
  });
}
