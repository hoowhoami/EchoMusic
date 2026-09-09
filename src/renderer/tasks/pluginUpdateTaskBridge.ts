import { watch } from 'vue';
import { iconPlugin } from '@/icons';
import { createTaskBridge } from './taskBridge';
import {
  pluginUpdateEntries,
  dismissPluginUpdates,
  installMarketplaceUpdate,
  updateMarketplaceBatch,
  isUpdatingAllMarketplace,
  updateAllProgress,
  updateAllTotal,
} from '@/stores/pluginUpdates';

export const setupPluginUpdateTaskBridge = () => {
  const task = createTaskBridge('echo:plugin-updates', 'transient');
  const stop = watch(
    [pluginUpdateEntries, isUpdatingAllMarketplace, updateAllProgress],
    () => {
      const entries = pluginUpdateEntries.value;
      if (!entries.length) {
        task.dismiss();
        return;
      }
      const running =
        isUpdatingAllMarketplace.value || entries.some((entry) => entry.status === 'running');
      const failed = entries.filter((entry) => entry.status === 'error');
      const pending = entries.filter((entry) => entry.status === 'pending');
      const available = [...pending, ...failed].filter(
        ({ plugin }) => plugin.compatibility.compatible,
      );
      task.set({
        name: '插件更新',
        icon: iconPlugin,
        status: running
          ? 'running'
          : pending.length
            ? 'pending'
            : failed.length
              ? 'error'
              : 'completed',
        progress: {
          label: running
            ? isUpdatingAllMarketplace.value
              ? `更新中 ${updateAllProgress.value}/${updateAllTotal.value}`
              : '更新中…'
            : pending.length
              ? `${pending.length} 个插件有更新`
              : failed.length
                ? `${failed.length} 个更新失败`
                : '插件已更新',
          percent: isUpdatingAllMarketplace.value
            ? (updateAllProgress.value / updateAllTotal.value) * 100
            : undefined,
        },
        items: entries.map(({ plugin, status, error }) => ({
          id: `${plugin.sourceId}:${plugin.id}:${plugin.version}`,
          name: plugin.name,
          description: `${plugin.installedVersion} → ${plugin.version}`,
          statusLabel:
            status === 'completed' ? '已更新' : status === 'running' ? '更新中…' : undefined,
          error:
            error ||
            (!plugin.compatibility.compatible
              ? plugin.compatibility.message || '需要更新 EchoMusic 后再更新此插件'
              : undefined),
          actions:
            (status === 'pending' || status === 'error') && plugin.compatibility.compatible
              ? [
                  {
                    id: 'update',
                    label: status === 'error' ? '重试' : '更新',
                    disabled: running,
                    onClick: async () => {
                      await installMarketplaceUpdate(plugin);
                    },
                  },
                ]
              : [],
        })),
        actions: running
          ? []
          : [
              ...(pending.length
                ? [{ id: 'later', label: '稍后', onClick: dismissPluginUpdates }]
                : []),
              ...(pending.length && available.length
                ? [
                    {
                      id: 'update-all',
                      label: '全部更新',
                      variant: 'primary' as const,
                      onClick: () => updateMarketplaceBatch(available.map(({ plugin }) => plugin)),
                    },
                  ]
                : []),
              ...(failed.length
                ? [
                    {
                      id: 'retry-failed',
                      label: '重试失败项',
                      onClick: () => updateMarketplaceBatch(failed.map(({ plugin }) => plugin)),
                    },
                  ]
                : []),
            ],
      });
    },
    { immediate: true, deep: true },
  );
  return () => {
    stop();
    task.dispose();
  };
};
