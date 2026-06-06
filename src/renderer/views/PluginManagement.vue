<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Slider from '@/components/ui/Slider.vue';
import Switch from '@/components/ui/Switch.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import {
  iconFolderOpen,
  iconPlugin,
  iconRefreshCw,
  iconSettings,
  iconShield,
  iconTriangleAlert,
} from '@/icons';
import {
  clearRuntimePluginFailure,
  notifyRuntimePluginSettingsChanged,
  uninstallRuntimePlugin,
  openPluginDirectory,
  pluginRuntimeState,
  refreshPlugins,
  setRuntimePluginEnabled,
  setRuntimePluginSafeMode,
  type PluginRuntimeFailureDetail,
} from '@/plugins/runtime';
import {
  pluginSettingsContributions,
  type PluginSettingField,
  type PluginSettingOption,
  type PluginSettingsContribution,
  type PluginSettingValue,
} from '@/plugins/registry';
import { useToastStore } from '@/stores/toast';
import type { PluginFailureRecord, PluginOpenDialogOptions } from '../../shared/plugins';

const toastStore = useToastStore();
const isRefreshing = ref(false);
const isSafeModeBusy = ref(false);
const isUninstalling = ref(false);
const isSettingsLoading = ref(false);
const isSettingsSaving = ref(false);
const isClearingFailure = ref(false);
const pendingUninstallPluginId = ref('');
const settingsPluginId = ref('');
const failureDetailPluginId = ref('');
const settingsDraft = ref<Record<string, PluginSettingValue>>({});
const busyPluginIds = ref<Set<string>>(new Set());
const failedPluginImageIds = ref<Set<string>>(new Set());
const pluginSettingsStorageKey = 'settings';

