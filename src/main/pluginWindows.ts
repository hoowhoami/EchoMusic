import { ipcRegistry } from './ipc/registry';
import { BrowserWindow, app, screen } from 'electron';
import { join } from 'path';
import type {
  PluginShowOnTopOptions,
  PluginWindowBounds,
  PluginWindowDescriptor,
  PluginWindowResult,
  PluginWindowShowOptions,
} from '../shared/plugins';
import {
  getPluginDescriptor,
  getPluginWindowDescriptor,
  isPluginRendererGoneFailureReason,
  normalizePluginId,
  reportPluginFailure,
} from './plugins';
import { getKvStorage } from './storage/kv';
import log from './logger';

type PluginWindowRecord = {
  pluginId: string;
  windowId: string;
  descriptor: PluginWindowDescriptor;
  window: BrowserWindow;
  persistTimer: ReturnType<typeof setTimeout> | null;
  usesPanel: boolean;
};

const pluginWindowUrl = process.env.VITE_DEV_SERVER_URL;
const pluginWindowHtml = join(__dirname, '../../dist/plugin-window.html');
const pluginWindows = new Map<string, PluginWindowRecord>();
const PLUGIN_WINDOW_RESTACK_DELAYS_MS =
  process.platform === 'win32'
    ? [0, 120, 800]
    : process.platform === 'darwin'
      ? [120, 320]
      : [0, 120];
const PLUGIN_WINDOW_DOCK_RESTORE_DELAYS_MS = [0, 120, 320];
let pluginWindowDockTimers: ReturnType<typeof setTimeout>[] = [];

const getWindowKey = (pluginId: string, windowId: string) =>
  `${normalizePluginId(pluginId)}:${normalizePluginId(windowId)}`;

const getBoundsStorageKey = (pluginId: string, windowId: string) =>
  `plugin-window:${normalizePluginId(pluginId)}:${normalizePluginId(windowId)}:bounds`;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const canUseWindow = (win: BrowserWindow | null | undefined): win is BrowserWindow =>
  Boolean(win && !win.isDestroyed());

const clearDockRestoreTimers = () => {
  if (!pluginWindowDockTimers.length) return;
  pluginWindowDockTimers.forEach((timer) => clearTimeout(timer));
  pluginWindowDockTimers = [];
};

const scheduleDockRestore = () => {
  if (process.platform !== 'darwin') return;
  clearDockRestoreTimers();
  pluginWindowDockTimers = PLUGIN_WINDOW_DOCK_RESTORE_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      app.dock?.show();
    }, delay),
  );
};

const shouldUsePluginWindowPanel = (descriptor: Pick<PluginWindowDescriptor, 'alwaysOnTop'>) =>
  process.platform === 'darwin' && descriptor.alwaysOnTop;

const getStoredBounds = (descriptor: PluginWindowDescriptor): Partial<PluginWindowBounds> => {
  if (!descriptor.rememberBounds) return {};
  const saved = getKvStorage().get<Partial<PluginWindowBounds>>(
    getBoundsStorageKey(descriptor.pluginId, descriptor.id),
  );
  if (!saved || typeof saved !== 'object') return {};
  return {
    ...(typeof saved.x === 'number' ? { x: saved.x } : {}),
    ...(typeof saved.y === 'number' ? { y: saved.y } : {}),
    ...(typeof saved.width === 'number' ? { width: saved.width } : {}),
    ...(typeof saved.height === 'number' ? { height: saved.height } : {}),
  };
};

const persistBounds = (record: PluginWindowRecord) => {
  if (!record.descriptor.rememberBounds || !canUseWindow(record.window)) return;
  const bounds = record.window.getBounds();
  getKvStorage().set(getBoundsStorageKey(record.pluginId, record.windowId), bounds);
};

const schedulePersistBounds = (record: PluginWindowRecord) => {
  if (record.persistTimer) clearTimeout(record.persistTimer);
  record.persistTimer = setTimeout(() => {
    record.persistTimer = null;
    persistBounds(record);
  }, 180);
};

