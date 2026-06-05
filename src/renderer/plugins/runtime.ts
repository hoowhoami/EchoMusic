import * as Vue from 'vue';
import { computed, reactive, watch, type App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import { Icon } from '@iconify/vue';
import type {
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginFailureRecord,
  PluginListResult,
} from '../../shared/plugins';
import * as icons from '@/icons';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useThemeStore } from '@/stores/theme';
import { logger } from '@/utils/logger';
import {
  createPluginUiApi,
  executePluginCommand,
  registerPluginCommand,
  removePluginContributions,
} from './registry';
import type { Component } from 'vue';

type PluginModule =
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
      default?: PluginModuleDefault;
    }
  | PluginModuleDefault;

type PluginModuleDefault =
  | ((ctx: EchoPluginContext) => unknown)
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
    };

export interface EchoPluginContext {
  id: string;
  manifest: EchoPluginManifest;
  descriptor: EchoPluginDescriptor;
  app: VueApp;
  vue: typeof Vue;
  router: Router;
  pinia: Pinia;
  stores: {
    player: ReturnType<typeof usePlayerStore>;
    playlist: ReturnType<typeof usePlaylistStore>;
    lyric: ReturnType<typeof useLyricStore>;
    settings: ReturnType<typeof useSettingStore>;
    theme: ReturnType<typeof useThemeStore>;
  };
  player: ReturnType<typeof createPlayerApi>;
  playlist: ReturnType<typeof createPlaylistApi>;
  lyric: ReturnType<typeof useLyricStore>;
  settings: ReturnType<typeof useSettingStore>;
  toast: ReturnType<typeof createToastApi>;
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  dialog: NonNullable<Window['electron']['plugins']>['dialog'];
  fs: NonNullable<Window['electron']['plugins']>['fs'];
  ui: ReturnType<typeof createRuntimeUiApi>;
  commands: {
    register: (
      id: string,
      handler: (...args: unknown[]) => unknown,
      options?: { title?: string },
    ) => () => void;
    execute: (id: string, ...args: unknown[]) => unknown;
  };
  css: {
    inject: (cssText: string, options?: { id?: string }) => () => void;
  };
  events: {
    onTrackChange: (handler: (track: unknown) => void) => () => void;
    onPlaybackChange: (handler: (isPlaying: boolean) => void) => () => void;
  };
  dom: {
    query: <T extends Element = Element>(selector: string) => T | null;
    queryAll: <T extends Element = Element>(selector: string) => T[];
    observe: (
      selector: string,
      handler: (element: Element) => void | (() => void),
      options?: { root?: Element | Document; once?: boolean },
    ) => () => void;
  };
  net: {
    fetch: typeof fetch;
  };
  icons: typeof icons;
  electron: Window['electron'];
  dispose: (dispose: () => void) => () => void;
}

export interface PluginRuntimeHost {
  app: VueApp;
  router: Router;
  pinia: Pinia;
}

export interface PluginRuntimeRecord {
  descriptor: EchoPluginDescriptor;
  status: 'idle' | 'loading' | 'active' | 'error';
  error: string;
}

type ActivePlugin = {
  descriptor: EchoPluginDescriptor;
  context: EchoPluginContext;
  module: PluginModule;
  disposables: Array<() => void>;
  blobUrls: string[];
};

export const pluginRuntimeState = reactive({
  directory: '',
  safeMode: false,
  lastFailure: null as PluginFailureRecord | null,
  loading: false,
  records: [] as PluginRuntimeRecord[],
  initialized: false,
});

const activePlugins = new Map<string, ActivePlugin>();
let hostRef: PluginRuntimeHost | null = null;
let runtimeErrorHandlersInstalled = false;