const records = computed(() => pluginRuntimeState.records);
const pluginCountLabel = computed(() => {
  const total = records.value.length;
  const enabled = records.value.filter((record) => record.descriptor.enabled).length;
  return `${enabled}/${total} 个已启用`;
});
const pendingUninstallRecord = computed(
  () =>
    records.value.find((record) => record.descriptor.id === pendingUninstallPluginId.value) ?? null,
);
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
const failureDetailRecord = computed(
  () =>
    records.value.find((record) => record.descriptor.id === failureDetailPluginId.value) ?? null,
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
const showUninstallDialog = computed({
  get: () => Boolean(pendingUninstallPluginId.value),
  set: (open: boolean) => {
    if (!open && !isUninstalling.value) pendingUninstallPluginId.value = '';
  },
});
const showSettingsDialog = computed({
  get: () => Boolean(settingsPluginId.value),
  set: (open: boolean) => {
    if (!open && !isSettingsSaving.value) {
      settingsPluginId.value = '';
      settingsDraft.value = {};
    }
  },
});
const showFailureDetailDialog = computed({
  get: () => Boolean(failureDetailPluginId.value),
  set: (open: boolean) => {
    if (!open) failureDetailPluginId.value = '';
  },
});

const failureReasonLabels: Record<PluginFailureRecord['reason'], string> = {
  'activation-error': '插件启动失败',
  'runtime-error': '插件运行异常',
  'render-process-gone': '渲染进程异常退出',
  unresponsive: '渲染进程无响应',
};
const pluginCardFailureReasonLabels = {
  ...failureReasonLabels,
  invalid: '插件无效',
  record: '插件异常',
} as const;

type PluginCardFailureReason = keyof typeof pluginCardFailureReasonLabels;

interface PluginCardFailureDetail {
  pluginId: string;
  reason: PluginCardFailureReason;
  source: string;
  message: string;
  stack: string;
  createdAt: number;
  isHistorical?: boolean;
}

const failurePluginIds = computed(() => {
  const failure = pluginRuntimeState.lastFailure;
  if (!failure) return [];
  const installedIds = new Set(records.value.map((record) => record.descriptor.id));
  return Array.from(
    new Set(
      ([failure.pluginId, ...(failure.pluginIds ?? [])].filter(Boolean) as string[]).filter((id) =>
        installedIds.has(id),
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

const refresh = async () => {
  if (isRefreshing.value) return;
  isRefreshing.value = true;
  try {
    await refreshPlugins();
    toastStore.actionCompleted('插件已刷新');
  } catch {
    toastStore.actionFailed('刷新插件');
  } finally {
    isRefreshing.value = false;
  }
};

const openDirectory = async () => {
  try {
    await openPluginDirectory();
  } catch {
    toastStore.actionFailed('打开插件目录');
  }
};

const togglePlugin = async (pluginId: string, enabled: boolean) => {
  const next = new Set(busyPluginIds.value);
  next.add(pluginId);
  busyPluginIds.value = next;
  try {
    await setRuntimePluginEnabled(pluginId, enabled);
    toastStore.actionCompleted(enabled ? '插件已启用' : '插件已禁用');
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件启停失败');
  } finally {
    const done = new Set(busyPluginIds.value);
    done.delete(pluginId);
    busyPluginIds.value = done;
  }
};

const toggleSafeMode = async (enabled: boolean) => {
  if (isSafeModeBusy.value) return;
  isSafeModeBusy.value = true;
  try {
    await setRuntimePluginSafeMode(enabled);
    toastStore.actionCompleted(enabled ? '插件安全模式已开启' : '插件安全模式已关闭');
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件安全模式切换失败');
  } finally {
    isSafeModeBusy.value = false;
  }
};

const requestUninstallPlugin = (pluginId: string) => {
  pendingUninstallPluginId.value = pluginId;
};

const confirmUninstallPlugin = async () => {
  const target = pendingUninstallRecord.value;
  if (!target || isUninstalling.value) return;
  const pluginId = target.descriptor.id;
  const next = new Set(busyPluginIds.value);
  next.add(pluginId);
  busyPluginIds.value = next;
  isUninstalling.value = true;
  try {
    await uninstallRuntimePlugin(pluginId);
    toastStore.actionCompleted('插件已卸载');
    pendingUninstallPluginId.value = '';
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件卸载失败');
  } finally {
    const done = new Set(busyPluginIds.value);
    done.delete(pluginId);
    busyPluginIds.value = done;
    isUninstalling.value = false;
  }
};

const getStatusLabel = (record: (typeof records.value)[number]) => {
  if (record.descriptor.invalid) return '无效';
  if (getCurrentPluginCardFailure(record)) return record.status === 'error' ? '出错' : '异常';
  if (!record.descriptor.enabled) return '已停用';
  if (pluginRuntimeState.safeMode && record.descriptor.enabled) return '安全模式';
  if (record.status === 'active') return '运行中';
  if (record.status === 'loading') return '加载中';
  if (record.status === 'error') return '出错';
  return '未运行';
};

const pluginAccentPalette = ['#1a73e8', '#0f9d58', '#f29900', '#d93025', '#7b1fa2', '#00897b'];

const getPluginInitial = (record: (typeof records.value)[number]) => {
  const source = record.descriptor.name || record.descriptor.id || 'E';
  return Array.from(source.trim())[0]?.toUpperCase() ?? 'E';
};

const getPluginImageUrl = (record: (typeof records.value)[number]) => {
  if (failedPluginImageIds.value.has(record.descriptor.id)) return '';
  return record.descriptor.imageUrl || '';
};

const markPluginImageFailed = (pluginId: string) => {
  const next = new Set(failedPluginImageIds.value);
  next.add(pluginId);
  failedPluginImageIds.value = next;
};

const getPluginAccentStyle = (pluginId: string) => {
  const hash = Array.from(pluginId).reduce((total, char) => total + char.charCodeAt(0), 0);
  return {
    '--plugin-accent': pluginAccentPalette[hash % pluginAccentPalette.length],
  };
};

const formatFailureTime = (createdAt: number) =>
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
  record: (typeof records.value)[number],
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

const getPluginCardFailure = (
  record: (typeof records.value)[number],
): PluginCardFailureDetail | null =>
  getCurrentPluginCardFailure(record) ?? getLastFailureForPlugin(record.descriptor.id);

const hasPluginCardFailure = (record: (typeof records.value)[number]) =>
  Boolean(getPluginCardFailure(record));

const hasCurrentPluginCardFailure = (record: (typeof records.value)[number]) =>
  Boolean(getCurrentPluginCardFailure(record));

const hasHistoricalPluginCardFailure = (record: (typeof records.value)[number]) =>
  Boolean(getPluginCardFailure(record)?.isHistorical);

const getPluginFailureButtonTitle = (record: (typeof records.value)[number]) =>
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
  () => Boolean(activeFailureDetail.value) && activeFailureDetail.value?.reason !== 'invalid',
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

const getSettingsContribution = (pluginId: string) =>
  settingsContributionByPluginId.value.get(pluginId) ?? null;

const getPluginSettingsButtonTitle = (record: (typeof records.value)[number]) => {
  if (getSettingsContribution(record.descriptor.id)) return '打开插件设置';
  if (record.descriptor.invalid) return '插件无效，无法读取设置';
  if (!record.descriptor.enabled) return '启用插件后可读取设置项';
  if (pluginRuntimeState.safeMode) return '安全模式下不会加载插件设置';
  if (record.status !== 'active') return '插件运行后可读取设置项';
  return '该插件没有提供设置项';
};

const requestOpenPluginSettings = async (record: (typeof records.value)[number]) => {
  const pluginId = record.descriptor.id;
  if (getSettingsContribution(pluginId)) {
    try {
      await openPluginSettings(pluginId);
    } catch (error) {
      toastStore.warning(error instanceof Error ? error.message : '插件设置打开失败');
    }
    return;
  }

  if (record.descriptor.invalid) {
    toastStore.warning('插件无效，无法读取设置');
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

const cloneSettingValue = (value: PluginSettingValue): PluginSettingValue =>
  Array.isArray(value) ? [...value] : value;

const getFallbackSettingValue = (field: PluginSettingField): PluginSettingValue => {
  if (field.default !== null && field.default !== undefined)
    return cloneSettingValue(field.default);
  if (field.type === 'switch') return false;
  if (field.type === 'number' || field.type === 'slider') return field.min ?? 0;
  if (field.type === 'file') return field.multiple ? [] : '';
  if (field.type === 'select') return field.options?.[0]?.value ?? '';
  return '';
};

const getSettingsFields = (contribution: PluginSettingsContribution) =>
  contribution.sections.flatMap((section) => section.fields);

const coerceSettingValue = (
  field: PluginSettingField,
  value: unknown,
  fallback = getFallbackSettingValue(field),
): PluginSettingValue => {
  if (field.type === 'switch') return Boolean(value);

  if (field.type === 'number' || field.type === 'slider') {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    const min = field.min ?? -Infinity;
    const max = field.max ?? Infinity;
    return Math.max(min, Math.min(max, next));
  }

  if (field.type === 'file') {
    if (field.multiple) {
      return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
    }
    return typeof value === 'string' ? value : '';
  }

  if (field.type === 'directory' || field.type === 'text' || field.type === 'textarea') {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  }

  if (field.type === 'select') {
    const matched = field.options?.find(
      (option) => Object.is(option.value, value) || String(option.value) === String(value ?? ''),
    );
    return matched?.value ?? fallback;
  }

  return fallback;
};

const buildDefaultSettings = (contribution: PluginSettingsContribution) =>
  Object.fromEntries(
    getSettingsFields(contribution).map((field) => [field.key, getFallbackSettingValue(field)]),
  ) as Record<string, PluginSettingValue>;

const buildSettingsDraft = (
  contribution: PluginSettingsContribution,
  saved: Record<string, unknown> | null,
) => {
  const defaults = buildDefaultSettings(contribution);
  for (const field of getSettingsFields(contribution)) {
    if (!saved || !Object.hasOwn(saved, field.key)) continue;
    defaults[field.key] = coerceSettingValue(field, saved[field.key], defaults[field.key]);
  }
  return defaults;
};

const getSerializableSettingsDraft = (contribution: PluginSettingsContribution) => {
  const result = buildDefaultSettings(contribution);
  for (const field of getSettingsFields(contribution)) {
    result[field.key] = coerceSettingValue(
      field,
      settingsDraft.value[field.key],
      result[field.key],
    );
  }
  return result;
};

const openPluginSettings = async (pluginId: string) => {
  const contribution = getSettingsContribution(pluginId);
  if (!contribution || isSettingsLoading.value) return;

  settingsPluginId.value = pluginId;
  isSettingsLoading.value = true;
  try {
    const saved =
      (await window.electron.plugins?.storage.get<Record<string, unknown>>(
        pluginId,
        pluginSettingsStorageKey,
      )) ?? null;
    settingsDraft.value = buildSettingsDraft(contribution, saved);
  } catch {
    settingsDraft.value = buildSettingsDraft(contribution, null);
    toastStore.actionFailed('读取插件设置');
  } finally {
    isSettingsLoading.value = false;
  }
};

const updateSettingDraft = (field: PluginSettingField, value: unknown) => {
  settingsDraft.value = {
    ...settingsDraft.value,
    [field.key]: coerceSettingValue(field, value),
  };
};

const updateTextField = (field: PluginSettingField, event: Event) => {
  updateSettingDraft(field, (event.target as HTMLInputElement | HTMLTextAreaElement).value);
};

const updateNumberField = (field: PluginSettingField, event: Event) => {
  updateSettingDraft(field, (event.target as HTMLInputElement).value);
};

const resetSettingsDraft = () => {
  const contribution = activeSettingsContribution.value;
  if (!contribution) return;
  settingsDraft.value = buildDefaultSettings(contribution);
};

const savePluginSettings = async () => {
  const pluginId = settingsPluginId.value;
  const contribution = activeSettingsContribution.value;
  if (!pluginId || !contribution || isSettingsSaving.value) return;

  isSettingsSaving.value = true;
  const nextSettings = getSerializableSettingsDraft(contribution);
  try {
    const result = await window.electron.plugins?.storage.set(
      pluginId,
      pluginSettingsStorageKey,
      nextSettings,
    );
    if (result && !result.ok) throw new Error('插件设置保存失败');
    await notifyRuntimePluginSettingsChanged(pluginId, nextSettings);
    settingsDraft.value = nextSettings;
    toastStore.actionCompleted('插件设置已保存');
    showSettingsDialog.value = false;
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件设置保存失败');
  } finally {
    isSettingsSaving.value = false;
  }
};

const getFieldStringValue = (field: PluginSettingField) =>
  String(settingsDraft.value[field.key] ?? '');

const getFieldNumberValue = (field: PluginSettingField) => {
  const value = Number(settingsDraft.value[field.key]);
  if (Number.isFinite(value)) return value;
  const fallback = getFallbackSettingValue(field);
  return typeof fallback === 'number' ? fallback : (field.min ?? 0);
};

const getSelectOptionKey = (option: PluginSettingOption, index: number) =>
  `${index}:${typeof option.value}:${String(option.value)}`;

const getSelectedOptionKey = (field: PluginSettingField) => {
  const value = settingsDraft.value[field.key];
  const index =
    field.options?.findIndex(
      (option) => Object.is(option.value, value) || String(option.value) === String(value ?? ''),
    ) ?? -1;
  if (index < 0 || !field.options) return '';
  return getSelectOptionKey(field.options[index], index);
};

const updateSelectField = (field: PluginSettingField, event: Event) => {
  const optionIndex = Number((event.target as HTMLSelectElement).value.split(':')[0]);
  const option = field.options?.[optionIndex];
  if (!option) return;
  updateSettingDraft(field, option.value);
};

const getPathValues = (field: PluginSettingField) => {
  const value = settingsDraft.value[field.key];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
};

const getPathLabel = (field: PluginSettingField) => {
  const values = getPathValues(field);
  if (values.length === 0) return field.type === 'directory' ? '未选择文件夹' : '未选择文件';
  if (field.multiple) return `已选择 ${values.length} 个文件`;
  return values[0];
};

const clearPathField = (field: PluginSettingField) => {
  updateSettingDraft(field, field.multiple ? [] : '');
};

const buildPathDialogOptions = (field: PluginSettingField): PluginOpenDialogOptions => ({
  title: String(field.label ?? ''),
  buttonLabel: '选择',
  multiple: Boolean(field.multiple),
  filters: Array.isArray(field.filters)
    ? field.filters.map((filter) => ({
        name: String(filter?.name || 'Files'),
        extensions: Array.isArray(filter?.extensions)
          ? filter.extensions.map((extension) => String(extension).replace(/^\./, ''))
          : ['*'],
      }))
    : undefined,
});

const selectPathForField = async (field: PluginSettingField) => {
  try {
    const options = buildPathDialogOptions(field);
    const result =
      field.type === 'directory'
        ? await window.electron.plugins?.dialog.selectDirectory(options)
        : await window.electron.plugins?.dialog.selectFiles(options);
    if (!result || result.canceled || result.paths.length === 0) return;
    updateSettingDraft(field, field.multiple ? result.paths : result.paths[0]);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '选择路径失败');
  }
};
</script>

<template>
  <div class="plugin-management-page h-full flex flex-col min-h-0">
    <!-- 页面头部 -->
    <header class="plugin-header shrink-0 px-6 pt-4 pb-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="plugin-header-icon">
            <Icon :icon="iconPlugin" width="20" height="20" />
          </div>
          <div>
            <h1 class="text-lg font-bold text-text-main">插件管理</h1>
            <p class="text-xs text-text-secondary mt-0.5">
              {{ pluginRuntimeState.directory || '插件目录尚未初始化' }}
            </p>
          </div>
        </div>

        <!-- 右上角操作区 -->
        <div class="flex items-center gap-3">
          <!-- 安全模式 -->
          <div class="plugin-safe-mode-control">
            <Icon :icon="iconShield" width="14" height="14" class="text-primary" />
            <span class="text-xs font-medium text-text-main">安全模式</span>
            <Switch
              :model-value="pluginRuntimeState.safeMode"
              :disabled="isSafeModeBusy || pluginRuntimeState.loading"
              @update:model-value="toggleSafeMode"
            />
          </div>

          <!-- 打开目录 -->
          <Button variant="ghost" size="sm" @click="openDirectory" class="h-8">
            <Icon :icon="iconFolderOpen" width="16" height="16" />
          </Button>

          <!-- 刷新 -->
          <Button variant="ghost" size="sm" :disabled="isRefreshing" @click="refresh" class="h-8">
            <Icon
              :icon="iconRefreshCw"
              width="16"
              height="16"
              :class="isRefreshing ? 'animate-spin' : ''"
            />
          </Button>
        </div>
      </div>

      <!-- 错误提示 -->
      <div v-if="globalFailure" class="plugin-failure-card mt-3">
        <div class="plugin-failure-icon">
          <Icon :icon="iconTriangleAlert" width="16" height="16" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="plugin-failure-title">
            {{ globalFailureTitle }}
          </div>
          <div class="plugin-failure-meta">
            无法定位到具体插件
            <span v-if="failureTime"> · {{ failureTime }}</span>
          </div>
          <div class="plugin-failure-message">
            {{ globalFailure.message }}
          </div>
        </div>
      </div>
    </header>

    <!-- 插件列表 -->
    <Scrollbar class="flex-1 min-h-0">
      <div class="plugin-content px-6 pb-6">
        <!-- 空状态 -->
        <div v-if="records.length === 0" class="plugin-empty-state">
          <Icon :icon="iconPlugin" width="48" height="48" class="text-text-main/20" />
          <p class="text-text-main/60 mt-4 font-medium">暂无插件</p>
          <p class="text-text-secondary text-sm mt-2">将插件文件夹放入上方目录后点击刷新</p>
        </div>

        <template v-else>
          <div class="plugin-content-heading">
            <h2>已安装插件</h2>
            <span>{{ pluginCountLabel }}</span>
          </div>

          <div class="plugin-card-grid">
            <article
              v-for="record in records"
              :key="record.descriptor.id"
              class="plugin-card"
              :class="{
                'is-disabled': !record.descriptor.enabled || record.descriptor.invalid,
                'is-error': hasCurrentPluginCardFailure(record),
              }"
            >
              <div class="plugin-card-main">
                <div class="plugin-card-media" :style="getPluginAccentStyle(record.descriptor.id)">
                  <img
                    v-if="getPluginImageUrl(record)"
                    :src="getPluginImageUrl(record)"
                    :alt="record.descriptor.name"
                    class="plugin-card-image"
                    @error="markPluginImageFailed(record.descriptor.id)"
                  />
                  <span v-else class="plugin-card-initial">
                    {{ getPluginInitial(record) }}
                  </span>
                </div>

                <div class="plugin-card-summary">
                  <div class="plugin-card-header">
                    <h3 class="plugin-card-name" :title="record.descriptor.name">
                      {{ record.descriptor.name }}
                    </h3>
                    <span
                      class="plugin-status-badge"
                      :class="{
                        'is-active':
                          record.status === 'active' && !hasCurrentPluginCardFailure(record),
                        'is-error': hasCurrentPluginCardFailure(record),
                        'is-safe':
                          pluginRuntimeState.safeMode &&
                          record.descriptor.enabled &&
                          !hasCurrentPluginCardFailure(record),
                      }"
                    >
                      {{ getStatusLabel(record) }}
                    </span>
                  </div>

                  <div class="plugin-card-meta">
                    <span>v{{ record.descriptor.version }}</span>
                    <span v-if="record.descriptor.manifest.author">
                      · {{ record.descriptor.manifest.author }}
                    </span>
                  </div>
                </div>
              </div>

              <p class="plugin-card-description">
                {{ record.descriptor.description || '暂无描述' }}
              </p>

              <div class="plugin-card-id" :title="record.descriptor.id">
                ID: {{ record.descriptor.id }}
              </div>

              <div class="plugin-card-actions">
                <div class="plugin-card-action-group">
                  <div class="plugin-card-primary-actions">
                    <Button
                      variant="ghost"
                      size="xs"
                      class="plugin-settings-btn"
                      :class="{
                        'is-unavailable': !getSettingsContribution(record.descriptor.id),
                      }"
                      :title="getPluginSettingsButtonTitle(record)"
                      :disabled="busyPluginIds.has(record.descriptor.id)"
                      @click="requestOpenPluginSettings(record)"
                    >
                      <Icon :icon="iconSettings" width="14" height="14" />
                      设置
                    </Button>

                    <Button
                      variant="ghost"
                      size="xs"
                      class="plugin-remove-btn"
                      :disabled="busyPluginIds.has(record.descriptor.id)"
                      @click="requestUninstallPlugin(record.descriptor.id)"
                    >
                      移除
                    </Button>
                  </div>

                  <button
                    v-if="hasPluginCardFailure(record)"
                    class="plugin-card-failure-btn"
                    :class="{ 'is-historical': hasHistoricalPluginCardFailure(record) }"
                    type="button"
                    :title="getPluginFailureButtonTitle(record)"
                    @click="openPluginFailureDetail(record.descriptor.id)"
                  >
                    <Icon :icon="iconTriangleAlert" width="14" height="14" />
                  </button>
                </div>

                <Switch
                  :model-value="record.descriptor.enabled"
                  :disabled="record.descriptor.invalid || busyPluginIds.has(record.descriptor.id)"
                  @update:model-value="(value) => togglePlugin(record.descriptor.id, value)"
                />
              </div>
            </article>
          </div>
        </template>
      </div>
    </Scrollbar>

    <!-- 卸载对话框 -->
    <Dialog
      v-model:open="showUninstallDialog"
      title="卸载插件"
      :description="
        pendingUninstallRecord
          ? `确定卸载 ${pendingUninstallRecord.descriptor.name}？插件目录会被删除。`
          : '确定卸载该插件？'
      "
    >
      <template #footer>
        <Button
          variant="ghost"
          size="xs"
          :disabled="isUninstalling"
          @click="showUninstallDialog = false"
        >
          取消
        </Button>
        <Button
          variant="danger"
          size="xs"
          :loading="isUninstalling"
          @click="confirmUninstallPlugin"
        >
          卸载
        </Button>
      </template>
    </Dialog>

    <!-- 插件异常详情 -->
    <Dialog
      v-model:open="showFailureDetailDialog"
      :title="activeFailureTitle"
      show-close
      content-class="plugin-failure-detail-dialog"
      body-class="plugin-failure-detail-body"
    >
      <div v-if="activeFailureDetail" class="plugin-failure-detail">
        <div class="plugin-failure-detail-grid">
          <span>类型</span>
          <strong>{{ pluginCardFailureReasonLabels[activeFailureDetail.reason] }}</strong>
          <span>位置</span>
          <strong>{{ activeFailureDetail.source }}</strong>
          <span>时间</span>
          <strong>{{ formatFailureTime(activeFailureDetail.createdAt) }}</strong>
        </div>

        <div class="plugin-failure-detail-block">
          <h4>错误信息</h4>
          <p>{{ activeFailureDetail.message }}</p>
        </div>

        <div v-if="activeFailureDetail.stack" class="plugin-failure-detail-block">
          <h4>调用栈</h4>
          <pre>{{ activeFailureDetail.stack }}</pre>
        </div>
      </div>

      <template #footer>
        <div class="plugin-failure-detail-footer">
          <Button
            v-if="canClearActiveFailureDetail"
            variant="ghost"
            size="xs"
            :loading="isClearingFailure"
            @click="clearActiveFailureRecord"
          >
            清除记录
          </Button>
          <Button
            variant="ghost"
            size="xs"
            :disabled="isClearingFailure"
            @click="showFailureDetailDialog = false"
          >
            关闭
          </Button>
        </div>
      </template>
    </Dialog>

    <!-- 插件统一设置 -->
    <Dialog
      v-model:open="showSettingsDialog"
      :title="activeSettingsTitle"
      :description="activeSettingsDescription"
      show-close
      content-class="plugin-settings-dialog"
      body-class="plugin-settings-dialog-body"
      :close-on-escape="!isSettingsSaving"
      :close-on-interact-outside="!isSettingsSaving"
    >
      <div v-if="isSettingsLoading" class="plugin-settings-loading">正在读取设置...</div>

      <div v-else-if="activeSettingsContribution" class="plugin-settings-content">
        <section
          v-for="section in activeSettingsContribution.sections"
          :key="section.id"
          class="plugin-settings-section"
        >
          <div v-if="section.title || section.description" class="plugin-settings-section-header">
            <h4 v-if="section.title">{{ section.title }}</h4>
            <p v-if="section.description">{{ section.description }}</p>
          </div>

          <div class="plugin-settings-fields">
            <div
              v-for="field in section.fields"
              :key="field.key"
              class="plugin-settings-field"
              :class="{
                'is-toggle': field.type === 'switch',
                'is-wide': field.type === 'textarea' || field.type === 'file',
              }"
            >
              <div class="plugin-settings-field-copy">
                <label :for="`plugin-setting-${field.key}`">{{ field.label }}</label>
                <p v-if="field.description">{{ field.description }}</p>
              </div>

              <div class="plugin-settings-field-control">
                <Switch
                  v-if="field.type === 'switch'"
                  :model-value="Boolean(settingsDraft[field.key])"
                  @update:model-value="(value) => updateSettingDraft(field, value)"
                />

                <textarea
                  v-else-if="field.type === 'textarea'"
                  :id="`plugin-setting-${field.key}`"
                  class="plugin-settings-textarea"
                  :value="getFieldStringValue(field)"
                  :placeholder="field.placeholder"
                  @input="(event) => updateTextField(field, event)"
                ></textarea>

                <input
                  v-else-if="field.type === 'text'"
                  :id="`plugin-setting-${field.key}`"
                  class="plugin-settings-input"
                  type="text"
                  :value="getFieldStringValue(field)"
                  :placeholder="field.placeholder"
                  @input="(event) => updateTextField(field, event)"
                />

                <input
                  v-else-if="field.type === 'number'"
                  :id="`plugin-setting-${field.key}`"
                  class="plugin-settings-input"
                  type="number"
                  :value="getFieldNumberValue(field)"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step ?? 1"
                  @input="(event) => updateNumberField(field, event)"
                />

                <Slider
                  v-else-if="field.type === 'slider'"
                  :model-value="getFieldNumberValue(field)"
                  :min="field.min ?? 0"
                  :max="field.max ?? 100"
                  :step="field.step ?? 1"
                  show-value
                  :value-suffix="field.unit ?? ''"
                  class="plugin-settings-slider"
                  @update:model-value="(value) => updateSettingDraft(field, value)"
                />

                <select
                  v-else-if="field.type === 'select'"
                  :id="`plugin-setting-${field.key}`"
                  class="plugin-settings-select"
                  :value="getSelectedOptionKey(field)"
                  @change="(event) => updateSelectField(field, event)"
                >
                  <option
                    v-for="(option, index) in field.options ?? []"
                    :key="getSelectOptionKey(option, index)"
                    :value="getSelectOptionKey(option, index)"
                  >
                    {{ option.label }}
                  </option>
                </select>

                <div
                  v-else-if="field.type === 'file' || field.type === 'directory'"
                  class="plugin-settings-path-control"
                >
                  <div class="plugin-settings-path-value" :title="getPathValues(field).join('\n')">
                    {{ getPathLabel(field) }}
                  </div>
                  <div class="plugin-settings-path-actions">
                    <Button variant="outline" size="xs" @click="selectPathForField(field)">
                      <Icon :icon="iconFolderOpen" width="14" height="14" />
                      选择
                    </Button>
                    <Button
                      v-if="getPathValues(field).length > 0"
                      variant="ghost"
                      size="xs"
                      @click="clearPathField(field)"
                    >
                      清除
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <template #footer>
        <Button variant="ghost" size="xs" :disabled="isSettingsSaving" @click="resetSettingsDraft">
          恢复默认
        </Button>
        <div class="plugin-settings-footer-actions">
          <Button
            variant="ghost"
            size="xs"
            :disabled="isSettingsSaving"
            @click="showSettingsDialog = false"
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="xs"
            :loading="isSettingsSaving"
            @click="savePluginSettings"
          >
            保存
          </Button>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.plugin-management-page {
  background: var(--color-bg-main);
}

/* 页面头部 - 与 Settings 保持一致 */
.plugin-header {
  border-bottom: 1px solid var(--border-subtle);
}

.plugin-header-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--color-primary);
  color: white;
}

.plugin-safe-mode-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 8px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  color: var(--color-text-main);
}