const getFallbackPoint = (descriptor: PluginWindowDescriptor, width: number, height: number) => {
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + (area.width - width) / 2);
  const y =
    descriptor.position === 'center'
      ? Math.round(area.y + (area.height - height) / 2)
      : Math.round(area.y + Math.max(12, area.height * 0.08));
  return { x, y };
};

const getConstraintArea = (descriptor: PluginWindowDescriptor, display: Electron.Display) =>
  descriptor.allowOutsideWorkArea ? display.bounds : display.workArea;

const constrainBounds = (
  descriptor: PluginWindowDescriptor,
  bounds: Partial<PluginWindowBounds>,
): PluginWindowBounds => {
  const width = clamp(
    Math.round(Number(bounds.width) || descriptor.defaultWidth),
    descriptor.minWidth,
    descriptor.maxWidth,
  );
  const height = clamp(
    Math.round(Number(bounds.height) || descriptor.defaultHeight),
    descriptor.minHeight,
    descriptor.maxHeight,
  );
  const fallback = getFallbackPoint(descriptor, width, height);
  const rawX = typeof bounds.x === 'number' ? bounds.x : fallback.x;
  const rawY = typeof bounds.y === 'number' ? bounds.y : fallback.y;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(rawX + width / 2),
    y: Math.round(rawY + height / 2),
  });
  const area = getConstraintArea(descriptor, display);
  const maxX = Math.max(area.x, area.x + area.width - width);
  const maxY = Math.max(area.y, area.y + area.height - height);

  return {
    width,
    height,
    x: clamp(Math.round(rawX), area.x, maxX),
    y: clamp(Math.round(rawY), area.y, maxY),
  };
};

const resolveInitialBounds = (
  descriptor: PluginWindowDescriptor,
  options: PluginWindowShowOptions = {},
) =>
  constrainBounds(descriptor, {
    ...getStoredBounds(descriptor),
    ...(typeof options.width === 'number' ? { width: options.width } : {}),
    ...(typeof options.height === 'number' ? { height: options.height } : {}),
    ...(typeof options.x === 'number' ? { x: options.x } : {}),
    ...(typeof options.y === 'number' ? { y: options.y } : {}),
  });

const syncPresentation = (win: BrowserWindow, descriptor: PluginWindowDescriptor) => {
  win.setBackgroundColor('#00000000');
  win.setSkipTaskbar(descriptor.skipTaskbar);
  if (descriptor.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (typeof win.moveTop === 'function') win.moveTop();
  } else {
    win.setAlwaysOnTop(false, 'normal');
  }
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(descriptor.alwaysOnTop, {
      visibleOnFullScreen: descriptor.alwaysOnTop,
    });
    scheduleDockRestore();
  }
};

const schedulePresentationSync = (win: BrowserWindow, descriptor: PluginWindowDescriptor) => {
  for (const delay of PLUGIN_WINDOW_RESTACK_DELAYS_MS) {
    setTimeout(() => {
      if (!win.isDestroyed()) syncPresentation(win, descriptor);
    }, delay);
  }
};

const loadPluginWindow = async (win: BrowserWindow, descriptor: PluginWindowDescriptor) => {
  const query = {
    pluginId: descriptor.pluginId,
    windowId: descriptor.id,
  };
  if (pluginWindowUrl) {
    const target = new URL('plugin-window.html', pluginWindowUrl);
    target.searchParams.set('pluginId', query.pluginId);
    target.searchParams.set('windowId', query.windowId);
    await win.loadURL(target.toString());
    return;
  }

  await win.loadFile(pluginWindowHtml, { query });
};