const createPlayerApi = () => {
  const player = usePlayerStore();
  return {
    store: player,
    currentTrack: computed(() => player.currentTrackSnapshot),
    isPlaying: computed(() => player.isPlaying),
    play: () => {
      if (!player.isPlaying) void player.togglePlay();
    },
    pause: () => {
      if (player.isPlaying) void player.togglePlay();
    },
    toggle: () => player.togglePlay(),
    next: () => player.next(),
    prev: () => player.prev(),
    seek: (time: number) => player.seek(time),
    setVolume: (volume: number) => player.setVolume(volume),
    setPlayMode: player.setPlayMode,
  };
};

const createPlaylistApi = () => {
  const playlist = usePlaylistStore();
  return {
    store: playlist,
    setPlaybackQueue: playlist.setPlaybackQueue,
    setPlaybackQueueWithOptions: playlist.setPlaybackQueueWithOptions,
    appendToPlaybackQueue: playlist.appendToPlaybackQueue,
    enqueuePlayNext: playlist.enqueuePlayNext,
    getActiveQueue: () => playlist.activeQueue,
  };
};

const createToastApi = () => {
  const toast = useToastStore();
  return {
    info: toast.info,
    success: toast.success,
    warning: toast.warning,
    danger: toast.danger,
    show: toast.show,
  };
};

const hostComponentLoaders = {
  Avatar: () => import('@/components/ui/Avatar.vue').then((module) => module.default),
  Badge: () => import('@/components/ui/Badge.vue').then((module) => module.default),
  Button: () => import('@/components/ui/Button.vue').then((module) => module.default),
  Cover: () => import('@/components/ui/Cover.vue').then((module) => module.default),
  Dialog: () => import('@/components/ui/Dialog.vue').then((module) => module.default),
  Drawer: () => import('@/components/ui/Drawer.vue').then((module) => module.default),
  Input: () => import('@/components/ui/Input.vue').then((module) => module.default),
  InputNumber: () => import('@/components/ui/InputNumber.vue').then((module) => module.default),
  Popover: () => import('@/components/ui/Popover.vue').then((module) => module.default),
  Scrollbar: () => import('@/components/ui/Scrollbar.vue').then((module) => module.default),
  Select: () => import('@/components/ui/Select.vue').then((module) => module.default),
  Slider: () => import('@/components/ui/Slider.vue').then((module) => module.default),
  Switch: () => import('@/components/ui/Switch.vue').then((module) => module.default),
  Tabs: () => import('@/components/ui/Tabs.vue').then((module) => module.default),
  TabsContent: () => import('@/components/ui/TabsContent.vue').then((module) => module.default),
  TabsList: () => import('@/components/ui/TabsList.vue').then((module) => module.default),
  TabsTrigger: () => import('@/components/ui/TabsTrigger.vue').then((module) => module.default),
  Tooltip: () => import('@/components/ui/Tooltip.vue').then((module) => module.default),
};

const resolveMountTarget = (target: string | Element): Element | null => {
  if (typeof target !== 'string') return target;
  return document.querySelector(target);
};

const insertMountContainer = (
  target: Element,
  container: HTMLElement,
  position: 'append' | 'prepend' | 'before' | 'after' | 'replace',
) => {
  if (position === 'prepend') {
    target.prepend(container);
    return;
  }
  if (position === 'before') {
    target.parentElement?.insertBefore(container, target);
    return;
  }
  if (position === 'after') {
    target.parentElement?.insertBefore(container, target.nextSibling);
    return;
  }
  if (position === 'replace') {
    target.replaceWith(container);
    container.appendChild(target);
    target.setAttribute('data-echo-plugin-replaced', 'true');
    return;
  }
  target.appendChild(container);
};

