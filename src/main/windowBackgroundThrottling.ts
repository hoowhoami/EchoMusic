import type { BrowserWindow } from 'electron';

/** Keep shown UI animating even when Chromium classifies it as occluded. */
export function installWindowBackgroundThrottling(win: BrowserWindow): void {
  const setThrottling = (allowed: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.setBackgroundThrottling(allowed);
  };
  const onShow = () => setThrottling(win.isMinimized());
  const onHide = () => setThrottling(true);
  const onRestore = () => setThrottling(!win.isVisible() || win.isMinimized());

  // Constructors start with backgroundThrottling:true and show:false. Do not
  // force visibility here: floating windows still need their ready-to-show paint,
  // while the main window deliberately uses paintWhenInitiallyHidden:false.
  win.on('show', onShow);
  win.on('hide', onHide);
  win.on('minimize', onHide);
  win.on('restore', onRestore);
  win.once('closed', () => {
    win.off('show', onShow);
    win.off('hide', onHide);
    win.off('minimize', onHide);
    win.off('restore', onRestore);
  });
}