const createPluginWindow = async (
  descriptor: PluginWindowDescriptor,
  options: PluginWindowShowOptions = {},
) => {
  const preload = join(__dirname, '../preload/index.js');
  const alwaysOnTop = options.alwaysOnTop ?? descriptor.alwaysOnTop;
  const allowOutsideWorkArea = options.allowOutsideWorkArea ?? descriptor.allowOutsideWorkArea;
  const effectiveDescriptor = { ...descriptor, alwaysOnTop, allowOutsideWorkArea };
  const bounds = resolveInitialBounds(effectiveDescriptor, options);
  const usesPanel = shouldUsePluginWindowPanel(effectiveDescriptor);

  const win = new BrowserWindow({
    title: descriptor.title,
    ...bounds,
    minWidth: descriptor.minWidth,
    minHeight: descriptor.minHeight,
    maxWidth: descriptor.maxWidth,
    maxHeight: descriptor.maxHeight,
    frame: false,
    transparent: descriptor.transparent,
    backgroundColor: '#00000000',
    show: false,
    resizable: descriptor.resizable,
    movable: descriptor.movable,
    hasShadow: false,
    skipTaskbar: descriptor.skipTaskbar,
    alwaysOnTop,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    acceptFirstMouse: descriptor.acceptFirstMouse,
    ...(process.platform === 'darwin'
      ? { type: usesPanel ? 'panel' : 'toolbar' }
      : process.platform === 'linux'
        ? { type: 'toolbar' }
        : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      zoomFactor: 1.0,
      partition: `persist:plugin-window-${descriptor.pluginId}-${descriptor.id}`,
    },
  });

  const record: PluginWindowRecord = {
    pluginId: descriptor.pluginId,
    windowId: descriptor.id,
    descriptor: effectiveDescriptor,
    window: win,
    persistTimer: null,
    usesPanel,
  };
  pluginWindows.set(getWindowKey(descriptor.pluginId, descriptor.id), record);

  win.once('ready-to-show', () => {
    syncPresentation(win, effectiveDescriptor);
    if (win.isMinimized()) win.restore();
    win.showInactive();
    schedulePresentationSync(win, effectiveDescriptor);
  });
  win.on('move', () => schedulePersistBounds(record));
  win.on('resize', () => schedulePersistBounds(record));
  win.on('closed', () => {
    if (record.persistTimer) clearTimeout(record.persistTimer);
    const key = getWindowKey(descriptor.pluginId, descriptor.id);
    if (pluginWindows.get(key) === record) pluginWindows.delete(key);
    if (pluginWindows.size === 0) clearDockRestoreTimers();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!isPluginRendererGoneFailureReason(details.reason)) return;

    log.warn('[PluginWindow] renderer process gone', {
      pluginId: descriptor.pluginId,
      windowId: descriptor.id,
      reason: details.reason,
    });
    reportPluginFailure({
      pluginId: descriptor.pluginId,
      reason: 'render-process-gone',
      message: `插件窗口 ${descriptor.id} 渲染进程异常退出：${details.reason}`,
    });
  });
  win.on('unresponsive', () => {
    reportPluginFailure({
      pluginId: descriptor.pluginId,
      reason: 'unresponsive',
      message: `插件窗口 ${descriptor.id} 渲染进程无响应。`,
    });
  });

  await loadPluginWindow(win, descriptor);
  return record;
};

const recreatePluginWindowForPresentation = async (
  record: PluginWindowRecord,
  descriptor: PluginWindowDescriptor,
  options: PluginWindowShowOptions = {},
) => {
  const previousWindow = record.window;
  const previousBounds = previousWindow.getBounds();
  const recreateOptions: PluginWindowShowOptions = {
    ...previousBounds,
    ...options,
    alwaysOnTop: descriptor.alwaysOnTop,
    allowOutsideWorkArea: descriptor.allowOutsideWorkArea,
  };

  if (record.persistTimer) {
    clearTimeout(record.persistTimer);
    record.persistTimer = null;
  }
  persistBounds(record);

  if (process.platform === 'darwin') {
    previousWindow.setVisibleOnAllWorkspaces(false, {
      visibleOnFullScreen: false,
    });
  }
  previousWindow.setAlwaysOnTop(false, 'normal');
  previousWindow.hide();

  const key = getWindowKey(record.pluginId, record.windowId);
  if (pluginWindows.get(key) === record) pluginWindows.delete(key);
  previousWindow.destroy();

  return createPluginWindow(descriptor, recreateOptions);
};