const createMountedComponentDisposer = (
  pluginId: string,
  host: PluginRuntimeHost,
  target: string | Element,
  component: Component,
  options: {
    props?: Record<string, unknown>;
    position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
    className?: string;
    id?: string;
  } = {},
) => {
  const targetElement = resolveMountTarget(target);
  if (!targetElement) throw new Error(`插件挂载目标不存在: ${String(target)}`);

  const container = document.createElement('div');
  container.className = ['echo-plugin-mount', options.className].filter(Boolean).join(' ');
  container.dataset.pluginId = pluginId;
  if (options.id) container.dataset.pluginMount = options.id;
  const position = options.position ?? 'append';
  insertMountContainer(targetElement, container, position);

  const mountedApp = Vue.createApp(component, options.props ?? {});
  mountedApp.use(host.pinia);
  mountedApp.use(host.router);
  mountedApp.component('Icon', Icon);
  mountedApp.config.globalProperties.$echo = host.app.config.globalProperties.$echo;
  mountedApp.mount(container);

  return () => {
    mountedApp.unmount();
    if (position === 'replace') {
      const replaced = container.querySelector<HTMLElement>('[data-echo-plugin-replaced="true"]');
      if (replaced) {
        replaced.removeAttribute('data-echo-plugin-replaced');
        container.replaceWith(replaced);
        return;
      }
    }
    container.remove();
  };
};

const createDomApi = (addDisposable: (dispose: () => void) => () => void) => ({
  query: <T extends Element = Element>(selector: string) => document.querySelector<T>(selector),
  queryAll: <T extends Element = Element>(selector: string) =>
    Array.from(document.querySelectorAll<T>(selector)),
  observe: (
    selector: string,
    handler: (element: Element) => void | (() => void),
    options?: { root?: Element | Document; once?: boolean },
  ) => {
    const root = options?.root ?? document.body;
    const seen = new WeakSet<Element>();
    const disposers: Array<() => void> = [];
    let stopped = false;

    const visit = (element: Element) => {
      if (stopped || seen.has(element)) return;
      seen.add(element);
      const dispose = handler(element);
      if (typeof dispose === 'function') disposers.push(dispose);
      if (options?.once) stop();
    };

    const scan = () => {
      if (stopped) return;
      if (root instanceof Element && root.matches(selector)) visit(root);
      const queryRoot = root instanceof Document ? root : root.ownerDocument;
      const scope = root instanceof Document ? root : root;
      if (!queryRoot) return;
      Array.from(scope.querySelectorAll(selector)).forEach(visit);
    };

    const observer = new MutationObserver(scan);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      disposers
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
    };

    scan();
    if (!stopped) observer.observe(root, { childList: true, subtree: true });
    return addDisposable(stop);
  },
});

const createRuntimeUiApi = (
  pluginId: string,
  host: PluginRuntimeHost,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const baseUi = createPluginUiApi(pluginId, addDisposable);
  return {
    ...baseUi,
    components: hostComponentLoaders,
    mount: (
      target: string | Element,
      component: Component,
      options?: {
        props?: Record<string, unknown>;
        position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
        className?: string;
        id?: string;
      },
    ) => addDisposable(createMountedComponentDisposer(pluginId, host, target, component, options)),
    teleport: (
      component: Component,
      options?: { props?: Record<string, unknown>; className?: string; id?: string },
    ) =>
      addDisposable(
        createMountedComponentDisposer(pluginId, host, document.body, component, {
          ...options,
          position: 'append',
          className: ['echo-plugin-teleport', options?.className].filter(Boolean).join(' '),
        }),
      ),
  };
};

const updateRecord = (
  descriptor: EchoPluginDescriptor,
  status: PluginRuntimeRecord['status'],
  error = '',
) => {
  const existing = pluginRuntimeState.records.find(
    (record) => record.descriptor.id === descriptor.id,
  );
  if (existing) {
    existing.descriptor = descriptor;
    existing.status = status;
    existing.error = error;
    return;
  }
  pluginRuntimeState.records.push({ descriptor, status, error });
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message || fallback;
  const message = String(error ?? '').trim();
  return message || fallback;
};

const reportPluginActivationFailure = async (pluginId: string, message: string) => {
  try {
    await window.electron.plugins?.reportFailure({
      pluginId,
      reason: 'activation-error',
      message,
    });
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin activation failure report failed', {
      pluginId,
      error,
    });
  }
};

