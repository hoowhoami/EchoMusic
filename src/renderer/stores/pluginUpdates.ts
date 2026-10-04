import { computed, ref } from 'vue';
import logger from '@/utils/logger';
import { useSettingStore } from './setting';
import { refreshPlugins, reloadOtherPluginRuntimes } from '@/plugins/runtime';
import { getPluginInstallErrorMessage } from '@/views/plugins/pluginInstallErrors';
import type { PluginMarketplacePlugin } from '../../shared/plugins';

export const isCheckingPluginUpdates = ref(false);
export const marketplacePlugins = ref<PluginMarketplacePlugin[]>([]);
export const busyMarketplacePluginKeys = ref(new Set<string>());
export const isUpdatingAllMarketplace = ref(false);
export const updateAllProgress = ref(0);
export const updateAllTotal = ref(0);
export const pluginUpdateJobs = ref<
  Record<
    string,
    { plugin: PluginMarketplacePlugin; status: 'running' | 'completed' | 'error'; error?: string }
  >
>({});
export const dismissedPluginUpdates = ref(new Set<string>());
export const marketplaceKey = (plugin: PluginMarketplacePlugin) =>
  `${plugin.sourceId}:${plugin.id}`;
export const updateKey = (plugin: PluginMarketplacePlugin) =>
  `${marketplaceKey(plugin)}:${plugin.version}`;
const installs = new Map<string, Promise<boolean>>();
let queue: Promise<unknown> = Promise.resolve();
let catalogRevision = 0;
let disposeStartupCheck: (() => void) | null = null;
export const getMarketplaceRevision = () => catalogRevision;

export const pluginUpdateEntries = computed(() => {
  const latestByKey = new Map(
    marketplacePlugins.value.map((plugin) => [marketplaceKey(plugin), plugin]),
  );
  const entries = new Map<
    string,
    {
      plugin: PluginMarketplacePlugin;
      status: 'pending' | 'running' | 'completed' | 'error';
      error?: string;
    }
  >();
  for (const plugin of marketplacePlugins.value) {
    if (plugin.installed && plugin.updateAvailable)
      entries.set(updateKey(plugin), { plugin, status: 'pending' });
  }
  for (const [key, job] of Object.entries(pluginUpdateJobs.value)) {
    const latest = latestByKey.get(marketplaceKey(job.plugin));
    if (job.status === 'running' || (latest?.installed && latest.version === job.plugin.version))
      entries.set(key, job);
  }
  return [...entries.entries()]
    .filter(([key]) => !dismissedPluginUpdates.value.has(key))
    .map(([, value]) => value);
});

export const acceptMarketplaceCatalog = (
  plugins: PluginMarketplacePlugin[],
  revision = catalogRevision,
) => {
  // Ignore a list response started before a completed installation.
  if (revision !== catalogRevision) return false;
  marketplacePlugins.value = plugins;
  return true;
};

export const dismissPluginUpdates = () => {
  dismissedPluginUpdates.value = new Set([
    ...dismissedPluginUpdates.value,
    ...pluginUpdateEntries.value.map(({ plugin }) => updateKey(plugin)),
  ]);
};

const snapshotMarketplacePlugin = (plugin: PluginMarketplacePlugin): PluginMarketplacePlugin => ({
  ...plugin,
  tags: [...(plugin.tags ?? [])],
  compatibility: { ...plugin.compatibility },
});