const getRecord = (pluginId: string, windowId: string) =>
  pluginWindows.get(getWindowKey(pluginId, windowId)) ?? null;

export const getPluginWindow = (pluginId: string, windowId: string) =>
  getRecord(pluginId, windowId)?.window ?? null;

export const showPluginWindow = async (
  pluginId: string,
  windowId: string,
  options: PluginWindowShowOptions = {},
): Promise<PluginWindowResult> => {
  const plugin = getPluginDescriptor(pluginId);
  if (!plugin) return { ok: false, error: '插件不存在' };
  if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };
  if (!plugin.compatibility.compatible) {
    return { ok: false, error: plugin.compatibility.message || '插件版本不兼容' };
  }
  if (!plugin.enabled) return { ok: false, error: '插件未启用' };

  const descriptor = getPluginWindowDescriptor(pluginId, windowId);
  if (!descriptor) return { ok: false, error: '插件窗口不存在' };

  let record = getRecord(descriptor.pluginId, descriptor.id);
  if (!record || !canUseWindow(record.window)) {
    record = await createPluginWindow(descriptor, options);
  } else {
    const nextDescriptor = {
      ...record.descriptor,
      ...(typeof options.alwaysOnTop === 'boolean' ? { alwaysOnTop: options.alwaysOnTop } : {}),
      ...(typeof options.allowOutsideWorkArea === 'boolean'
        ? { allowOutsideWorkArea: options.allowOutsideWorkArea }
        : {}),
    };
    const shouldRecreate =
      process.platform === 'darwin' &&
      record.usesPanel !== shouldUsePluginWindowPanel(nextDescriptor);

    if (shouldRecreate) {
      record = await recreatePluginWindowForPresentation(record, nextDescriptor, options);
    } else {
      const alwaysOnTopChanged = record.descriptor.alwaysOnTop !== nextDescriptor.alwaysOnTop;
      const allowOutsideWorkAreaChanged =
        record.descriptor.allowOutsideWorkArea !== nextDescriptor.allowOutsideWorkArea;
      record.descriptor = nextDescriptor;
      if (alwaysOnTopChanged) syncPresentation(record.window, record.descriptor);
      if (
        typeof options.width === 'number' ||
        typeof options.height === 'number' ||
        typeof options.x === 'number' ||
        typeof options.y === 'number' ||
        allowOutsideWorkAreaChanged
      ) {
        record.window.setBounds(resolveInitialBounds(record.descriptor, options));
      }
      if (!record.window.isVisible()) record.window.showInactive();
      schedulePresentationSync(record.window, record.descriptor);
    }
  }

  return { ok: true, window: record.descriptor, bounds: record.window.getBounds() };
};

export const hidePluginWindow = (pluginId: string, windowId: string): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  record.window.hide();
  return { ok: true, window: record.descriptor, bounds: record.window.getBounds() };
};

export const closePluginWindow = (pluginId: string, windowId: string): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  persistBounds(record);
  record.window.close();
  return { ok: true, window: record.descriptor };
};

export const movePluginWindow = (
  pluginId: string,
  windowId: string,
  bounds: Partial<PluginWindowBounds>,
): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  const current = record.window.getBounds();
  const next = constrainBounds(record.descriptor, { ...current, ...bounds });
  record.window.setBounds(next);
  persistBounds(record);
  return { ok: true, window: record.descriptor, bounds: next };
};

export const getPluginWindowBounds = (pluginId: string, windowId: string): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  return { ok: true, window: record.descriptor, bounds: record.window.getBounds() };
};