const syncActivePluginSession = async () => {
  try {
    await window.electron.plugins?.setActiveSession(getActivePluginIds());
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin active session sync failed', { error });
  }
};

const extractPluginIdFromErrorSource = (...sources: unknown[]) => {
  const text = sources
    .filter((source) => source !== null && source !== undefined)
    .map((source) =>
      source instanceof Error ? `${source.message}\n${source.stack ?? ''}` : String(source),
    )
    .join('\n');
  return text.match(/echo-plugin:([a-zA-Z0-9._-]+)/)?.[1] ?? '';
};

const reportPluginRuntimeError = async (pluginId: string, message: string) => {
  const active = activePlugins.get(pluginId);
  if (active) updateRecord(active.descriptor, 'error', message);

  try {
    await window.electron.plugins?.reportFailure({
      pluginId,
      reason: 'runtime-error',
      message,
    });
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin runtime failure report failed', { pluginId, error });
  }
};

const installPluginRuntimeErrorHandlers = () => {
  if (runtimeErrorHandlersInstalled) return;
  runtimeErrorHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.error, event.message, event.filename);
    if (!pluginId) return;
    const message = getErrorMessage(event.error, event.message || '插件运行异常');
    void reportPluginRuntimeError(pluginId, message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.reason);
    if (!pluginId) return;
    const message = getErrorMessage(event.reason, '插件 Promise 未处理异常');
    void reportPluginRuntimeError(pluginId, message);
  });
};

const createStyleDisposer = (pluginId: string, cssText: string, styleId = 'runtime') => {
  const elementId = `echo-plugin-style-${pluginId}-${styleId}`;
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.dataset.pluginId = pluginId;
  style.textContent = cssText;
  document.head.appendChild(style);
  return () => style.remove();
};

const serializeForIpc = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

const createPluginContext = (
  descriptor: EchoPluginDescriptor,
  host: PluginRuntimeHost,
  disposables: Array<() => void>,
): EchoPluginContext => {
  const addDisposable = (dispose: () => void) => {
    disposables.push(dispose);
    return dispose;
  };
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();

  const context: EchoPluginContext = {
    id: descriptor.id,
    manifest: descriptor.manifest,
    descriptor,
    app: host.app,
    vue: Vue,
    router: host.router,
    pinia: host.pinia,
    stores: {
      player: playerStore,
      playlist: playlistStore,
      lyric: lyricStore,
      settings: settingStore,
      theme: themeStore,
    },
    player: createPlayerApi(),
    playlist: createPlaylistApi(),
    lyric: lyricStore,
    settings: settingStore,
    toast: createToastApi(),
    storage: {
      get: <T = unknown>(key: string) =>
        window.electron.plugins?.storage.get<T>(descriptor.id, key) ?? Promise.resolve(null),
      set: (key: string, value: unknown) =>
        window.electron.plugins?.storage.set(descriptor.id, key, serializeForIpc(value)) ??
        Promise.resolve(null),
      delete: (key: string) =>
        window.electron.plugins?.storage.delete(descriptor.id, key) ?? Promise.resolve(null),
    },
    dialog: {
      selectDirectory: (options) =>
        window.electron.plugins?.dialog.selectDirectory(
          serializeForIpc(options) as typeof options,
        ) ?? Promise.resolve({ canceled: true, paths: [] }),
      selectFiles: (options) =>
        window.electron.plugins?.dialog.selectFiles(serializeForIpc(options) as typeof options) ??
        Promise.resolve({ canceled: true, paths: [] }),
    },
    fs: {
      listImageFiles: (directoryPath, options) =>
        window.electron.plugins?.fs.listImageFiles(directoryPath, options) ??
        Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
      getFileUrl: (filePath) =>
        window.electron.plugins?.fs.getFileUrl(filePath) ??
        Promise.resolve({ ok: false, error: '插件文件 API 不可用' }),
    },
    ui: createRuntimeUiApi(descriptor.id, host, addDisposable),
    commands: {
      register: (id, handler, options) => {
        const dispose = registerPluginCommand(descriptor.id, {
          id,
          title: options?.title,
          handler,
        });
        return addDisposable(dispose);
      },
      execute: executePluginCommand,
    },
    css: {
      inject: (cssText, options) =>
        addDisposable(createStyleDisposer(descriptor.id, cssText, options?.id)),
    },
    events: {
      onTrackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.currentTrackSnapshot,
            (track) => handler(track),
            { deep: true },
          ),
        ),
      onPlaybackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.isPlaying,
            (isPlaying) => handler(isPlaying),
          ),
        ),
    },
    dom: createDomApi(addDisposable),
    net: {
      fetch: window.fetch.bind(window),
    },
    icons,
    electron: window.electron,
    dispose: addDisposable,
  };

  return context;
};

