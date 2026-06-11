<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import {
  iconArrowBarDown,
  iconCheck,
  iconCloud,
  iconExternalLink,
  iconFolderOpen,
  iconPlus,
  iconPlugin,
  iconRefreshCw,
  iconSettings,
  iconShield,
  iconTrash,
  iconTriangleAlert,
} from '@/icons';
import {
  clearRuntimePluginFailure,
  uninstallRuntimePlugin,
  openPluginDirectory,
  pluginRuntimeState,
  reloadOtherPluginRuntimes,
  refreshPlugins,
  setRuntimePluginEnabled,
  setRuntimePluginSafeMode,
  type PluginRuntimeFailureDetail,
} from '@/plugins/runtime';
import { pluginSettingsContributions } from '@/plugins/registry';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import type {
  PluginFailureRecord,
  PluginLocalInstallItemResult,
  PluginMarketplacePlugin,
  PluginMarketplaceSource,
} from '../../shared/plugins';

const toastStore = useToastStore();
const settingStore = useSettingStore();
const activeView = ref<'installed' | 'marketplace'>('installed');
const isRefreshing = ref(false);
const isSafeModeBusy = ref(false);
const isUninstalling = ref(false);
const isClearingFailure = ref(false);
const marketplaceLoaded = ref(false);
const isMarketplaceLoading = ref(false);
const isMarketplaceRefreshing = ref(false);
const isLocalInstallDragging = ref(false);
const isLocalInstalling = ref(false);
const isSourceDialogOpen = ref(false);
const isAddingSource = ref(false);
const marketplaceSearch = ref('');
const marketplaceSourceFilter = ref('all');
const newSourceUrl = ref('');
const newSourceName = ref('');
const pendingUninstallPluginId = ref('');
const settingsPluginId = ref('');
const failureDetailPluginId = ref('');
const busyPluginIds = ref<Set<string>>(new Set());
const busyMarketplacePluginKeys = ref<Set<string>>(new Set());
const busySourceIds = ref<Set<string>>(new Set());
const failedPluginIconIds = ref<Set<string>>(new Set());
const localInstallDragDepth = ref(0);
const localInstallCount = ref(0);
const marketplacePlugins = ref<PluginMarketplacePlugin[]>([]);
const marketplaceSources = ref<PluginMarketplaceSource[]>([]);
const marketplaceFetchedAt = ref(0);

const records = computed(() => pluginRuntimeState.records);
const pluginCountLabel = computed(() => {
  const total = records.value.length;
  const enabled = records.value.filter((record) => record.descriptor.enabled).length;
  return `${enabled}/${total} 个已启用`;
});
const sourceSelectOptions = computed(() => [
  { label: '全部源', value: 'all' },
  ...marketplaceSources.value.map((source) => ({
    label: source.name,
    value: source.id,
    disabled: !source.enabled,
  })),
]);
const enabledMarketplaceSourceCount = computed(
  () => marketplaceSources.value.filter((source) => source.enabled).length,
);
const marketplaceSourceSummary = computed(() => {
  const total = marketplaceSources.value.length;
  if (total === 0) return '暂无插件源';
  return `${enabledMarketplaceSourceCount.value}/${total} 个源启用`;
});
const marketplaceFetchedAtLabel = computed(() =>
  marketplaceFetchedAt.value ? new Date(marketplaceFetchedAt.value).toLocaleString() : '',
);
const localInstallOverlayTitle = computed(() =>
  isLocalInstalling.value
    ? `正在安装 ${localInstallCount.value || ''} 个插件`.trim()
    : '松开安装插件',
);
const localInstallOverlayDescription = computed(() =>
  isLocalInstalling.value ? '安装完成后会自动刷新插件列表' : '支持 .zip 压缩包和插件文件夹',
);

