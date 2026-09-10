import type { BrowserWindow } from 'electron';

const controllers = new WeakMap<BrowserWindow, ReturnType<typeof installWindowFullscreen>>();

export function isWindowFullscreen(win: BrowserWindow) {
  return controllers.get(win)?.get() ?? win.isFullScreen();
}

export function isWindowFullscreenTransitioning(win: BrowserWindow) {
  return controllers.get(win)?.transitioning() ?? false;
}

export function setWindowFullscreen(win: BrowserWindow, value: boolean) {
  const controller = controllers.get(win);
  if (controller) controller.set(value);
  else win.setFullScreen(value);
}

export function installWindowFullscreen(win: BrowserWindow) {
  let requested: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const get = () => requested ?? win.isFullScreen();
  const publish = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send('window:fullscreen-changed', get());
  };
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const apply = (value: boolean) => {
    if (win.isDestroyed()) return;
    requested = value;
    publish();
    if (process.platform === 'darwin') {
      // AppKit reports the old state during its animation. Serialize opposite requests.
      timer = setTimeout(() => {
        timer = undefined;
        requested = undefined;
        publish();
      }, 10_000);
    }
    try {
      win.setFullScreen(value);
    } catch (error) {
      clear();
      requested = undefined;
      publish();
      throw error;
    }
    if (process.platform !== 'darwin') requested = undefined;
  };
  const set = (value: boolean) => {
    if (win.isDestroyed()) return;
    if (timer) {
      requested = value;
      publish();
    } else if (value !== win.isFullScreen()) apply(value);
  };
  const settled = () => {
    const next = requested;
    clear();
    requested = undefined;
    if (next !== undefined && next !== win.isFullScreen()) apply(next);
    else publish();
  };
  win.on('enter-full-screen', settled);
  win.on('leave-full-screen', settled);
  win.webContents.on('did-finish-load', publish);
  win.once('closed', () => {
    clear();
    controllers.delete(win);
  });
  const controller = { get, set, transitioning: () => timer !== undefined };
  controllers.set(win, controller);
  return controller;
}

export function installWindowFullscreenShortcut(win: BrowserWindow) {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;

  // Keep the shortcut local to the main window, including when its button is hidden.
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      input.key.toLowerCase() !== 'f11' ||
      input.control ||
      input.meta ||
      input.alt ||
      input.shift
    )
      return;

    event.preventDefault();
    if (!input.isAutoRepeat) setWindowFullscreen(win, !isWindowFullscreen(win));
  });
}
