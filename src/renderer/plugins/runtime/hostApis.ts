import type {
  PluginHostWindowTarget,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginShowOnTopOptions,
  PluginWindowBounds,
  PluginWindowResizeOptions,
  PluginWindowShowOptions,
} from '../../../shared/plugins';
import { serializeForIpc } from './ipc';
import { createWindowDragLifecycle } from '@/composables/useWindowDrag';
import { useWindowResize, type WindowResizeBounds } from '@/composables/useWindowResize';

export type WindowDragElementAdapter = {
  start: (sessionId: string) => Promise<boolean>;
  move: (sessionId: string, event: PointerEvent) => void;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export type WindowResizeBindOptions = PluginWindowResizeOptions;

type WindowResizeElementAdapter = {
  getBounds: () => Promise<WindowResizeBounds | null>;
  start: (sessionId: string) => Promise<boolean>;
  resize: (sessionId: string, bounds: WindowResizeBounds) => void;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export const createWindowResizeHandlers =
  (
    adapter: WindowResizeElementAdapter,
    sessionPrefix: string,
    options: WindowResizeBindOptions = {},
    onCancelInteraction?: (cancel: () => void) => () => void,
  ) =>
  (element: HTMLElement) => {
    const resize = useWindowResize({
      adapter,
      sessionPrefix,
      minBounds: { width: options.minWidth, height: options.minHeight },
      maxBounds: { width: options.maxWidth, height: options.maxHeight },
      getStartBounds: async (event) =>
        (await adapter.getBounds()) ?? {
          x: Math.round(event.screenX - event.clientX),
          y: Math.round(event.screenY - event.clientY),
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
        },
    });
    const onPointerDown = (event: PointerEvent) => {
      void resize.onPointerDown(event, options.direction ?? 'se');
    };
    element.addEventListener('pointerdown', onPointerDown);
    const cancelDisposer = onCancelInteraction?.(() => resize.cancel(false));
    return () => {
      cancelDisposer?.();
      element.removeEventListener('pointerdown', onPointerDown);
      resize.cancel();
    };
  };

export const createWindowDragHandlers =
  (
    adapter: WindowDragElementAdapter,
    sessionPrefix: string,
    onCancelInteraction?: (cancel: () => void) => () => void,
  ) =>
  (element: HTMLElement) => {
    const lifecycle = createWindowDragLifecycle({
      adapter,
      sessionPrefix,
    });
    const onDown = (event: PointerEvent) => void lifecycle.onPointerDown(event);
    const onMove = lifecycle.onPointerMove;
    const onUp = lifecycle.onPointerUp;
    const onCancel = lifecycle.onPointerCancel;
    const onLeave = lifecycle.onPointerLeave;
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove, { passive: false });
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    element.addEventListener('pointerleave', onLeave);
    const cancelDisposer = onCancelInteraction?.(() => lifecycle.cancel(false));
    return () => {
      cancelDisposer?.();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      element.removeEventListener('pointerleave', onLeave);
      lifecycle.dispose();
    };
  };

export const createPluginWindowsApi = (pluginId: string) => {
  const getWindowsApi = () => window.electron.plugins?.windows;
  const unavailable = () => Promise.reject(new Error('插件窗口 API 不可用'));
  const invokeDrag = <T>(call: () => T | undefined, missing: () => T) => {
    try {
      const result = call();
      return result === undefined ? missing() : result;
    } catch (error) {
      return Promise.reject(error) as T;
    }
  };
  const drag = {
    start: (windowId: string, sessionId: string) =>
      invokeDrag(
        () => getWindowsApi()?.startDrag(pluginId, windowId, sessionId),
        () => Promise.resolve(false),
      ),
    move: (windowId: string, sessionId: string, x: number, y: number) =>
      invokeDrag(
        () => getWindowsApi()?.dragMove(pluginId, windowId, sessionId, x, y),
        () => undefined,
      ),
    end: (windowId: string, sessionId: string) =>
      invokeDrag(() => getWindowsApi()?.endDrag(pluginId, windowId, sessionId), unavailable),
    cancel: (windowId: string, sessionId: string) =>
      invokeDrag(() => getWindowsApi()?.cancelDrag(pluginId, windowId, sessionId), unavailable),
    bind: (windowId: string, element: HTMLElement) =>
      createWindowDragHandlers(
        {
          start: (sessionId) => drag.start(windowId, sessionId),
          move: (sessionId, event) => drag.move(windowId, sessionId, event.screenX, event.screenY),
          end: (sessionId) => drag.end(windowId, sessionId),
          cancel: (sessionId) => drag.cancel(windowId, sessionId),
        },
        `plugin-window:${windowId}`,
      )(element),
  };
  const resize = {
    start: (windowId: string, sessionId: string) =>
      invokeDrag(
        () => getWindowsApi()?.startResize(pluginId, windowId, sessionId),
        () => Promise.resolve(false),
      ),
    resize: (windowId: string, sessionId: string, bounds: WindowResizeBounds) =>
      invokeDrag(
        () => getWindowsApi()?.resize(pluginId, windowId, sessionId, bounds),
        () => undefined,
      ),
    end: (windowId: string, sessionId: string) =>
      invokeDrag(() => getWindowsApi()?.endResize(pluginId, windowId, sessionId), unavailable),
    cancel: (windowId: string, sessionId: string) =>
      invokeDrag(() => getWindowsApi()?.cancelResize(pluginId, windowId, sessionId), unavailable),
    bind: (windowId: string, element: HTMLElement, options?: WindowResizeBindOptions) =>
      createWindowResizeHandlers(
        {
          getBounds: async () => {
            const result = await getWindowsApi()?.getBounds(pluginId, windowId);
            return result?.ok ? (result.bounds ?? null) : null;
          },
          start: (sessionId) => resize.start(windowId, sessionId),
          resize: (sessionId, sessionBounds) => resize.resize(windowId, sessionId, sessionBounds),
          end: (sessionId) => resize.end(windowId, sessionId),
          cancel: (sessionId) => resize.cancel(windowId, sessionId),
        },
        `plugin-window-resize:${windowId}`,
        options,
      )(element),
  };
  return {
    show: (windowId: string, options?: PluginWindowShowOptions) =>
      getWindowsApi()?.show(pluginId, windowId, options) ?? unavailable(),
    hide: (windowId: string) => getWindowsApi()?.hide(pluginId, windowId) ?? unavailable(),
    close: (windowId: string) => getWindowsApi()?.close(pluginId, windowId) ?? unavailable(),
    move: (windowId: string, bounds: Partial<PluginWindowBounds>) =>
      getWindowsApi()?.move(pluginId, windowId, bounds) ?? unavailable(),
    drag,
    resize,
    getBounds: (windowId: string) =>
      getWindowsApi()?.getBounds(pluginId, windowId) ?? unavailable(),
    setIgnoreMouseEvents: (windowId: string, ignore: boolean) =>
      getWindowsApi()?.setIgnoreMouseEvents(pluginId, windowId, ignore) ?? unavailable(),
    showOnTop: (windowId: string, options?: PluginShowOnTopOptions) =>
      getWindowsApi()?.showOnTop(pluginId, windowId, options) ?? unavailable(),
  };
};

export const createPluginHostApi = () => {
  const getHostApi = () => window.electron.plugins?.host;
  const unavailable = () => Promise.reject(new Error('插件宿主窗口 API 不可用'));
  return {
    showOnTop: (target?: PluginHostWindowTarget, options?: PluginShowOnTopOptions) =>
      getHostApi()?.showOnTop(target, options) ?? unavailable(),
  };
};

export const createPluginFsApi = (pluginId: string) => {
  const getFsApi = () => window.electron.plugins?.fs;
  const unavailable = (message = '插件文件 API 不可用') =>
    Promise.resolve({ ok: false as const, error: message });
  return {
    listFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>[2],
    ) =>
      getFsApi()?.listFiles(pluginId, directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    listImageFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listImageFiles']>[1],
    ) =>
      getFsApi()?.listImageFiles(directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    getFileUrl: (filePath: string) => getFsApi()?.getFileUrl(filePath) ?? unavailable(),
    readTextFile: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>[2],
    ) =>
      getFsApi()?.readTextFile(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    readFileBytes: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>[2],
    ) =>
      getFsApi()?.readFileBytes(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    readAudioMetadata: (filePath: string) =>
      getFsApi()?.readAudioMetadata(pluginId, filePath) ?? unavailable(),
    writeFile: (
      filePath: string,
      data: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[2],
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[3],
    ) => {
      const payload =
        data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : serializeForIpc(data);
      return (
        getFsApi()?.writeFile(
          pluginId,
          filePath,
          payload as typeof data,
          serializeForIpc(options) as typeof options,
        ) ?? unavailable()
      );
    },
    deleteFile: (filePath: string) => getFsApi()?.deleteFile(pluginId, filePath) ?? unavailable(),
  };
};

export const createPluginProcessApi = (pluginId: string) => {
  const getProcessApi = () => window.electron.plugins?.process;
  return {
    launch: (options: PluginProcessLaunchOptions): Promise<PluginProcessLaunchResult> =>
      getProcessApi()?.launch(pluginId, serializeForIpc(options) as PluginProcessLaunchOptions) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
    terminate: (pid: number): Promise<PluginProcessTerminateResult> =>
      getProcessApi()?.terminate(pluginId, pid) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
  };
};