const filteredMarketplacePlugins = computed(() => {
  const keyword = marketplaceSearch.value.trim().toLowerCase();
  return marketplacePlugins.value.filter((plugin) => {
    if (
      marketplaceSourceFilter.value !== 'all' &&
      plugin.sourceId !== marketplaceSourceFilter.value
    ) {
      return false;
    }
    if (!keyword) return true;
    return [
      plugin.name,
      plugin.id,
      plugin.description,
      plugin.author,
      plugin.sourceName,
      plugin.tags.join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});
const marketplaceCountLabel = computed(() => `${filteredMarketplacePlugins.value.length} 个可浏览`);
const marketplaceSourceErrors = computed(() =>
  marketplaceSources.value.filter((source) => source.enabled && source.lastError),
);
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
    if (!open) settingsPluginId.value = '';
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
  incompatible: '版本不兼容',
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
    await refreshPlugins({ reloadActive: true });
    await reloadOtherPluginRuntimes();
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

const getMarketplaceRequestOptions = (refresh = false) => ({
  refresh,
  githubProxyUrl: settingStore.githubProxyUrl,
});

const loadMarketplace = async (refreshSource = false) => {
  if (isMarketplaceLoading.value || isMarketplaceRefreshing.value) return;
  if (refreshSource) isMarketplaceRefreshing.value = true;
  else isMarketplaceLoading.value = true;

  try {
    const result = await window.electron.plugins?.marketplace.list(
      getMarketplaceRequestOptions(refreshSource),
    );
    marketplaceSources.value = result?.sources ?? [];
    marketplacePlugins.value = result?.plugins ?? [];
    marketplaceFetchedAt.value = result?.fetchedAt ?? 0;
    marketplaceLoaded.value = true;
    if (result && !result.ok) {
      toastStore.warning(result.error || '插件源刷新失败');
    } else if (refreshSource) {
      toastStore.actionCompleted('在线插件列表已刷新');
    }
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '在线插件列表加载失败');
  } finally {
    isMarketplaceLoading.value = false;
    isMarketplaceRefreshing.value = false;
  }
};

const switchView = (view: 'installed' | 'marketplace') => {
  activeView.value = view;
  if (view === 'marketplace' && !marketplaceLoaded.value) {
    void loadMarketplace(false);
  }
};

const openSourceDialog = async () => {
  isSourceDialogOpen.value = true;
  try {
    const result = await window.electron.plugins?.marketplace.listSources();
    marketplaceSources.value = result?.sources ?? marketplaceSources.value;
  } catch {
    toastStore.warning('插件源列表读取失败');
  }
};

const addMarketplaceSource = async () => {
  const url = newSourceUrl.value.trim();
  if (!url || isAddingSource.value) return;
  isAddingSource.value = true;
  try {
    const result = await window.electron.plugins?.marketplace.addSource(
      {
        url,
        name: newSourceName.value.trim() || undefined,
      },
      getMarketplaceRequestOptions(false),
    );
    if (!result?.ok) throw new Error(result?.error || '插件源添加失败');
    marketplaceSources.value = result.sources;
    newSourceUrl.value = '';
    newSourceName.value = '';
    toastStore.actionCompleted('插件源已添加');
    await loadMarketplace(true);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件源添加失败');
  } finally {
    isAddingSource.value = false;
  }
};

const patchMarketplaceSource = async (
  source: PluginMarketplaceSource,
  patch: { name?: string; enabled?: boolean },
) => {
  const next = new Set(busySourceIds.value);
  next.add(source.id);
  busySourceIds.value = next;
  try {
    const result = await window.electron.plugins?.marketplace.patchSource(source.id, patch);
    if (!result?.ok) throw new Error(result?.error || '插件源更新失败');
    marketplaceSources.value = result.sources;
    if (patch.enabled !== undefined) await loadMarketplace(true);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件源更新失败');
  } finally {
    const done = new Set(busySourceIds.value);
    done.delete(source.id);
    busySourceIds.value = done;
  }
};

const removeMarketplaceSource = async (source: PluginMarketplaceSource) => {
  const next = new Set(busySourceIds.value);
  next.add(source.id);
  busySourceIds.value = next;
  try {
    const result = await window.electron.plugins?.marketplace.removeSource(source.id);
    if (!result?.ok) throw new Error(result?.error || '插件源删除失败');
    marketplaceSources.value = result.sources;
    if (marketplaceSourceFilter.value === source.id) marketplaceSourceFilter.value = 'all';
    toastStore.actionCompleted('插件源已删除');
    await loadMarketplace(true);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件源删除失败');
  } finally {
    const done = new Set(busySourceIds.value);
    done.delete(source.id);
    busySourceIds.value = done;
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

const getMarketplacePluginKey = (plugin: PluginMarketplacePlugin) =>
  `${plugin.sourceId}:${plugin.id}`;

const getMarketplaceInstallLabel = (plugin: PluginMarketplacePlugin) => {
  if (plugin.updateAvailable) return '更新';
  if (plugin.installed) return '已安装';
  return '安装';
};

const getMarketplaceCompatibilityMessage = (plugin: PluginMarketplacePlugin) =>
  plugin.compatibility.compatible
    ? ''
    : plugin.compatibility.message || '插件与当前 EchoMusic 主程序版本不兼容';

const getMarketplaceStatusLabel = (plugin: PluginMarketplacePlugin) => {
  if (!plugin.compatibility.compatible) return '版本要求';
  if (plugin.updateAvailable) return `可更新至 v${plugin.version}`;
  if (plugin.installed) return `已安装 v${plugin.installedVersion}`;
  return '未安装';
};

const getMarketplaceStatusTitle = (plugin: PluginMarketplacePlugin) =>
  getMarketplaceCompatibilityMessage(plugin) || getMarketplaceStatusLabel(plugin);

const getMarketplaceInstallTitle = (plugin: PluginMarketplacePlugin) => {
  const compatibilityMessage = getMarketplaceCompatibilityMessage(plugin);
  if (compatibilityMessage) return compatibilityMessage;
  if (plugin.installed && !plugin.updateAvailable) return '当前版本已安装';
  return getMarketplaceInstallLabel(plugin);
};

const canInstallMarketplacePlugin = (plugin: PluginMarketplacePlugin) =>
  plugin.compatibility.compatible && (!plugin.installed || plugin.updateAvailable);

const openExternalUrl = (url: string) => {
  if (!url) return;
  window.electron.ipcRenderer.send('open-external', url);
};

const installMarketplacePlugin = async (plugin: PluginMarketplacePlugin) => {
  if (!canInstallMarketplacePlugin(plugin)) return;
  const key = getMarketplacePluginKey(plugin);
  const next = new Set(busyMarketplacePluginKeys.value);
  next.add(key);
  busyMarketplacePluginKeys.value = next;
  try {
    const result = await window.electron.plugins?.marketplace.install(plugin.sourceId, plugin.id, {
      githubProxyUrl: settingStore.githubProxyUrl,
      enableAfterInstall: false,
    });
    if (!result?.ok) throw new Error(result?.error || '插件安装失败');
    await refreshPlugins({ reloadActive: true });
    await reloadOtherPluginRuntimes();
    await loadMarketplace(false);
    toastStore.actionCompleted(result.updated ? '插件已更新' : '插件已安装');
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件安装失败');
  } finally {
    const done = new Set(busyMarketplacePluginKeys.value);
    done.delete(key);
    busyMarketplacePluginKeys.value = done;
  }
};

const hasDraggedFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

const normalizeLocalInstallPaths = (paths: string[]) =>
  Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));

const summarizeLocalInstallFailure = (results: PluginLocalInstallItemResult[]) => {
  const firstFailure = results.find((result) => !result.ok);
  return firstFailure?.ok === false ? firstFailure.error : '';
};

const installLocalPlugins = async (paths: string[]) => {
  if (isLocalInstalling.value) return;
  const sourcePaths = normalizeLocalInstallPaths(paths);
  if (sourcePaths.length === 0) {
    toastStore.warning('未读取到可安装的插件路径');
    return;
  }

  isLocalInstalling.value = true;
  localInstallCount.value = sourcePaths.length;
  try {
    const result = await window.electron.plugins?.installLocal(sourcePaths, {
      enableAfterInstall: false,
    });
    if (!result) throw new Error('插件安装 API 不可用');

    if (result.installed > 0) {
      await refreshPlugins({ reloadActive: true });
      await reloadOtherPluginRuntimes();
      if (marketplaceLoaded.value) await loadMarketplace(false);
    }

    if (result.failed > 0) {
      const failure = summarizeLocalInstallFailure(result.results);
      toastStore.warning(
        `插件安装完成：成功 ${result.installed} 个，失败 ${result.failed} 个${failure ? `。${failure}` : ''}`,
        6000,
      );
      return;
    }

    if (result.installed === 1) {
      const installed = result.results.find((item) => item.ok);
      toastStore.actionCompleted(installed?.ok && installed.updated ? '插件已更新' : '插件已安装');
      return;
    }

    toastStore.actionCompleted(`已安装 ${result.installed} 个插件`);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '插件安装失败');
  } finally {
    isLocalInstalling.value = false;
    localInstallCount.value = 0;
  }
};

const handlePluginDragEnter = (event: DragEvent) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  localInstallDragDepth.value += 1;
  isLocalInstallDragging.value = true;
};

