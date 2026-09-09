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
export const getMarketplaceRevision = () => catalogRevision;

export const pluginUpdateEntries = computed(() => {
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
    const latest = marketplacePlugins.value.find(
      (plugin) => marketplaceKey(plugin) === marketplaceKey(job.plugin),
    );
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
  if (revision !== catalogRevision) return;
  marketplacePlugins.value = plugins;
};

export const dismissPluginUpdates = () => {
  dismissedPluginUpdates.value = new Set([
    ...dismissedPluginUpdates.value,
    ...pluginUpdateEntries.value.map(({ plugin }) => updateKey(plugin)),
  ]);
};

export const installMarketplaceUpdate = (plugin: PluginMarketplacePlugin): Promise<boolean> => {
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
      await refreshPlugins({ reloadActive: true });
      await reloadOtherPluginRuntimes();
      if (showTask) pluginUpdateJobs.value[jobKey] = { plugin, status: 'completed' };
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
    ...new Map(plugins.filter((p) => p.compatibility.compatible).map((p) => [p.id, p])).values(),
  ];
  if (!targets.length) return;
  isUpdatingAllMarketplace.value = true;
  updateAllProgress.value = 0;
  updateAllTotal.value = targets.length;
  try {
    for (const plugin of targets) {
      await installMarketplaceUpdate(plugin);
      updateAllProgress.value += 1;
    }
  } finally {
    isUpdatingAllMarketplace.value = false;
  }
};

/** Called once from main-window startup. A failed/offline check retries on the next online event. */
export const setupStartupPluginUpdateCheck = () => {
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
        acceptMarketplaceCatalog(result.plugins, revision);
        checked = result.ok && !result.sources.some((source) => source.enabled && source.lastError);
        logger.info('PluginUpdates', 'Startup update check finished', {
          ok: checked,
          updates: result.plugins.filter((plugin) => plugin.installed && plugin.updateAvailable)
            .length,
        });
      }
    } catch (error) {
      logger.warn('PluginUpdates', 'Startup update check failed; retry on reconnection', error);
    } finally {
      checking = false;
      if (!disposed) isCheckingPluginUpdates.value = false;
    }
  };
  const timer = window.setTimeout(() => void check(), 5000);
  window.addEventListener('online', check);
  return () => {
    disposed = true;
    isCheckingPluginUpdates.value = false;
    window.clearTimeout(timer);
    window.removeEventListener('online', check);
  };
};
