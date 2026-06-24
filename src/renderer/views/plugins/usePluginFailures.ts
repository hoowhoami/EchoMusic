import { computed, ref, type ComputedRef } from 'vue';
import {
  clearRuntimePluginFailure,
  pluginRuntimeState,
  type PluginRuntimeFailureDetail,
  type PluginRuntimeRecord,
} from '@/plugins/runtime';
import { useToastStore } from '@/stores/toast';
import type { PluginFailureRecord } from '../../../shared/plugins';

type PluginCardFailureReason = keyof typeof pluginCardFailureReasonLabels;

export interface PluginCardFailureDetail {
  pluginId: string;
  reason: PluginCardFailureReason;
  source: string;
  message: string;
  stack: string;
  createdAt: number;
  isHistorical?: boolean;
}

interface UsePluginFailuresOptions {
  records: ComputedRef<PluginRuntimeRecord[]>;
}

export const failureReasonLabels: Record<PluginFailureRecord['reason'], string> = {
  'activation-error': '插件启动失败',
  'runtime-error': '插件运行异常',
  'render-process-gone': '渲染进程异常退出',
  unresponsive: '渲染进程无响应',
};

export const pluginCardFailureReasonLabels = {
  ...failureReasonLabels,
  invalid: '插件无效',
  incompatible: '版本不兼容',
  record: '插件异常',
} as const;

export const formatFailureTime = (createdAt: number) =>
  createdAt > 0 ? new Date(createdAt).toLocaleString() : '本次扫描';

const toPluginCardRuntimeFailure = (
  failure: PluginRuntimeFailureDetail,
): PluginCardFailureDetail => ({
  pluginId: failure.pluginId,
  reason: failure.reason,
  source: failure.source,
  message: failure.message,
  stack: failure.stack,
  createdAt: failure.createdAt,
});