const handlePluginDragOver = (event: DragEvent) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = isLocalInstalling.value ? 'none' : 'copy';
  isLocalInstallDragging.value = true;
};

const handlePluginDragLeave = (event: DragEvent) => {
  if (!hasDraggedFiles(event)) return;
  localInstallDragDepth.value = Math.max(0, localInstallDragDepth.value - 1);
  if (localInstallDragDepth.value === 0) isLocalInstallDragging.value = false;
};

const handlePluginDrop = (event: DragEvent) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  localInstallDragDepth.value = 0;
  isLocalInstallDragging.value = false;

  if (isLocalInstalling.value) {
    toastStore.info('插件正在安装中');
    return;
  }

  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths = window.electron.plugins?.getDroppedFilePaths(files) ?? [];
  void installLocalPlugins(paths);
};

const getStatusLabel = (record: (typeof records.value)[number]) => {
  if (record.descriptor.invalid) return '无效';
  if (!record.descriptor.compatibility.compatible) return '版本要求';
  if (getCurrentPluginCardFailure(record)) return record.status === 'error' ? '出错' : '异常';
  if (!record.descriptor.enabled) return '已停用';
  if (pluginRuntimeState.safeMode && record.descriptor.enabled) return '安全模式';
  if (record.status === 'active') return '运行中';
  if (record.status === 'loading') return '加载中';
  if (record.status === 'error') return '出错';
  return '未运行';
};

