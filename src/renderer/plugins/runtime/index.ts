import { reactive } from 'vue';
import type {
  EchoPluginDescriptor,
  PluginFailureRecord,
  PluginListResult,
} from '../../../shared/plugins';
import { logger } from '@/utils/logger';
import { executePluginCommand, removePluginContributions } from '../registry';
import { dismissTasksByPlugin } from '../taskPanel';
import { createPluginContext, type EchoPluginContext, type PluginRuntimeHost } from './context';
import {
  importPluginModule,
  resolvePluginActivator,
  resolvePluginDeactivator,
  type PluginModule,
} from './moduleLoader';
import { refreshCurrentPlaybackState } from './playbackRefresh';
import { createStyleDisposer } from './styles';

export { pageTransitionState } from './theme';
export type {
  PluginAccentGradientDarkVariant,
  PluginAccentGradientOptions,
  PluginPageTransitionMode,
  PluginPageTransitionOptions,
  PluginSurfaceOptions,
  PluginThemeApi,
} from './theme';
export type { EchoPluginContext, PluginRuntimeHost } from './context';
export type { PluginScrollContainerQueryOptions, PluginScrollContainerState } from './runtimeUi';
export type {
  PluginCoverApi,
  PluginKugouVerificationChallenge,
  PluginKugouVerificationResult,
  PluginLyricCommand,
  PluginPlaybackQueueOptions,
  PluginPlayTrackOptions,
  PluginThemedIconCoverOptions,
} from './contextApis';

export interface PluginRuntimeRecord {
  descriptor: EchoPluginDescriptor;
  status: 'idle' | 'loading' | 'active' | 'error';
  error: string;
}

export interface PluginRuntimeFailureDetail {
  pluginId: string;
  reason: PluginFailureRecord['reason'];
  source: string;
  message: string;
  stack: string;
  createdAt: number;
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
  failures: {} as Record<string, PluginRuntimeFailureDetail>,
  loading: false,
  records: [] as PluginRuntimeRecord[],
  initialized: false,
});

const activePlugins = new Map<string, ActivePlugin>();
let hostRef: PluginRuntimeHost | null = null;
let runtimeErrorHandlersInstalled = false;

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

const getErrorStack = (error: unknown) => {
  if (error instanceof Error) return error.stack ?? '';
  return '';
};

const setRecordFailure = (pluginId: string, message: string) => {
  const record = pluginRuntimeState.records.find((item) => item.descriptor.id === pluginId);
  if (!record) return;
  record.status = 'error';
  record.error = message;
};

const getFailurePluginIds = (failure: PluginFailureRecord | null) =>
  new Set(
    [failure?.pluginId, ...(failure?.pluginIds ?? [])].filter((id): id is string => Boolean(id)),
  );

const isLastFailureForPlugin = (pluginId: string) =>
  getFailurePluginIds(pluginRuntimeState.lastFailure).has(pluginId);

const removePluginIdFromFailure = (
  failure: PluginFailureRecord | null,
  pluginId: string,
): PluginFailureRecord | null => {
  if (!failure) return null;
  const pluginIds = Array.from(getFailurePluginIds(failure));
  if (!pluginIds.includes(pluginId)) return failure;

  const remainingPluginIds = pluginIds.filter((id) => id !== pluginId);
  if (remainingPluginIds.length === 0) return null;

  return {
    pluginIds: remainingPluginIds,
    reason: failure.reason,
    message: failure.message,
    createdAt: failure.createdAt,
  };
};

const clearCurrentPluginFailure = (pluginId: string) => {
  delete pluginRuntimeState.failures[pluginId];
};

const clearRecordFailure = (pluginId: string) => {
  const record = pluginRuntimeState.records.find((item) => item.descriptor.id === pluginId);
  if (!record) return;
  record.error = '';
  if (record.status === 'error') {
    record.status = activePlugins.has(pluginId) ? 'active' : 'idle';
  }
};

