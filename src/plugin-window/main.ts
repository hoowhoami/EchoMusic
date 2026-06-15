import * as Vue from 'vue';
import './style.css';
import type {
  EchoPluginDescriptor,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginWindowDescriptor,
} from '../shared/plugins';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../shared/audio-spectrum';
import { createFontApi } from '../shared/font';

type PluginWindowModule =
  | {
      activateWindow?: (ctx: EchoPluginWindowContext) => unknown;
      activate?: (ctx: EchoPluginWindowContext) => unknown;
      default?: PluginWindowModuleDefault;
    }
  | PluginWindowModuleDefault;

type PluginWindowModuleDefault =
  | ((ctx: EchoPluginWindowContext) => unknown)
  | {
      activateWindow?: (ctx: EchoPluginWindowContext) => unknown;
      activate?: (ctx: EchoPluginWindowContext) => unknown;
      deactivate?: (ctx: EchoPluginWindowContext) => unknown;
    };

interface EchoPluginWindowContext {
  id: string;
  pluginId: string;
  windowId: string;
  manifest: EchoPluginDescriptor['manifest'];
  descriptor: EchoPluginDescriptor;
  windowDescriptor: PluginWindowDescriptor;
  vue: typeof Vue;
  container: HTMLElement;
  nowPlaying: NonNullable<Window['electron']['nowPlaying']>;
  fonts: ReturnType<typeof createFontsApi>;
  audio: {
    spectrum: {
      getStatus: NonNullable<Window['electron']['audioSpectrum']>['getStatus'];
      getSnapshot: NonNullable<Window['electron']['audioSpectrum']>['getSnapshot'];
      subscribe: (
        options: AudioSpectrumOptions,
        handler: (frame: AudioSpectrumFrame) => void,
      ) => () => void;
    };
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  fs: {
    listFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>;
    listImageFiles: NonNullable<Window['electron']['plugins']>['fs']['listImageFiles'];
    getFileUrl: NonNullable<Window['electron']['plugins']>['fs']['getFileUrl'];
    readTextFile: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>;
    readFileBytes: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>[2],
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>;
  };
  process: {
    launch: (options: PluginProcessLaunchOptions) => Promise<PluginProcessLaunchResult>;
    terminate: (pid: number) => Promise<PluginProcessTerminateResult>;
  };
  css: {
    inject: (cssText: string, options?: { id?: string }) => () => void;
  };
  window: {
    getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
    move: (
      bounds: Partial<{ x: number; y: number; width: number; height: number }>,
    ) => Promise<unknown>;
    hide: () => Promise<unknown>;
    close: () => Promise<unknown>;
    setIgnoreMouseEvents: (ignore: boolean) => Promise<unknown>;
    setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<unknown>;
  };
  electron: Window['electron'];
  dispose: (dispose: () => void) => () => void;
}

const params = new URLSearchParams(window.location.search);
const pluginId = String(params.get('pluginId') || '').trim();
const windowId = String(params.get('windowId') || '').trim();
const root = document.getElementById('app');
const disposables: Array<() => void> = [];
const blobUrls: string[] = [];

document.documentElement.classList.add('plugin-window');
document.body.classList.add('plugin-window');

const setStatus = (message: string) => {
  if (!root) return;
  root.textContent = message;
};

const addDisposable = (dispose: () => void) => {
  disposables.push(dispose);
  return dispose;
};

const createStyleDisposer = (cssText: string, styleId = 'runtime') => {
  const elementId = `echo-plugin-window-style-${pluginId}-${windowId}-${styleId}`;
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.textContent = cssText;
  document.head.appendChild(style);
  return () => style.remove();
};

const reportFailure = (error: unknown, source: string) => {
  const message = error instanceof Error ? error.message : String(error || '插件窗口运行异常');
  void window.electron.plugins?.reportFailure({
    pluginId,
    reason: 'runtime-error',
    message: `${source}: ${message}`,
  });
};

const resolveActivator = (module: PluginWindowModule) => {
  if (typeof module === 'function') return module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginWindowModuleDefault | undefined;
    if (typeof Reflect.get(module, 'activateWindow') === 'function') {
      return (
        Reflect.get(module, 'activateWindow') as (ctx: EchoPluginWindowContext) => unknown
      ).bind(module);
    }
    if (typeof Reflect.get(module, 'activate') === 'function') {
      return (Reflect.get(module, 'activate') as (ctx: EchoPluginWindowContext) => unknown).bind(
        module,
      );
    }
    if (typeof defaultExport === 'function') return defaultExport;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activateWindow === 'function'
    ) {
      return defaultExport.activateWindow.bind(defaultExport);
    }
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activate === 'function'
    ) {
      return defaultExport.activate.bind(defaultExport);
    }
  }
  return null;
};

const cleanup = () => {
  disposables
    .splice(0)
    .reverse()
    .forEach((dispose) => {
      try {
        dispose();
      } catch (error) {
        reportFailure(error, '插件窗口清理');
      }
    });
  blobUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
};

window.addEventListener('beforeunload', cleanup);

const importWindowModule = async (descriptor: EchoPluginDescriptor, source: string) => {
  const blob = new Blob(
    [`${source}\n//# sourceURL=echo-plugin-window:${descriptor.id}:${windowId}`],
    { type: 'text/javascript' },
  );
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return (await import(/* @vite-ignore */ url)) as PluginWindowModule;
};

const requireAudioSpectrumCapability = (descriptor: EchoPluginDescriptor) => {
  if (descriptor.manifest.capabilities?.audioSpectrum !== true) {
    throw new Error('插件未声明音频频谱能力');
  }
};