const getPluginCompatibilityMessage = (record: (typeof records.value)[number]) =>
  record.descriptor.compatibility.compatible
    ? ''
    : record.descriptor.compatibility.message || '插件与当前 EchoMusic 主程序版本不兼容';

const getStatusTitle = (record: (typeof records.value)[number]) => {
  if (record.descriptor.invalid) return record.descriptor.error || '插件清单无效';
  return getPluginCompatibilityMessage(record) || getStatusLabel(record);
};

const pluginAccentPalette = ['#1a73e8', '#0f9d58', '#f29900', '#d93025', '#7b1fa2', '#00897b'];

const getPluginInitial = (record: (typeof records.value)[number]) => {
  const source = record.descriptor.name || record.descriptor.id || 'E';
  return Array.from(source.trim())[0]?.toUpperCase() ?? 'E';
};

const getPluginIconUrl = (record: (typeof records.value)[number]) => {
  if (failedPluginIconIds.value.has(record.descriptor.id)) return '';
  return record.descriptor.iconUrl || '';
};

const markPluginIconFailed = (pluginId: string) => {
  const next = new Set(failedPluginIconIds.value);
  next.add(pluginId);
  failedPluginIconIds.value = next;
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

const getSettingsContribution = (pluginId: string) =>
  settingsContributionByPluginId.value.get(pluginId) ?? null;

const getPluginSettingsButtonTitle = (record: (typeof records.value)[number]) => {
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

const requestOpenPluginSettings = (record: (typeof records.value)[number]) => {
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
</script>

<template>
  <div
    class="plugin-management-page h-full flex flex-col min-h-0"
    @dragenter="handlePluginDragEnter"
    @dragover="handlePluginDragOver"
    @dragleave="handlePluginDragLeave"
    @drop="handlePluginDrop"
  >
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

          <!-- 插件源 -->
          <Button
            v-if="activeView === 'marketplace'"
            variant="ghost"
            size="sm"
            class="h-8"
            title="管理插件源"
            @click="openSourceDialog"
          >
            <Icon :icon="iconCloud" width="16" height="16" />
          </Button>

          <!-- 刷新 -->
          <Button
            variant="ghost"
            size="sm"
            :disabled="isRefreshing || isMarketplaceRefreshing"
            @click="activeView === 'marketplace' ? loadMarketplace(true) : refresh()"
            class="h-8"
          >
            <Icon
              :icon="iconRefreshCw"
              width="16"
              height="16"
              :class="isRefreshing || isMarketplaceRefreshing ? 'animate-spin' : ''"
            />
          </Button>
        </div>
      </div>

      <nav class="plugin-view-tabs mt-4" aria-label="插件视图">
        <button
          type="button"
          class="plugin-view-tab"
          :class="{ 'is-active': activeView === 'installed' }"
          @click="switchView('installed')"
        >
          <Icon :icon="iconPlugin" width="14" height="14" />
          <span>已安装</span>
          <small>{{ records.length }}</small>
        </button>
        <button
          type="button"
          class="plugin-view-tab"
          :class="{ 'is-active': activeView === 'marketplace' }"
          @click="switchView('marketplace')"
        >
          <Icon :icon="iconCloud" width="14" height="14" />
          <span>在线插件</span>
          <small>{{ marketplaceLoaded ? marketplacePlugins.length : '-' }}</small>
        </button>
      </nav>

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
        <template v-if="activeView === 'installed'">
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
                  'is-disabled':
                    !record.descriptor.enabled ||
                    record.descriptor.invalid ||
                    !record.descriptor.compatibility.compatible,
                  'is-error':
                    hasCurrentPluginCardFailure(record) &&
                    getPluginCardFailure(record)?.reason !== 'incompatible',
                  'is-warning': getPluginCardFailure(record)?.reason === 'incompatible',
                }"
              >
                <div class="plugin-card-main">
                  <div
                    class="plugin-card-media"
                    :class="{ 'has-icon': getPluginIconUrl(record) }"
                    :style="getPluginAccentStyle(record.descriptor.id)"
                  >
                    <img
                      v-if="getPluginIconUrl(record)"
                      :src="getPluginIconUrl(record)"
                      :alt="record.descriptor.name"
                      class="plugin-card-icon"
                      @error="markPluginIconFailed(record.descriptor.id)"
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
                        :title="getStatusTitle(record)"
                        :class="{
                          'is-active':
                            record.status === 'active' && !hasCurrentPluginCardFailure(record),
                          'is-error':
                            hasCurrentPluginCardFailure(record) &&
                            getPluginCardFailure(record)?.reason !== 'incompatible',
                          'is-safe':
                            pluginRuntimeState.safeMode &&
                            record.descriptor.enabled &&
                            !hasCurrentPluginCardFailure(record),
                          'is-warning': getPluginCardFailure(record)?.reason === 'incompatible',
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

                <div
                  v-if="getPluginCompatibilityMessage(record)"
                  class="plugin-card-error is-warning"
                >
                  <Icon :icon="iconTriangleAlert" width="14" height="14" />
                  <span>{{ getPluginCompatibilityMessage(record) }}</span>
                </div>

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
                      :class="{
                        'is-historical': hasHistoricalPluginCardFailure(record),
                        'is-warning': getPluginCardFailure(record)?.reason === 'incompatible',
                      }"
                      type="button"
                      :title="getPluginFailureButtonTitle(record)"
                      @click="openPluginFailureDetail(record.descriptor.id)"
                    >
                      <Icon :icon="iconTriangleAlert" width="14" height="14" />
                    </button>
                  </div>

                  <Switch
                    :model-value="record.descriptor.enabled"
                    :disabled="
                      record.descriptor.invalid ||
                      !record.descriptor.compatibility.compatible ||
                      busyPluginIds.has(record.descriptor.id)
                    "
                    @update:model-value="(value) => togglePlugin(record.descriptor.id, value)"
                  />
                </div>
              </article>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="marketplace-toolbar">
            <Input
              v-model="marketplaceSearch"
              placeholder="搜索插件、作者或标签"
              class="marketplace-search"
              input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
            />
            <Select
              v-model="marketplaceSourceFilter"
              class="marketplace-source-select"
              :options="sourceSelectOptions"
            />
            <Button
              variant="outline"
              size="xs"
              class="marketplace-source-btn"
              @click="openSourceDialog"
            >
              <Icon :icon="iconCloud" width="14" height="14" />
              插件源
            </Button>
          </div>

          <div v-if="marketplaceSourceErrors.length > 0" class="marketplace-source-errors">
            <Icon :icon="iconTriangleAlert" width="15" height="15" />
            <span>
              {{ marketplaceSourceErrors[0].name }}：{{ marketplaceSourceErrors[0].lastError }}
            </span>
          </div>

          <div class="plugin-content-heading">
            <h2>在线插件</h2>
            <span>
              {{ marketplaceCountLabel }} · {{ marketplaceSourceSummary }}
              <template v-if="marketplaceFetchedAtLabel">
                · {{ marketplaceFetchedAtLabel }}</template
              >
            </span>
          </div>

          <div v-if="isMarketplaceLoading" class="plugin-empty-state">
            <Icon
              :icon="iconRefreshCw"
              width="38"
              height="38"
              class="animate-spin text-text-main/20"
            />
            <p class="text-text-main/60 mt-4 font-medium">正在加载在线插件</p>
          </div>

          <div v-else-if="filteredMarketplacePlugins.length === 0" class="plugin-empty-state">
            <Icon :icon="iconCloud" width="48" height="48" class="text-text-main/20" />
            <p class="text-text-main/60 mt-4 font-medium">暂无在线插件</p>
            <p class="text-text-secondary text-sm mt-2">添加插件源或刷新在线列表后再试</p>
          </div>

          <div v-else class="plugin-card-grid">
            <article
              v-for="plugin in filteredMarketplacePlugins"
              :key="getMarketplacePluginKey(plugin)"
              class="plugin-card marketplace-card"
              :class="{
                'is-disabled': !plugin.compatibility.compatible,
                'is-warning': !plugin.compatibility.compatible,
              }"
            >
              <div class="plugin-card-main">
                <div
                  class="plugin-card-media"
                  :class="{ 'has-icon': plugin.iconUrl }"
                  :style="getPluginAccentStyle(plugin.id)"
                >
                  <img
                    v-if="plugin.iconUrl"
                    :src="plugin.iconUrl"
                    :alt="plugin.name"
                    class="plugin-card-icon"
                  />
                  <span v-else class="plugin-card-initial">
                    {{ plugin.name.trim()[0]?.toUpperCase() || 'E' }}
                  </span>
                </div>

                <div class="plugin-card-summary">
                  <div class="plugin-card-header">
                    <h3 class="plugin-card-name" :title="plugin.name">{{ plugin.name }}</h3>
                    <span
                      class="plugin-status-badge"
                      :title="getMarketplaceStatusTitle(plugin)"
                      :class="{
                        'is-active': plugin.installed && !plugin.updateAvailable,
                        'is-warning': plugin.updateAvailable || !plugin.compatibility.compatible,
                      }"
                    >
                      {{ getMarketplaceStatusLabel(plugin) }}
                    </span>
                  </div>

                  <div class="plugin-card-meta">
                    <span>v{{ plugin.version }}</span>
                    <span v-if="plugin.author"> · {{ plugin.author }}</span>
                  </div>
                </div>
              </div>

              <p class="plugin-card-description">{{ plugin.description || '暂无描述' }}</p>

              <div
                v-if="getMarketplaceCompatibilityMessage(plugin)"
                class="plugin-card-error is-warning"
              >
                <Icon :icon="iconTriangleAlert" width="14" height="14" />
                <span>{{ getMarketplaceCompatibilityMessage(plugin) }}</span>
              </div>

              <div class="marketplace-tags">
                <span>{{ plugin.sourceName }}</span>
                <span v-for="tag in plugin.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
              </div>

              <div class="plugin-card-id" :title="plugin.id">ID: {{ plugin.id }}</div>

              <div class="plugin-card-actions">
                <div class="plugin-card-primary-actions">
                  <Button
                    variant="ghost"
                    size="xs"
                    class="plugin-settings-btn"
                    :disabled="!plugin.repo"
                    @click="openExternalUrl(plugin.repo || plugin.homepage)"
                  >
                    <Icon :icon="iconExternalLink" width="14" height="14" />
                    仓库
                  </Button>
                </div>

                <Button
                  variant="primary"
                  size="xs"
                  class="marketplace-install-btn"
                  :title="getMarketplaceInstallTitle(plugin)"
                  :loading="busyMarketplacePluginKeys.has(getMarketplacePluginKey(plugin))"
                  :disabled="
                    !canInstallMarketplacePlugin(plugin) ||
                    busyMarketplacePluginKeys.has(getMarketplacePluginKey(plugin))
                  "
                  @click="installMarketplacePlugin(plugin)"
                >
                  <Icon
                    v-if="plugin.installed && !plugin.updateAvailable"
                    :icon="iconCheck"
                    width="14"
                    height="14"
                  />
                  <Icon v-else :icon="iconArrowBarDown" width="14" height="14" />
                  {{ getMarketplaceInstallLabel(plugin) }}
                </Button>
              </div>
            </article>
          </div>
        </template>
      </div>
    </Scrollbar>

    <div
      v-if="isLocalInstallDragging || isLocalInstalling"
      class="plugin-local-install-overlay"
      :class="{ 'is-installing': isLocalInstalling }"
    >
      <div class="plugin-local-install-panel">
        <div class="plugin-local-install-icon">
          <Icon
            :icon="isLocalInstalling ? iconRefreshCw : iconArrowBarDown"
            width="28"
            height="28"
            :class="{ 'animate-spin': isLocalInstalling }"
          />
        </div>
        <strong>{{ localInstallOverlayTitle }}</strong>
        <span>{{ localInstallOverlayDescription }}</span>
      </div>
    </div>

    <!-- 插件源管理 -->
    <Dialog
      v-model:open="isSourceDialogOpen"
      title="插件源"
      description="添加 GitHub 仓库地址后，EchoMusic 会读取 echo-plugins.json 索引并同步插件清单。"
      show-close
      content-class="plugin-source-dialog"
      body-class="plugin-source-dialog-body"
    >
      <div class="plugin-source-manager">
        <div class="plugin-source-add">
          <Input
            v-model="newSourceUrl"
            placeholder="https://github.com/owner/repo"
            input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          />
          <Input
            v-model="newSourceName"
            placeholder="显示名称，可选"
            input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          />
          <Button
            variant="primary"
            size="xs"
            :loading="isAddingSource"
            :disabled="!newSourceUrl.trim() || isAddingSource"
            @click="addMarketplaceSource"
          >
            <Icon :icon="iconPlus" width="14" height="14" />
            添加
          </Button>
        </div>

        <div v-if="marketplaceSources.length === 0" class="plugin-source-empty">暂无插件源</div>

        <div v-else class="plugin-source-list">
          <div v-for="source in marketplaceSources" :key="source.id" class="plugin-source-row">
            <div class="plugin-source-main">
              <div class="plugin-source-title">
                <strong>{{ source.name }}</strong>
                <span v-if="source.official">官方</span>
              </div>
              <p :title="source.url">{{ source.url }}</p>
              <small>
                {{ source.pluginCount }} 个插件
                <template v-if="source.lastFetchedAt">
                  · {{ new Date(source.lastFetchedAt).toLocaleString() }}
                </template>
              </small>
              <div v-if="source.lastError" class="plugin-source-error">
                {{ source.lastError }}
              </div>
            </div>

            <div class="plugin-source-actions">
              <Switch
                :model-value="source.enabled"
                :disabled="busySourceIds.has(source.id)"
                @update:model-value="(enabled) => patchMarketplaceSource(source, { enabled })"
              />
              <Button
                variant="ghost"
                size="xs"
                class="plugin-source-delete-btn"
                :title="source.official ? '官方插件源可停用，但不能删除' : '删除插件源'"
                :disabled="source.official || busySourceIds.has(source.id)"
                @click="removeMarketplaceSource(source)"
              >
                <Icon :icon="iconTrash" width="14" height="14" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>

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

    <!-- 插件设置 -->
    <Dialog
      v-model:open="showSettingsDialog"
      :title="activeSettingsTitle"
      :description="activeSettingsDescription"
      show-close
      content-class="plugin-settings-dialog"
      body-class="plugin-settings-dialog-body"
    >
      <div v-if="activeSettingsContribution?.component" class="plugin-settings-content is-custom">
        <component
          :is="activeSettingsContribution.component"
          :contribution="activeSettingsContribution"
          :plugin-id="settingsPluginId"
        />
      </div>

      <div v-else class="plugin-settings-empty">插件设置入口不可用</div>
    </Dialog>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.plugin-management-page {
  position: relative;
  background: var(--color-bg-main);
}