const reportPluginFailure = async (
  pluginId: string,
  reason: PluginFailureRecord['reason'],
  error: unknown,
  options: {
    source: string;
    fallback: string;
  },
) => {
  const message = getErrorMessage(error, options.fallback);
  const createdAt = Date.now();
  const existing = pluginRuntimeState.failures[pluginId];
  const detail: PluginRuntimeFailureDetail = {
    pluginId,
    reason,
    source: options.source,
    message,
    stack: getErrorStack(error),
    createdAt,
  };

  pluginRuntimeState.failures[pluginId] = detail;
  pluginRuntimeState.lastFailure = {
    pluginId,
    reason,
    message,
    createdAt,
  };
  setRecordFailure(pluginId, message);

  if (
    existing?.reason === reason &&
    existing.source === options.source &&
    existing.message === message
  ) {
    return;
  }

  logger.warn('PluginRuntime', 'Plugin failure reported', {
    pluginId,
    reason,
    source: options.source,
    message,
    stack: detail.stack,
  });

  try {
    await window.electron.plugins?.reportFailure({
      pluginId,
      reason,
      message,
      createdAt,
    });
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin failure report failed', {
      pluginId,
      reason,
      error,
    });
  }
};

const reportPluginActivationFailure = (pluginId: string, error: unknown, source = '插件启动') =>
  reportPluginFailure(pluginId, 'activation-error', error, {
    source,
    fallback: '插件启动失败',
  });

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

const reportPluginRuntimeError = (
  pluginId: string,
  error: unknown,
  source = '插件运行时',
  fallback = '插件运行异常',
) =>
  reportPluginFailure(pluginId, 'runtime-error', error, {
    source,
    fallback,
  });

const runPluginCallback = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
): T => {
  try {
    const result = callback();
    if (result instanceof Promise) {
      return result.catch((error) => {
        void reportPluginRuntimeError(pluginId, error, source);
        return fallback;
      }) as T;
    }
    return result;
  } catch (error) {
    void reportPluginRuntimeError(pluginId, error, source);
    return fallback;
  }
};

const installPluginRuntimeErrorHandlers = () => {
  if (runtimeErrorHandlersInstalled) return;
  runtimeErrorHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.error, event.message, event.filename);
    if (!pluginId) return;
    void reportPluginRuntimeError(
      pluginId,
      event.error ?? event.message,
      '全局错误',
      event.message || '插件运行异常',
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.reason);
    if (!pluginId) return;
    void reportPluginRuntimeError(
      pluginId,
      event.reason,
      '未处理 Promise',
      '插件 Promise 未处理异常',
    );
  });
};

const deactivatePlugin = async (pluginId: string) => {
  const active = activePlugins.get(pluginId);
  if (!active) return;

  // 收集失败的清理函数，稍后重试
  const failedDisposables: Array<() => void> = [];

  try {
    const deactivator = resolvePluginDeactivator(active.module);
    if (deactivator) await deactivator(active.context);
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin deactivate failed', { pluginId, error });
    void reportPluginRuntimeError(pluginId, error, '插件停用');
  }

  // 按照反向顺序清理 disposables
  const disposables = active.disposables.slice().reverse();
  for (const dispose of disposables) {
    try {
      dispose();
    } catch (error) {
      logger.warn('PluginRuntime', 'Plugin disposable failed', { pluginId, error });
      failedDisposables.push(dispose);
      void reportPluginRuntimeError(pluginId, error, '插件资源清理');
    }
  }

  // 重试失败的清理
  if (failedDisposables.length > 0) {
    logger.warn('PluginRuntime', 'Retrying failed disposables', {
      pluginId,
      count: failedDisposables.length,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const dispose of failedDisposables) {
      try {
        dispose();
      } catch (error) {
        logger.error('PluginRuntime', 'Plugin disposable retry failed', { pluginId, error });
      }
    }
  }

  // 关闭插件窗口
  await Promise.allSettled(
    active.descriptor.windows.map((item) =>
      window.electron.plugins?.windows.close(active.descriptor.id, item.id),
    ),
  );

  // 先撤销 Blob URL，再删除引用
  const urls = active.blobUrls.slice();
  active.blobUrls.length = 0;
  urls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.warn('PluginRuntime', 'Blob URL revoke failed', { pluginId, url, error });
    }
  });

  removePluginContributions(pluginId);
  dismissTasksByPlugin(pluginId);

  // 延迟删除，确保所有异步清理完成
  await new Promise((resolve) => setTimeout(resolve, 50));
  activePlugins.delete(pluginId);

  await syncActivePluginSession();

  // 插件卸载后，刷新当前播放状态，避免歌曲、歌词、封面显示来自已卸载插件的数据
  refreshCurrentPlaybackState();
};