.plugin-content {
  padding-top: 1.25rem;
}

.plugin-empty-state {
  @apply py-16 text-center flex flex-col items-center justify-center;
}

.plugin-content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.875rem;
}

.plugin-content-heading h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-text-main);
}

.plugin-content-heading span {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.plugin-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 0.875rem;
}

.plugin-card {
  min-height: 212px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.plugin-card:hover {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--control-border));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--color-text-main) 6%, transparent);
  transform: translateY(-1px);
}

.plugin-card.is-disabled {
  opacity: 0.72;
}

.plugin-card.is-error {
  border-color: color-mix(in srgb, var(--state-danger) 30%, var(--border-subtle));
  background: var(--state-danger-bg-soft);
}

.plugin-card-main {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  min-width: 0;
}

.plugin-card-media {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--plugin-accent) 18%, transparent),
      color-mix(in srgb, var(--plugin-accent) 7%, transparent)
    ),
    var(--color-bg-main);
  border: 1px solid color-mix(in srgb, var(--plugin-accent) 18%, var(--border-subtle));
  flex-shrink: 0;
  overflow: hidden;
}

.plugin-card-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.plugin-card-initial {
  color: var(--plugin-accent);
  font-size: 1.35rem;
  font-weight: 800;
  line-height: 1;
}