export const installMarketplaceUpdate = (target: PluginMarketplacePlugin): Promise<boolean> => {
  const plugin = snapshotMarketplacePlugin(target);
  const existing = installs.get(plugin.id);
  if (existing) return existing;
  if (!plugin.compatibility.compatible) return Promise.resolve(false);
  const key = marketplaceKey(plugin);
  const jobKey = updateKey(plugin);
  const showTask = plugin.installed;
  busyMarketplacePluginKeys.value = new Set([...busyMarketplacePluginKeys.value, key]);
  if (showTask) {
    dismissedPluginUpdates.value.delete(jobKey);
    pluginUpdateJobs.value[jobKey] = { plugin, status: 'running' };
  }
  const operation = queue.then(async () => {
    try {
      const result = await window.electron.plugins?.marketplace.install(
        plugin.sourceId,
        plugin.id,
        {
          githubProxyUrl: useSettingStore().githubProxyUrl,
          enableAfterInstall: false,
        },
      );
      if (!result?.ok) throw new Error(result?.error || '插件安装失败');
      catalogRevision += 1;
      const installedVersion = result.plugin.version;
      marketplacePlugins.value = marketplacePlugins.value.map((item) =>
        item.id === plugin.id
          ? {
              ...item,
              installed: true,
              installedVersion,
              updateAvailable: item.version === installedVersion ? false : item.updateAvailable,
            }
          : item,
      );
      // Installation is already committed. Runtime refresh failures must not offer a reinstall.
      let refreshFailed = false;
      for (const refresh of [
        () => refreshPlugins({ reloadActive: true }),
        reloadOtherPluginRuntimes,
      ]) {
        try {
          await refresh();
        } catch (error) {
          refreshFailed = true;
          logger.warn('PluginUpdates', 'Installed plugin runtime refresh failed', {
            pluginId: plugin.id,
            error,
          });
        }
      }
      if (showTask)
        pluginUpdateJobs.value[jobKey] = {
          plugin,
          status: 'completed',
          ...(refreshFailed ? { error: '插件已更新，但运行时刷新失败，请重启 EchoMusic' } : {}),
        };
      return true;
    } catch (error) {
      if (showTask)
        pluginUpdateJobs.value[jobKey] = {
          plugin,
          status: 'error',
          error: getPluginInstallErrorMessage(error),
        };
      else throw error;
      return false;
    } finally {
      const next = new Set(busyMarketplacePluginKeys.value);
      next.delete(key);
      busyMarketplacePluginKeys.value = next;
      installs.delete(plugin.id);
    }
  });
  installs.set(plugin.id, operation);
  queue = operation.catch(() => {});
  return operation;
};

export const updateMarketplaceBatch = async (plugins: PluginMarketplacePlugin[]) => {
  if (isUpdatingAllMarketplace.value) return;
  const targets = [
    ...new Map(
      plugins
        .filter((p) => p.compatibility.compatible)
        .map((p) => [p.id, snapshotMarketplacePlugin(p)]),
    ).values(),
  ];
  if (!targets.length) return;
  isUpdatingAllMarketplace.value = true;
  updateAllProgress.value = 0;
  updateAllTotal.value = targets.length;
  try {
    for (const plugin of targets) {
      try {
        await installMarketplaceUpdate(plugin);
      } catch (error) {
        // A first installation rejects for its page caller; a batch still attempts later items.
        logger.warn('PluginUpdates', 'Batch plugin installation failed', {
          pluginId: plugin.id,
          error,
        });
      }
      updateAllProgress.value += 1;
    }
  } finally {
    isUpdatingAllMarketplace.value = false;
  }
};

/** Called once from main-window startup. A failed/offline check retries on the next online event. */
export const setupStartupPluginUpdateCheck = () => {
  disposeStartupCheck?.();
  let disposed = false;
  let checked = false;
  let checking = false;
  const check = async () => {
    if (disposed || checked || checking || !navigator.onLine) return;
    checking = true;
    isCheckingPluginUpdates.value = true;
    logger.info('PluginUpdates', 'Startup update check started');
    const revision = getMarketplaceRevision();
    try {
      const result = await window.electron.plugins?.marketplace.list({
        refresh: true,
        installedOnly: true,
        githubProxyUrl: useSettingStore().githubProxyUrl,
      });
      if (!disposed && result) {
        const accepted = acceptMarketplaceCatalog(result.plugins, revision);
        checked =
          accepted &&
          result.ok &&
          !result.sources.some((source) => source.enabled && source.lastError);
        logger.info('PluginUpdates', 'Startup update check finished', {
          ok: checked,
          updates: result.plugins.filter((plugin) => plugin.installed && plugin.updateAvailable)
            .length,
        });
      }
    } catch (error) {
      if (!disposed)
        logger.warn('PluginUpdates', 'Startup update check failed; retry on reconnection', error);
    } finally {
      checking = false;
      if (!disposed) isCheckingPluginUpdates.value = false;
    }
  };
  const timer = window.setTimeout(() => void check(), 5000);
  window.addEventListener('online', check);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (disposeStartupCheck === dispose) {
      disposeStartupCheck = null;
      isCheckingPluginUpdates.value = false;
    }
    window.clearTimeout(timer);
    window.removeEventListener('online', check);
  };
  disposeStartupCheck = dispose;
  return dispose;
};