.plugin-local-install-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: color-mix(in srgb, var(--color-bg-main) 82%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.plugin-local-install-panel {
  width: min(22rem, 100%);
  min-height: 11rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, var(--color-primary) 54%, var(--border-subtle));
  background: color-mix(in srgb, var(--color-bg-elevated) 96%, transparent);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--color-text-main) 14%, transparent);
  color: var(--color-text-main);
  text-align: center;
}

.plugin-local-install-icon {
  width: 3.25rem;
  height: 3.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.plugin-local-install-panel strong {
  font-size: 0.95rem;
  font-weight: 800;
}

.plugin-local-install-panel span {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
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

.plugin-view-tabs {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 10px;
  background: color-mix(in srgb, var(--control-bg) 92%, var(--color-text-main) 4%);
  border: 1px solid var(--control-border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.plugin-view-tab {
  height: 2.125rem;
  min-width: 8.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0 0.625rem;
  border-radius: 8px;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  font-weight: 800;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    box-shadow 0.18s ease;
}

.plugin-view-tab:hover {
  color: var(--color-text-main);
  background: var(--row-hover-bg);
}

.plugin-view-tab span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-view-tab small {
  min-width: 1.375rem;
  height: 1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.375rem;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 0.6875rem;
  font-weight: 900;
  line-height: 1;
}

.plugin-view-tab.is-active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, var(--color-bg-elevated));
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.06),
    inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.plugin-content {
  padding-top: 1.25rem;
}

.marketplace-toolbar {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex-wrap: wrap;
  margin-bottom: 0.875rem;
}

:deep(.marketplace-search) {
  width: min(22rem, 100%);
}

:deep(.marketplace-source-select) {
  width: min(17rem, 100%);
  min-width: 14rem;
}

:deep(.marketplace-source-btn) {
  gap: 0.375rem;
}

.marketplace-source-errors {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.25rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.875rem;
  border-radius: 8px;
  border: 1px solid rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.08);
  color: rgb(180, 83, 9);
  font-size: 0.75rem;
  font-weight: 600;
}

:global(.dark) .marketplace-source-errors {
  color: rgb(251, 191, 36);
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

.plugin-card.is-warning {
  border-color: color-mix(in srgb, var(--state-warning) 34%, var(--border-subtle));
  background: var(--state-warning-bg-soft);
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

.plugin-card-media.has-icon {
  background: transparent;
  border: 0;
}

.plugin-card-icon {
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

.plugin-card-failure-btn.is-warning {
  color: var(--state-warning);
  background: var(--state-warning-bg-soft);
}

.plugin-card-failure-btn.is-historical:hover {
  color: white;
  background: var(--state-warning);
}

.plugin-card-failure-btn.is-warning:hover {
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

.plugin-status-badge.is-warning {
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

.marketplace-card {
  min-height: 236px;
}

.marketplace-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-height: 1.5rem;
}

.marketplace-tags span {
  max-width: 9rem;
  height: 1.5rem;
  display: inline-flex;
  align-items: center;
  padding: 0 0.5rem;
  border-radius: 6px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 0.6875rem;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.marketplace-install-btn {
  min-width: 5rem;
  gap: 0.375rem;
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

.plugin-card-error.is-warning {
  color: rgb(180, 83, 9);
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.18);
}

:global(.dark) .plugin-card-error.is-warning {
  color: rgb(251, 191, 36);
}

.plugin-card-error svg {
  flex-shrink: 0;
  margin-top: 0.1rem;
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

:global(.dialog-content.plugin-source-dialog) {
  width: min(680px, 92vw);
  max-height: min(720px, calc(100vh - 120px));
}

:global(.plugin-source-dialog-body) {
  padding-right: 1.25rem;
}

.plugin-source-manager {
  display: grid;
  gap: 1rem;
}

.plugin-source-add {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.9fr) auto;
  gap: 0.625rem;
  align-items: center;
}

.plugin-source-list {
  display: grid;
  gap: 0.625rem;
}

.plugin-source-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--color-bg-elevated);
}

.plugin-source-main {
  min-width: 0;
  display: grid;
  gap: 0.25rem;
}

.plugin-source-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.plugin-source-title strong {
  min-width: 0;
  color: var(--color-text-main);
  font-size: 0.875rem;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-source-title span {
  height: 1.25rem;
  display: inline-flex;
  align-items: center;
  padding: 0 0.375rem;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  font-size: 0.6875rem;
  font-weight: 800;
}

.plugin-source-main p,
.plugin-source-main small {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.plugin-source-main p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-source-error {
  color: rgb(180, 83, 9);
  font-size: 0.75rem;
  font-weight: 600;
}

:global(.dark) .plugin-source-error {
  color: rgb(251, 191, 36);
}

.plugin-source-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.plugin-source-delete-btn {
  width: 2rem;
  min-width: 2rem;
  padding: 0;
  color: var(--color-text-secondary);
}

.plugin-source-empty {
  min-height: 5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  font-weight: 700;
  border: 1px dashed var(--border-subtle);
  border-radius: 8px;
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
  background: var(--plugin-settings-dialog-bg);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
}

:global(.dark .dialog-content.plugin-settings-dialog) {
  --plugin-settings-dialog-bg: color-mix(in srgb, var(--surface-dialog-base) 98%, transparent);
}

:global(.plugin-settings-dialog-body) {
  padding-right: 1.125rem;
}

.plugin-settings-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.plugin-settings-empty {
  padding: 2rem 0;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
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

@media (max-width: 720px) {
  .plugin-view-tabs {
    width: 100%;
  }

  .plugin-view-tab {
    min-width: 0;
  }

  :deep(.marketplace-search),
  :deep(.marketplace-source-select),
  :deep(.marketplace-source-btn) {
    width: 100%;
    min-width: 0;
  }

  .plugin-source-add {
    grid-template-columns: 1fr;
  }

  .plugin-source-row {
    flex-direction: column;
  }

  .plugin-source-actions {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