const resolvePluginActivator = (module: PluginModule) => {
  if (typeof module === 'function') return module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (typeof defaultExport === 'function') return defaultExport;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activate === 'function'
    ) {
      return defaultExport.activate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'activate') === 'function') {
      return (Reflect.get(module, 'activate') as (ctx: EchoPluginContext) => unknown).bind(module);
    }
  }
  return null;
};

const resolvePluginDeactivator = (active: ActivePlugin) => {
  const module = active.module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.deactivate === 'function'
    ) {
      return defaultExport.deactivate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'deactivate') === 'function') {
      return (Reflect.get(module, 'deactivate') as (ctx: EchoPluginContext) => unknown).bind(
        module,
      );
    }
  }
  return null;
};

const importPluginModule = async (descriptor: EchoPluginDescriptor, code: string) => {
  const blob = new Blob([`${code}\n//# sourceURL=echo-plugin:${descriptor.id}`], {
    type: 'text/javascript',
  });
  const url = URL.createObjectURL(blob);
  const module = (await import(/* @vite-ignore */ url)) as PluginModule;
  return { module, url };
};

const deactivatePlugin = async (pluginId: string) => {
  const active = activePlugins.get(pluginId);
  if (!active) return;

  try {
    const deactivator = resolvePluginDeactivator(active);
    if (deactivator) await deactivator(active.context);
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin deactivate failed', { pluginId, error });
  }

  for (const dispose of active.disposables.slice().reverse()) {
    try {
      dispose();
    } catch (error) {
      logger.warn('PluginRuntime', 'Plugin disposable failed', { pluginId, error });
    }
  }
  active.blobUrls.forEach((url) => URL.revokeObjectURL(url));
  removePluginContributions(pluginId);
  activePlugins.delete(pluginId);
  await syncActivePluginSession();
};

const activatePlugin = async (descriptor: EchoPluginDescriptor, host: PluginRuntimeHost) => {
  if (activePlugins.has(descriptor.id)) return;
  updateRecord(descriptor, 'loading');
  const mainAsset = await window.electron.plugins?.readAsset(descriptor.id, 'main');
  if (!mainAsset?.ok) {
    const message = mainAsset?.error || '插件入口读取失败';
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, message);
    return;
  }

  const disposables: Array<() => void> = [];
  const blobUrls: string[] = [];

  try {
    const styleAsset = descriptor.styleFile
      ? await window.electron.plugins?.readAsset(descriptor.id, 'style')
      : null;
    if (styleAsset?.ok && styleAsset.source) {
      disposables.push(createStyleDisposer(descriptor.id, styleAsset.source, 'manifest'));
    }

    const { module, url } = await importPluginModule(descriptor, mainAsset.source);
    blobUrls.push(url);
    const context = createPluginContext(descriptor, host, disposables);
    const activator = resolvePluginActivator(module);
    if (!activator) throw new Error('插件未导出 activate(ctx) 或默认函数');
    activePlugins.set(descriptor.id, { descriptor, context, module, disposables, blobUrls });
    await activator(context);
    updateRecord(descriptor, 'active');
  } catch (error) {
    await deactivatePlugin(descriptor.id);
    const message = getErrorMessage(error, '插件加载失败');
    logger.error('PluginRuntime', 'Plugin activate failed', { pluginId: descriptor.id, error });
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, message);
  }
};