.plugin-card-summary {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.plugin-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
}

.plugin-card-name {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-text-main);
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-card-failure-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  color: var(--color-red-500);
  background: var(--state-danger-bg-soft);
  flex-shrink: 0;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease,
    transform 0.16s ease;
}

.plugin-card-failure-btn:hover {
  color: white;
  background: var(--color-red-500);
  transform: translateY(-1px);
}

.plugin-card-failure-btn.is-historical {
  color: var(--state-warning);
  background: var(--state-warning-bg-soft);
}

.plugin-card-failure-btn.is-historical:hover {
  color: white;
  background: var(--state-warning);
}

.plugin-status-badge {
  @apply rounded-full px-2 py-0.5 text-[10px] font-semibold text-text-secondary bg-text-secondary/10 shrink-0;
  line-height: 1.35;
}

.plugin-status-badge.is-active {
  @apply text-primary bg-primary/10;
}

.plugin-status-badge.is-error {
  @apply text-red-500 bg-red-500/10;
}

.plugin-status-badge.is-safe {
  @apply text-amber-500 bg-amber-500/10;
}

.plugin-card-description {
  min-height: 42px;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  line-height: 1.6;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.plugin-card-meta {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-card-id {
  margin-top: auto;
  font-size: 0.6875rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-secondary) 82%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-card-error {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-red-500);
  padding: 0.5rem;
  background: var(--state-danger-bg-soft);
  border-radius: 8px;
}

.plugin-card-error span {
  min-width: 0;
  word-break: break-word;
}

.plugin-card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 33px;
  margin-top: 0.125rem;
  padding-top: 0.875rem;
  border-top: 1px solid var(--border-subtle);
}