export const usePluginFailures = ({ records }: UsePluginFailuresOptions) => {
  const toastStore = useToastStore();
  const isClearingFailure = ref(false);
  const failureDetailPluginId = ref('');

  const failureDetailRecord = computed(
    () =>
      records.value.find((record) => record.descriptor.id === failureDetailPluginId.value) ?? null,
  );
  const showFailureDetailDialog = computed({
    get: () => Boolean(failureDetailPluginId.value),
    set: (open: boolean) => {
      if (!open) failureDetailPluginId.value = '';
    },
  });

  const failurePluginIds = computed(() => {
    const failure = pluginRuntimeState.lastFailure;
    if (!failure) return [];
    const installedIds = new Set(records.value.map((record) => record.descriptor.id));
    return Array.from(
      new Set(
        ([failure.pluginId, ...(failure.pluginIds ?? [])].filter(Boolean) as string[]).filter(
          (id) => installedIds.has(id),
        ),
      ),
    );
  });

  const globalFailure = computed(() => {
    const failure = pluginRuntimeState.lastFailure;
    if (!failure || failurePluginIds.value.length > 0) return null;
    return failure;
  });

  const failureTime = computed(() => {
    const createdAt = globalFailure.value?.createdAt;
    if (!createdAt) return '';
    return new Date(createdAt).toLocaleString();
  });
  const globalFailureTitle = computed(() =>
    globalFailure.value ? failureReasonLabels[globalFailure.value.reason] : '',
  );

  const getLastFailureForPlugin = (pluginId: string): PluginCardFailureDetail | null => {
    const failure = pluginRuntimeState.lastFailure;
    if (!failure) return null;
    const record = records.value.find((item) => item.descriptor.id === pluginId);
    if (!record) return null;
    const ids = new Set([failure.pluginId, ...(failure.pluginIds ?? [])].filter(Boolean));
    if (!ids.has(pluginId)) return null;
    return {
      pluginId,
      reason: failure.reason,
      source: pluginRuntimeState.safeMode ? '最近一次故障恢复' : '最近一次插件异常',
      message: failure.message,
      stack: '',
      createdAt: failure.createdAt,
      isHistorical: true,
    };
  };

  const getCurrentPluginCardFailure = (
    record: PluginRuntimeRecord,
  ): PluginCardFailureDetail | null => {
    const pluginId = record.descriptor.id;
    const runtimeFailure = pluginRuntimeState.failures[pluginId];
    if (runtimeFailure) return toPluginCardRuntimeFailure(runtimeFailure);

    if (record.descriptor.invalid && record.descriptor.error) {
      return {
        pluginId,
        reason: 'invalid',
        source: '插件清单',
        message: record.descriptor.error,
        stack: '',
        createdAt: 0,
      };
    }

    if (!record.descriptor.compatibility.compatible) {
      return {
        pluginId,
        reason: 'incompatible',
        source: '版本兼容性',
        message: record.descriptor.compatibility.message || '插件与当前 EchoMusic 主程序版本不兼容',
        stack: '',
        createdAt: 0,
      };
    }

    if (record.status === 'error' && record.error) {
      return {
        pluginId,
        reason: 'record',
        source: record.status === 'error' ? '当前运行状态' : '插件扫描',
        message: record.error,
        stack: '',
        createdAt: 0,
      };
    }

    return null;
  };

  const getPluginCardFailure = (record: PluginRuntimeRecord): PluginCardFailureDetail | null =>
    getCurrentPluginCardFailure(record) ?? getLastFailureForPlugin(record.descriptor.id);

  const hasPluginCardFailure = (record: PluginRuntimeRecord) =>
    Boolean(getPluginCardFailure(record));

  const hasCurrentPluginCardFailure = (record: PluginRuntimeRecord) =>
    Boolean(getCurrentPluginCardFailure(record));

  const hasHistoricalPluginCardFailure = (record: PluginRuntimeRecord) =>
    Boolean(getPluginCardFailure(record)?.isHistorical);

  const getPluginFailureButtonTitle = (record: PluginRuntimeRecord) =>
    hasHistoricalPluginCardFailure(record) ? '查看最近一次插件异常' : '查看插件异常详情';

  const activeFailureDetail = computed(() =>
    failureDetailRecord.value ? getPluginCardFailure(failureDetailRecord.value) : null,
  );

  const activeFailureTitle = computed(() => {
    const detail = activeFailureDetail.value;
    const record = failureDetailRecord.value;
    if (!detail || !record) return '插件异常详情';
    return `${record.descriptor.name} · ${pluginCardFailureReasonLabels[detail.reason]}`;
  });

  const canClearActiveFailureDetail = computed(
    () =>
      Boolean(activeFailureDetail.value) &&
      activeFailureDetail.value?.reason !== 'invalid' &&
      activeFailureDetail.value?.reason !== 'incompatible',
  );

  const openPluginFailureDetail = (pluginId: string) => {
    failureDetailPluginId.value = pluginId;
  };

  const clearActiveFailureRecord = async () => {
    const detail = activeFailureDetail.value;
    if (!detail || !canClearActiveFailureDetail.value || isClearingFailure.value) return;

    isClearingFailure.value = true;
    try {
      await clearRuntimePluginFailure(detail.pluginId);
      toastStore.actionCompleted('插件异常记录已清除');
      showFailureDetailDialog.value = false;
    } catch (error) {
      toastStore.warning(error instanceof Error ? error.message : '插件异常记录清除失败');
    } finally {
      isClearingFailure.value = false;
    }
  };

  return {
    isClearingFailure,
    pluginCardFailureReasonLabels,
    globalFailure,
    failureTime,
    globalFailureTitle,
    showFailureDetailDialog,
    activeFailureDetail,
    activeFailureTitle,
    canClearActiveFailureDetail,
    formatFailureTime,
    getCurrentPluginCardFailure,
    getPluginCardFailure,
    hasPluginCardFailure,
    hasCurrentPluginCardFailure,
    hasHistoricalPluginCardFailure,
    getPluginFailureButtonTitle,
    openPluginFailureDetail,
    clearActiveFailureRecord,
  };
};