const activatePlugin = async (descriptor: EchoPluginDescriptor, host: PluginRuntimeHost) => {
  if (activePlugins.has(descriptor.id)) return;
  updateRecord(descriptor, 'loading');
  const mainAsset = await window.electron.plugins?.readAsset(descriptor.id, 'main');
  if (!mainAsset?.ok) {
    const message = mainAsset?.error || '插件入口读取失败';
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, message, '读取插件入口');
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
    const context = createPluginContext(descriptor, host, disposables, {
      runPluginCallback,
      reportPluginRuntimeError,
    });
    const activator = resolvePluginActivator(module);
    if (!activator) throw new Error('插件未导出 activate(ctx) 或默认函数');
    activePlugins.set(descriptor.id, { descriptor, context, module, disposables, blobUrls });
    await activator(context);
    clearCurrentPluginFailure(descriptor.id);
    updateRecord(descriptor, 'active');
  } catch (error) {
    await deactivatePlugin(descriptor.id);
    const message = getErrorMessage(error, '插件加载失败');
    logger.error('PluginRuntime', 'Plugin activate failed', { pluginId: descriptor.id, error });
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, error, '插件启动');
  }
};

export const refreshPlugins = async (
  options: { miniPlayer?: boolean; desktopLyric?: boolean; reloadActive?: boolean } = {},
) => {
  pluginRuntimeState.loading = true;
  try {
    const result: PluginListResult | undefined = await window.electron.plugins?.list();
    pluginRuntimeState.directory = result?.directory ?? '';
    pluginRuntimeState.safeMode = Boolean(result?.safeMode);
    pluginRuntimeState.lastFailure = result?.lastFailure ?? null;
    const descriptors = result?.plugins ?? [];
    const nextIds = new Set(descriptors.map((plugin) => plugin.id));
    const isRuntimeEligible = (descriptor: EchoPluginDescriptor) => {
      if (!descriptor.enabled || descriptor.invalid || !descriptor.compatibility.compatible) {
        return false;
      }
      if (options.miniPlayer) return descriptor.manifest.runtime?.miniPlayer === true;
      if (options.desktopLyric) return descriptor.manifest.runtime?.desktopLyric === true;
      return true;
    };

    for (const pluginId of Array.from(activePlugins.keys())) {
      const descriptor = descriptors.find((plugin) => plugin.id === pluginId);
      if (
        pluginRuntimeState.safeMode ||
        !nextIds.has(pluginId) ||
        !descriptor ||
        !isRuntimeEligible(descriptor) ||
        options.reloadActive
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

    const enabledDescriptors = descriptors.filter(isRuntimeEligible);
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

    // 插件刷新完成后，重新同步当前播放状态，避免歌曲、歌词、封面不同步
    if (!options.miniPlayer && !options.desktopLyric) {
      refreshCurrentPlaybackState();
    }
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

export const clearRuntimePluginFailure = async (pluginId: string) => {
  const shouldClearLastFailure = isLastFailureForPlugin(pluginId);
  if (shouldClearLastFailure) {
    const result = await window.electron.plugins?.clearFailure(pluginId);
    if (!result?.ok) {
      throw new Error('插件异常记录清除失败');
    }
    pluginRuntimeState.lastFailure = removePluginIdFromFailure(
      pluginRuntimeState.lastFailure,
      pluginId,
    );
  }
  clearCurrentPluginFailure(pluginId);
  clearRecordFailure(pluginId);
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

export const reloadOtherPluginRuntimes = () =>
  window.electron.plugins?.reloadRuntimes() ?? Promise.resolve();

export const onPluginRuntimeReloadRequested = (handler: () => void) =>
  window.electron.plugins?.onRuntimeReloadRequested(handler) ?? (() => {});

export const installPluginRuntime = (host: PluginRuntimeHost) => {
  hostRef = host;
  installPluginRuntimeErrorHandlers();
  const previousErrorHandler = host.app.config.errorHandler;
  host.app.config.errorHandler = (error, instance, info) => {
    const pluginId = extractPluginIdFromErrorSource(error);
    if (pluginId) {
      logger.error('PluginRuntime', 'Plugin Vue component failed', {
        pluginId,
        info,
        error,
      });
      void reportPluginRuntimeError(pluginId, error, `Vue 组件: ${info || '未知位置'}`);
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