.plugin-card-action-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.plugin-card-primary-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}

.plugin-settings-btn {
  @apply text-text-main hover:text-primary;
  gap: 0.25rem;
}

.plugin-settings-btn.is-unavailable {
  color: color-mix(in srgb, var(--color-text-secondary) 78%, transparent);
}

.plugin-remove-btn {
  @apply text-primary hover:text-primary-hover;
}

.plugin-card.is-error .plugin-remove-btn {
  @apply text-red-500 hover:text-red-400;
}

:global(.plugin-failure-detail-dialog) {
  width: min(560px, 92vw);
}

:global(.plugin-failure-detail-body) {
  padding-right: 1.125rem;
}

.plugin-failure-detail {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.plugin-failure-detail-grid {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 0.5rem 0.875rem;
  padding: 0.875rem;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--control-muted-bg);
}

.plugin-failure-detail-grid span {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.plugin-failure-detail-grid strong {
  min-width: 0;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-text-main);
  word-break: break-word;
}

.plugin-failure-detail-block {
  padding: 0.875rem;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--control-muted-bg);
}

.plugin-failure-detail-block h4 {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 800;
  color: var(--color-text-main);
}

.plugin-failure-detail-block p,
.plugin-failure-detail-block pre {
  margin: 0;
  color: var(--color-text-secondary);
}

