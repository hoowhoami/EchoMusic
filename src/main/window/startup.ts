import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

// ready-to-show can precede Vue mount; either signal may arrive first.
export function waitForMainWindowStartup(window: BrowserWindow, onReady: () => void) {
  return new Promise<void>((resolve) => {
    let nativeReady = false;
    let pageMounted = false;
    const cleanup = () => {
      ipcMain.removeListener('main-window:page-mounted', onPageMounted);
      window.removeListener('ready-to-show', onNativeReady);
      window.removeListener('closed', onClosed);
    };
    const finish = () => {
      if (!nativeReady || !pageMounted || window.isDestroyed()) return;
      cleanup();
      resolve();
      onReady();
    };
    const onNativeReady = () => {
      nativeReady = true;
      finish();
    };
    const onPageMounted = (event: IpcMainEvent) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return;
      pageMounted = true;
      finish();
    };
    const onClosed = () => {
      cleanup();
      resolve();
    };
    ipcMain.on('main-window:page-mounted', onPageMounted);
    window.once('ready-to-show', onNativeReady);
    window.once('closed', onClosed);
  });
}