export const setPluginWindowIgnoreMouseEvents = (
  pluginId: string,
  windowId: string,
  ignore: boolean,
): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  if (ignore) {
    record.window.setIgnoreMouseEvents(true, { forward: true });
  } else {
    record.window.setIgnoreMouseEvents(false);
  }
  return { ok: true, window: record.descriptor, bounds: record.window.getBounds() };
};

const raiseWindowToFront = (win: BrowserWindow, focus: boolean) => {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) {
    if (focus) win.show();
    else win.showInactive();
  }
  if (typeof win.moveTop === 'function') win.moveTop();
  if (focus) win.focus();
};

export const showPluginWindowOnTop = (
  pluginId: string,
  windowId: string,
  options: PluginShowOnTopOptions = {},
): PluginWindowResult => {
  const record = getRecord(pluginId, windowId);
  if (!record || !canUseWindow(record.window)) return { ok: false, error: '插件窗口未打开' };
  raiseWindowToFront(record.window, options?.focus !== false);
  return { ok: true, window: record.descriptor, bounds: record.window.getBounds() };
};

export const closePluginWindows = (pluginId?: string) => {
  for (const record of Array.from(pluginWindows.values())) {
    if (pluginId && record.pluginId !== normalizePluginId(pluginId)) continue;
    try {
      if (canUseWindow(record.window)) {
        persistBounds(record);
        record.window.close();
      }
    } catch {
      // ignore windows that are already closing
    }
  }
};

export const getPluginWindowContext = (pluginId: string, windowId: string) => {
  const plugin = getPluginDescriptor(pluginId);
  if (!plugin) return { ok: false as const, error: '插件不存在' };
  if (plugin.invalid) return { ok: false as const, error: plugin.error || '插件无效' };
  if (!plugin.compatibility.compatible) {
    return {
      ok: false as const,
      error: plugin.compatibility.message || '插件版本不兼容',
    };
  }
  if (!plugin.enabled) return { ok: false as const, error: '插件未启用' };
  const windowDescriptor =
    plugin.windows.find((item) => item.id === normalizePluginId(windowId)) ?? null;
  if (!windowDescriptor) return { ok: false as const, error: '插件窗口不存在' };
  return { ok: true as const, plugin, window: windowDescriptor };
};

export const registerPluginWindowHandlers = () => {
  ipcRegistry.registerHandler(
    'plugins:window:show',
    (_event, pluginId: string, windowId: string, options) =>
      showPluginWindow(pluginId, windowId, options),
  );
  ipcRegistry.registerHandler('plugins:window:hide', (_event, pluginId: string, windowId: string) =>
    hidePluginWindow(pluginId, windowId),
  );
  ipcRegistry.registerHandler(
    'plugins:window:close',
    (_event, pluginId: string, windowId: string) => closePluginWindow(pluginId, windowId),
  );
  ipcRegistry.registerHandler(
    'plugins:window:move',
    (_event, pluginId: string, windowId: string, bounds) =>
      movePluginWindow(pluginId, windowId, bounds),
  );
  ipcRegistry.registerHandler(
    'plugins:window:get-bounds',
    (_event, pluginId: string, windowId: string) => getPluginWindowBounds(pluginId, windowId),
  );
  ipcRegistry.registerHandler(
    'plugins:window:set-ignore-mouse-events',
    (_event, pluginId: string, windowId: string, ignore: boolean) =>
      setPluginWindowIgnoreMouseEvents(pluginId, windowId, ignore),
  );
  ipcRegistry.registerHandler(
    'plugins:window:show-on-top',
    (_event, pluginId: string, windowId: string, options?: PluginShowOnTopOptions) =>
      showPluginWindowOnTop(pluginId, windowId, options),
  );
  ipcRegistry.registerHandler(
    'plugins:window:get-context',
    (_event, pluginId: string, windowId: string) => getPluginWindowContext(pluginId, windowId),
  );
};