.plugin-failure-detail-block p {
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.plugin-failure-detail-block pre {
  max-height: 220px;
  overflow: auto;
  font-size: 0.6875rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.plugin-failure-detail-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
}

:global(.dialog-content.plugin-settings-dialog) {
  width: min(640px, 92vw);
  max-height: min(760px, calc(100vh - 120px));
  --plugin-settings-dialog-bg: color-mix(in srgb, var(--surface-dialog-base) 96%, transparent);
  --plugin-settings-panel-bg: color-mix(in srgb, var(--surface-elevated-base) 94%, transparent);
  --plugin-settings-control-bg: color-mix(in srgb, var(--surface-card-base) 96%, transparent);
  --plugin-settings-border: color-mix(in srgb, var(--color-text-main) 14%, var(--border-subtle));
  --plugin-settings-slider-track-bg: color-mix(in srgb, var(--color-text-main) 18%, transparent);
  --plugin-settings-slider-thumb-bg: var(--surface-dialog-base);
  --plugin-settings-slider-thumb-border: color-mix(
    in srgb,
    var(--color-text-main) 24%,
    var(--plugin-settings-border)
  );
  background: var(--plugin-settings-dialog-bg);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
}

:global(.dark .dialog-content.plugin-settings-dialog) {
  --plugin-settings-dialog-bg: color-mix(in srgb, var(--surface-dialog-base) 98%, transparent);
  --plugin-settings-panel-bg: color-mix(
    in srgb,
    var(--surface-elevated-base) 92%,
    var(--color-text-main) 8%
  );
  --plugin-settings-control-bg: color-mix(
    in srgb,
    var(--surface-card-base) 88%,
    var(--color-text-main) 8%
  );
  --plugin-settings-border: color-mix(in srgb, var(--color-text-main) 22%, var(--border-light));
  --plugin-settings-slider-track-bg: rgba(255, 255, 255, 0.24);
  --plugin-settings-slider-thumb-bg: #f5f5f7;
  --plugin-settings-slider-thumb-border: rgba(255, 255, 255, 0.44);
}

:global(.plugin-settings-dialog-body) {
  padding-right: 1.125rem;
}

.plugin-settings-loading {
  padding: 2rem 0;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
}

.plugin-settings-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.plugin-settings-section {
  border: 1px solid var(--plugin-settings-border, var(--border-subtle));
  border-radius: 8px;
  background: var(--plugin-settings-panel-bg, var(--color-bg-elevated));
  overflow: hidden;
}

.plugin-settings-section-header {
  padding: 0.875rem 1rem 0.25rem;
}

.plugin-settings-section-header h4 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 800;
  color: var(--color-text-main);
}

