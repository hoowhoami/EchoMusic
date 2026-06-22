import { app, type BrowserWindow } from 'electron';
import { resolve } from 'path';
import log from './logger';
import { parseShareUrl, SHARE_SCHEME, type ShareTarget } from '../shared/share';
import { showMainWindow } from './window';

let getMainWindowRef: (() => BrowserWindow | null) | null = null;
const pendingTargets: ShareTarget[] = [];

const findShareUrl = (argv: string[]) => argv.find((item) => parseShareUrl(item));

const dispatchShareTarget = (target: ShareTarget) => {
  const win = getMainWindowRef?.();
  if (!win || win.isDestroyed()) {
    pendingTargets.push(target);
    return;
  }

  if (win.webContents.isLoading()) {
    pendingTargets.push(target);
    win.webContents.once('did-finish-load', flushPendingShareTargets);
    return;
  }

  showMainWindow();
  win.webContents.send('share:open', target);
};

export const flushPendingShareTargets = () => {
  const win = getMainWindowRef?.();
  if (!win || win.isDestroyed() || pendingTargets.length === 0) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', flushPendingShareTargets);
    return;
  }

  const targets = pendingTargets.splice(0);
  showMainWindow();
  targets.forEach((target) => {
    win.webContents.send('share:open', target);
  });
};

export const openShareUrl = (url: string) => {
  const target = parseShareUrl(url);
  if (!target) return false;
  log.info('[Share] Open share target', target);
  dispatchShareTarget(target);
  return true;
};

export const openShareUrlFromArgv = (argv: string[]) => {
  const url = findShareUrl(argv);
  return url ? openShareUrl(url) : false;
};

export const registerShareProtocol = (getMainWindow: () => BrowserWindow | null) => {
  getMainWindowRef = getMainWindow;

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SHARE_SCHEME, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(SHARE_SCHEME);
  }
};