const createFontsApi = () =>
  createFontApi(() => window.electron.fonts?.getAll?.() ?? Promise.resolve([]));

const buildContext = (
  descriptor: EchoPluginDescriptor,
  windowDescriptor: PluginWindowDescriptor,
  container: HTMLElement,
): EchoPluginWindowContext => ({
  id: descriptor.id,
  pluginId: descriptor.id,
  windowId: windowDescriptor.id,
  manifest: descriptor.manifest,
  descriptor,
  windowDescriptor,
  vue: Vue,
  container,
  nowPlaying: window.electron.nowPlaying,
  fonts: createFontsApi(),
  audio: {
    spectrum: {
      getStatus: () => {
        requireAudioSpectrumCapability(descriptor);
        return (
          window.electron.audioSpectrum?.getStatus() ??
          Promise.resolve({
            available: false,
            running: false,
            provider: 'unavailable' as const,
            reason: '频谱 API 不可用',
          })
        );
      },
      getSnapshot: () => {
        requireAudioSpectrumCapability(descriptor);
        return window.electron.audioSpectrum?.getSnapshot() ?? Promise.resolve(null);
      },
      subscribe: (options, handler) => {
        requireAudioSpectrumCapability(descriptor);
        return addDisposable(
          window.electron.audioSpectrum?.subscribe(options, handler, {
            pluginId: descriptor.id,
          }) ?? (() => undefined),
        );
      },
    },
  },
  storage: {
    get: <T = unknown>(key: string) =>
      window.electron.plugins?.storage.get<T>(descriptor.id, key) ?? Promise.resolve(null),
    set: (key: string, value: unknown) =>
      window.electron.plugins?.storage.set(descriptor.id, key, value) ?? Promise.resolve(null),
    delete: (key: string) =>
      window.electron.plugins?.storage.delete(descriptor.id, key) ?? Promise.resolve(null),
  },
  fs: {
    listFiles: (directoryPath, options) =>
      window.electron.plugins?.fs.listFiles(descriptor.id, directoryPath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    listImageFiles: (directoryPath, options) =>
      window.electron.plugins?.fs.listImageFiles(directoryPath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    getFileUrl: (filePath) =>
      window.electron.plugins?.fs.getFileUrl(filePath) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    readTextFile: (filePath, options) =>
      window.electron.plugins?.fs.readTextFile(descriptor.id, filePath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    readFileBytes: (filePath, options) =>
      window.electron.plugins?.fs.readFileBytes(descriptor.id, filePath, options) ??
      Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
  },
  process: {
    launch: (options) =>
      window.electron.plugins?.process.launch(descriptor.id, options) ??
      Promise.resolve({ ok: false, error: '插件进程 API 不可用' }),
    terminate: (pid) =>
      window.electron.plugins?.process.terminate(descriptor.id, pid) ??
      Promise.resolve({ ok: false, error: '插件进程 API 不可用' }),
  },
  css: {
    inject: (cssText, options) =>
      addDisposable(createStyleDisposer(cssText, options?.id || 'runtime')),
  },
  window: {
    getBounds: async () => {
      const result = await window.electron.plugins?.windows.getBounds(
        descriptor.id,
        windowDescriptor.id,
      );
      return result?.ok ? (result.bounds ?? null) : null;
    },
    move: (bounds) =>
      window.electron.plugins?.windows.move(descriptor.id, windowDescriptor.id, bounds) ??
      Promise.resolve(null),
    hide: () =>
      window.electron.plugins?.windows.hide(descriptor.id, windowDescriptor.id) ??
      Promise.resolve(null),
    close: () =>
      window.electron.plugins?.windows.close(descriptor.id, windowDescriptor.id) ??
      Promise.resolve(null),
    setIgnoreMouseEvents: (ignore) =>
      window.electron.plugins?.windows.setIgnoreMouseEvents(
        descriptor.id,
        windowDescriptor.id,
        ignore,
      ) ?? Promise.resolve(null),
    setAlwaysOnTop: (alwaysOnTop) =>
      window.electron.plugins?.windows.show(descriptor.id, windowDescriptor.id, {
        alwaysOnTop,
      }) ?? Promise.resolve(null),
  },
  electron: window.electron,
  dispose: addDisposable,
});

const bootstrap = async () => {
  if (!root) return;
  if (!pluginId || !windowId) {
    setStatus('插件窗口参数缺失');
    return;
  }
  if (!window.electron.plugins?.windows || !window.electron.nowPlaying) {
    setStatus('插件窗口 API 不可用');
    return;
  }

  const contextResult = await window.electron.plugins.windows.getContext(pluginId, windowId);
  if (!contextResult.ok) {
    setStatus(contextResult.error);
    return;
  }

  if (contextResult.window.style) {
    const styleAsset = await window.electron.plugins.windows.readAsset(pluginId, windowId, 'style');
    if (styleAsset.ok && styleAsset.source) {
      addDisposable(createStyleDisposer(styleAsset.source, 'manifest'));
    }
  }

  const mainAsset = await window.electron.plugins.windows.readAsset(pluginId, windowId, 'main');
  if (!mainAsset.ok) {
    setStatus(mainAsset.error);
    return;
  }

  const module = await importWindowModule(contextResult.plugin, mainAsset.source);
  const activator = resolveActivator(module);
  if (!activator) {
    throw new Error('插件窗口未导出 activateWindow(ctx) 或默认函数');
  }

  root.textContent = '';
  await activator(buildContext(contextResult.plugin, contextResult.window, root));
};

bootstrap().catch((error) => {
  reportFailure(error, '插件窗口启动');
  setStatus(error instanceof Error ? error.message : '插件窗口启动失败');
});
