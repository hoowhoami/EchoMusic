import { computed, ref, type ComputedRef } from 'vue';
import { pluginRuntimeState, type PluginRuntimeRecord } from '@/plugins/runtime';
import { pluginSettingsContributions } from '@/plugins/registry';
import { useToastStore } from '@/stores/toast';

interface UsePluginSettingsDialogOptions {
  records: ComputedRef<PluginRuntimeRecord[]>;
}

export const usePluginSettingsDialog = ({ records }: UsePluginSettingsDialogOptions) => {
  const toastStore = useToastStore();
  const settingsPluginId = ref('');

  const settingsContributionByPluginId = computed(
    () =>
      new Map(
        pluginSettingsContributions.value.map((contribution) => [
          contribution.pluginId,
          contribution,
        ]),
      ),
  );
  const settingsPluginRecord = computed(
    () => records.value.find((record) => record.descriptor.id === settingsPluginId.value) ?? null,
  );
  const activeSettingsContribution = computed(() =>
    settingsPluginId.value
      ? (settingsContributionByPluginId.value.get(settingsPluginId.value) ?? null)
      : null,
  );
  const activeSettingsTitle = computed(
    () =>
      activeSettingsContribution.value?.title ||
      (settingsPluginRecord.value
        ? `${settingsPluginRecord.value.descriptor.name} 设置`
        : '插件设置'),
  );
  const activeSettingsDescription = computed(
    () =>
      activeSettingsContribution.value?.description ||
      settingsPluginRecord.value?.descriptor.description ||
      '',
  );
  const showSettingsDialog = computed({
    get: () => Boolean(settingsPluginId.value),
    set: (open: boolean) => {
      if (!open) settingsPluginId.value = '';
    },
  });

  const getSettingsContribution = (pluginId: string) =>
    settingsContributionByPluginId.value.get(pluginId) ?? null;

  const getPluginSettingsButtonTitle = (record: PluginRuntimeRecord) => {
    if (getSettingsContribution(record.descriptor.id)) return '打开插件设置';
    if (record.descriptor.invalid) return '插件无效，无法读取设置';
    if (!record.descriptor.compatibility.compatible)
      return '插件与当前主程序版本不兼容，无法加载设置';
    if (!record.descriptor.enabled) return '启用插件后可读取设置项';
    if (pluginRuntimeState.safeMode) return '安全模式下不会加载插件设置';
    if (record.status !== 'active') return '插件运行后可读取设置项';
    return '该插件没有提供设置项';
  };

  const openPluginSettings = (pluginId: string) => {
    if (getSettingsContribution(pluginId)) settingsPluginId.value = pluginId;
  };

  const requestOpenPluginSettings = (record: PluginRuntimeRecord) => {
    const pluginId = record.descriptor.id;
    if (getSettingsContribution(pluginId)) {
      openPluginSettings(pluginId);
      return;
    }

    if (record.descriptor.invalid) {
      toastStore.warning('插件无效，无法读取设置');
      return;
    }
    if (!record.descriptor.compatibility.compatible) {
      toastStore.warning(
        record.descriptor.compatibility.message || '插件与当前主程序版本不兼容，无法加载设置',
      );
      return;
    }
    if (!record.descriptor.enabled) {
      toastStore.warning('启用插件后才能读取它提供的设置项');
      return;
    }
    if (pluginRuntimeState.safeMode) {
      toastStore.warning('安全模式下不会加载插件设置');
      return;
    }
    if (record.status !== 'active') {
      toastStore.warning('插件运行后才能读取它提供的设置项');
      return;
    }
    toastStore.info('该插件没有提供设置项');
  };

  return {
    settingsPluginId,
    activeSettingsContribution,
    activeSettingsTitle,
    activeSettingsDescription,
    showSettingsDialog,
    getSettingsContribution,
    getPluginSettingsButtonTitle,
    openPluginSettings,
    requestOpenPluginSettings,
  };
};
