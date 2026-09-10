import type { MainWindowState } from '../storage/settings';
import { validWindowRect, type WindowRect } from '../windowSizing';

interface StatefulWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): WindowRect;
  getBounds(): WindowRect;
  on(event: string, callback: () => void): unknown;
  removeListener(event: string, callback: () => void): unknown;
}

/** The normal outer rectangle remains authoritative across maximize/fullscreen/minimize. */
export function readMainWindowState(
  win: StatefulWindow,
  previous: MainWindowState,
  options: { supportsPosition?: boolean; transitioning?: () => boolean; macOS?: boolean } = {},
): MainWindowState {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || options.transitioning?.())
    return previous;
  // VS Code records macOS zoom as a normal window size, not a maximized mode.
  const isMaximized = !options.macOS && win.isMaximized();
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  if (options.supportsPosition === false) {
    if (!validWindowRect({ ...bounds, x: 0, y: 0 })) return previous;
    return { width: bounds.width, height: bounds.height, isMaximized };
  }
  if (!validWindowRect(bounds)) return previous;
  return { ...bounds, isMaximized };
}

export function trackMainWindowState(
  win: StatefulWindow,
  options: {
    initial: MainWindowState;
    enabled(): boolean;
    save(state: MainWindowState): void;
    supportsPosition?: boolean;
    transitioning?: () => boolean;
    macOS?: boolean;
  },
) {
  let state = options.initial;
  let persisted = JSON.stringify(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    clear();
    state = readMainWindowState(win, state, options);
    if (!options.enabled() || win.isDestroyed()) return;
    const serialized = JSON.stringify(state);
    if (serialized === persisted) return;
    options.save(state);
    persisted = serialized;
  };
  const schedule = () => {
    // Capture before a subsequent minimize/fullscreen event hides the normal state.
    state = readMainWindowState(win, state, options);
    clear();
    timer = setTimeout(flush, 200);
  };
  const events = ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'leave-full-screen'];
  for (const event of events) win.on(event, schedule);
  return {
    flush,
    dispose() {
      clear();
      for (const event of events) win.removeListener(event, schedule);
    },
  };
}
