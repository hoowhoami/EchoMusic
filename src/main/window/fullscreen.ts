import type { BrowserWindow, Rectangle } from 'electron';

type WindowFullscreenOptions = {
  /**
   * Windows cannot give a transparent window WS_THICKFRAME, so Electron emulates
   * fullscreen by resizing it to the display: isFullScreen() stays false and the
   * native caption buttons remain visible. Track the state from Electron's own
   * enter/leave notifications instead of the widget.
   */
  emulated?: boolean;
};

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

export function installWindowFullscreen(win: BrowserWindow, options: WindowFullscreenOptions = {}) {
  const emulated = options.emulated === true;
  let requested: boolean | undefined;
  let tracked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Emulated fullscreen and emulated maximize share one Electron restore rectangle:
  // entering fullscreen from a maximized window overwrites the normal bounds, so
  // leaving keeps the window at work-area size and restore has nothing to return to.
  // Keep our own snapshot of the pre-fullscreen window. Real fullscreen hides the
  // WCO buttons; emulated fullscreen keeps drawing them, so hide maximize (Electron
  // derives "maximized" from the bounds and would flip it on every transition) and
  // minimize (its restore path has no emulated-fullscreen handling). Close cannot be
  // hidden, only disabled, so it stays available.
  let snapshot: { maximized: boolean; bounds: Rectangle } | null = null;
  let nested = 0;
  const native = () => (emulated ? tracked : win.isFullScreen());
  const captureEmulatedEntry = () => {
    const maximized = win.isMaximized();
    snapshot = { maximized, bounds: maximized ? win.getNormalBounds() : win.getBounds() };
    win.setMaximizable(false);
    win.setMinimizable(false);
  };
  const restoreEmulatedExit = () => {
    const state = snapshot;
    snapshot = null;
    // Electron applies its own restore bounds after notifying; override them afterwards.
    setImmediate(() => {
      if (win.isDestroyed() || tracked) return;
      win.setMaximizable(true);
      win.setMinimizable(true);
      if (!state) return;
      win.setBounds(state.bounds);
      if (state.maximized) win.maximize();
    });
  };
  const get = () => requested ?? native();
  const publish = (value = get()) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send('window:fullscreen-changed', value, { nativeControls: emulated });
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
    } else if (value !== native()) apply(value);
  };
  const settled = (value: boolean) => {
    if (emulated) {
      if (value) {
        // HTML fullscreen inside app fullscreen re-enters Electron's emulation;
        // Chromium cannot see the emulated state, so pair it here instead.
        if (tracked) {
          nested++;
          return;
        }
        captureEmulatedEntry();
      } else if (nested > 0) {
        nested--;
        return;
      } else {
        restoreEmulatedExit();
      }
    }
    tracked = value;
    // Windows emits these events before updating isFullScreen(). In particular,
    // HTML fullscreen's Escape exit has no app request to override that old value.
    // Only AppKit needs to serialize requests across an asynchronous animation.
    if (process.platform !== 'darwin') {
      publish(value);
      return;
    }
    const next = requested;
    clear();
    requested = undefined;
    if (next !== undefined && next !== value) apply(next);
    else publish(value);
  };
  win.on('enter-full-screen', () => settled(true));
  win.on('leave-full-screen', () => settled(false));
  win.webContents.on('did-finish-load', () => publish());
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

  let htmlFullscreen = false;
  win.webContents.on('enter-html-full-screen', () => {
    htmlFullscreen = true;
  });
  win.webContents.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
  });

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
    if (input.isAutoRepeat) return;
    // Let Chromium restore the video, viewport and original window state together.
    // setFullScreen(false) alone leaves the HTML fullscreen element in place.
    if (htmlFullscreen) win.webContents.send('window:exit-html-fullscreen');
    else setWindowFullscreen(win, !isWindowFullscreen(win));
  });
}