export const refreshPlugins = async () => {
  pluginRuntimeState.loading = true;
  try {
    const result: PluginListResult | undefined = await window.electron.plugins?.list();
    pluginRuntimeState.directory = result?.directory ?? '';
    pluginRuntimeState.safeMode = Boolean(result?.safeMode);
    pluginRuntimeState.lastFailure = result?.lastFailure ?? null;
    const descriptors = result?.plugins ?? [];
    const nextIds = new Set(descriptors.map((plugin) => plugin.id));

    for (const pluginId of Array.from(activePlugins.keys())) {
      if (
        pluginRuntimeState.safeMode ||
        !nextIds.has(pluginId) ||
        !descriptors.find((plugin) => plugin.id === pluginId)?.enabled
      ) {
        await deactivatePlugin(pluginId);
      }
    }

    pluginRuntimeState.records = descriptors.map((descriptor) => ({
      descriptor,
      status: activePlugins.has(descriptor.id) ? 'active' : descriptor.enabled ? 'idle' : 'idle',
      error: descriptor.error,
    }));

    if (pluginRuntimeState.safeMode || !hostRef) {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
      return;
    }

    const enabledDescriptors = descriptors.filter(
      (descriptor) => descriptor.enabled && !descriptor.invalid,
    );
    if (enabledDescriptors.length === 0) {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
      return;
    }

    try {
      for (const descriptor of enabledDescriptors) {
        await window.electron.plugins?.markStartup([descriptor.id]);
        await activatePlugin(descriptor, hostRef);
      }
    } finally {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
    }
  } finally {
    pluginRuntimeState.loading = false;
  }
};

export const setRuntimePluginEnabled = async (pluginId: string, enabled: boolean) => {
  const result = await window.electron.plugins?.setEnabled(pluginId, enabled);
  if (!result?.ok) {
    throw new Error(result?.error || '插件启停失败');
  }
  await refreshPlugins();
  return result.plugin;
};

export const setRuntimePluginSafeMode = async (enabled: boolean) => {
  const result = await window.electron.plugins?.setSafeMode(enabled);
  if (!result?.ok) {
    throw new Error(result?.error || '插件安全模式切换失败');
  }
  await refreshPlugins();
  return result.safeMode;
};

export const uninstallRuntimePlugin = async (pluginId: string) => {
  await deactivatePlugin(pluginId);
  const result = await window.electron.plugins?.uninstall(pluginId);
  if (!result?.ok) {
    throw new Error(result?.error || '插件卸载失败');
  }
  await refreshPlugins();
  return result.pluginId;
};

export const openPluginDirectory = () => window.electron.plugins?.openDirectory();

export const installPluginRuntime = (host: PluginRuntimeHost) => {
  hostRef = host;
  installPluginRuntimeErrorHandlers();
  const previousErrorHandler = host.app.config.errorHandler;
  host.app.config.errorHandler = (error, instance, info) => {
    const pluginId = extractPluginIdFromErrorSource(error);
    if (pluginId) {
      const message = getErrorMessage(error, '插件 Vue 组件异常');
      logger.error('PluginRuntime', 'Plugin Vue component failed', {
        pluginId,
        info,
        error,
      });
      void reportPluginRuntimeError(pluginId, message);
      return;
    }
    previousErrorHandler?.(error, instance, info);
  };
  host.app.config.globalProperties.$echo = {
    app: host.app,
    router: host.router,
    pinia: host.pinia,
    plugins: pluginRuntimeState,
    executeCommand: executePluginCommand,
  };
  pluginRuntimeState.initialized = true;
};

export const getActivePluginIds = () => Array.from(activePlugins.keys());