.plugin-settings-section-header p {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.plugin-settings-fields {
  display: flex;
  flex-direction: column;
}

.plugin-settings-field {
  display: grid;
  grid-template-columns: minmax(150px, 0.72fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  padding: 0.875rem 1rem;
  border-top: 1px solid var(--border-subtle);
}

.plugin-settings-section-header + .plugin-settings-fields .plugin-settings-field:first-child {
  border-top-color: transparent;
}

.plugin-settings-section > .plugin-settings-fields:first-child .plugin-settings-field:first-child {
  border-top: 0;
}

.plugin-settings-field.is-wide {
  align-items: flex-start;
}

.plugin-settings-field-copy {
  min-width: 0;
}

.plugin-settings-field-copy label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--color-text-main);
}

.plugin-settings-field-copy p {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.plugin-settings-field-control {
  min-width: 0;
  display: flex;
  justify-content: flex-end;
}

.plugin-settings-field-control :deep(.switch-root:not([data-state='checked'])) {
  border-color: var(--plugin-settings-border, var(--control-border));
  background: color-mix(in srgb, var(--color-text-main) 12%, transparent);
}

.plugin-settings-input,
.plugin-settings-select,
.plugin-settings-textarea {
  width: min(100%, 320px);
  min-width: 0;
  border: 1px solid var(--plugin-settings-border, var(--control-border));
  border-radius: 8px;
  color: var(--color-text-main);
  background: var(--plugin-settings-control-bg, var(--control-bg));
  font: inherit;
  font-size: 0.8125rem;
  outline: none;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.plugin-settings-input,
.plugin-settings-select {
  height: 34px;
  padding: 0 0.625rem;
}

.plugin-settings-textarea {
  min-height: 92px;
  padding: 0.625rem;
  line-height: 1.5;
  resize: vertical;
}

.plugin-settings-input:focus,
.plugin-settings-select:focus,
.plugin-settings-textarea:focus {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--control-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.plugin-settings-slider {
  width: min(100%, 320px);
}

.plugin-settings-slider :deep(.slider-track) {
  height: 4px;
  background-color: var(--plugin-settings-slider-track-bg, var(--control-track-bg));
}

.plugin-settings-slider :deep(.slider-thumb) {
  width: 14px;
  height: 14px;
  border-color: var(--plugin-settings-slider-thumb-border, var(--control-border));
  background: var(--plugin-settings-slider-thumb-bg, var(--control-thumb-bg));
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--surface-dialog-base) 72%, transparent),
    var(--shadow-control);
}

.plugin-settings-slider :deep(.slider-value-label) {
  color: var(--color-text-main);
}

.plugin-settings-path-control {
  width: min(100%, 360px);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.plugin-settings-path-value {
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 0.45rem 0.625rem;
  border-radius: 8px;
  border: 1px solid var(--plugin-settings-border, var(--control-border));
  background: var(--plugin-settings-control-bg, var(--control-bg));
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.plugin-settings-path-actions,
.plugin-settings-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

@media (max-width: 640px) {
  .plugin-settings-field {
    grid-template-columns: 1fr;
    gap: 0.625rem;
  }

  .plugin-settings-field-control {
    justify-content: flex-start;
  }

  .plugin-settings-input,
  .plugin-settings-select,
  .plugin-settings-textarea,
  .plugin-settings-slider,
  .plugin-settings-path-control {
    width: 100%;
  }
}

/* 错误提示卡片 */
.plugin-failure-card {
  @apply flex gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5;
}

.plugin-failure-icon {
  @apply w-8 h-8 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0;
}

.plugin-failure-title {
  @apply text-[13px] font-semibold text-text-main;
}

.plugin-failure-meta {
  @apply mt-0.5 text-[11px] text-text-secondary;
}

.plugin-failure-message {
  @apply mt-0.5 text-[11px] text-amber-600 dark:text-amber-400 whitespace-pre-wrap break-words;
}
</style>
