import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import { reloadOtherPluginRuntimes, refreshPlugins } from '@/plugins/runtime';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { copyShareTarget, createPluginShareTarget, isPluginIdShareable } from '@/utils/share';
import type { PluginMarketplacePlugin, PluginMarketplaceSource } from '../../../shared/plugins';
import { getPluginInstallErrorMessage } from './pluginInstallErrors';

type PluginManagementView = 'installed' | 'marketplace';

interface MarketplaceHighlightTarget {
  pluginId: string;
  sourceId: string;
  sourceUrl: string;
}

interface UsePluginMarketplaceOptions {
  route: RouteLocationNormalizedLoaded;
  activeView: Ref<PluginManagementView>;
}

export const getMarketplacePluginKey = (plugin: PluginMarketplacePlugin) =>
  `${plugin.sourceId}:${plugin.id}`;

export const usePluginMarketplace = ({ route, activeView }: UsePluginMarketplaceOptions) => {
  const toastStore = useToastStore();
  const settingStore = useSettingStore();
  const marketplaceLoaded = ref(false);
  const isMarketplaceLoading = ref(false);
  const isMarketplaceRefreshing = ref(false);
  const isUpdatingAllMarketplace = ref(false);
  const updateAllProgress = ref(0);
  const updateAllTotal = ref(0);
  const isSourceDialogOpen = ref(false);
  const isAddingSource = ref(false);
  const marketplaceSearch = ref('');
  const marketplaceSourceFilter = ref('all');
  const newSourceUrl = ref('');
  const newSourceName = ref('');
  const highlightedMarketplacePluginKey = ref('');
  const handledHighlightRouteKey = ref('');
  const busyMarketplacePluginKeys = ref<Set<string>>(new Set());
  const busySourceIds = ref<Set<string>>(new Set());
  const marketplacePlugins = ref<PluginMarketplacePlugin[]>([]);
  const marketplaceSources = ref<PluginMarketplaceSource[]>([]);
  const marketplaceFetchedAt = ref(0);
  let marketplaceLoadPromise: Promise<void> | null = null;

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
  const marketplaceCountLabel = computed(
    () => `${filteredMarketplacePlugins.value.length} 个可浏览`,
  );
  const updatableMarketplacePlugins = computed(() =>
    marketplacePlugins.value.filter(
      (plugin) => plugin.installed && plugin.updateAvailable && plugin.compatibility.compatible,
    ),
  );
  const updatableMarketplaceCount = computed(() => updatableMarketplacePlugins.value.length);
  const updateAllButtonLabel = computed(() =>
    isUpdatingAllMarketplace.value
      ? `更新中 ${updateAllProgress.value}/${updateAllTotal.value}`
      : `一键更新 (${updatableMarketplaceCount.value})`,
  );
  const marketplaceSourceErrors = computed(() =>
    marketplaceSources.value.filter((source) => source.enabled && source.lastError),
  );

  const getMarketplaceRequestOptions = (refresh = false) => ({
    refresh,
    githubProxyUrl: settingStore.githubProxyUrl,
  });

  const readRouteText = (value: unknown) => {
    if (Array.isArray(value)) return String(value[0] ?? '').trim();
    return String(value ?? '').trim();
  };

  const getMarketplaceRouteHighlightTarget = (): MarketplaceHighlightTarget | null => {
    const pluginId = readRouteText(route.query.highlightPluginId);
    if (!pluginId || !isPluginIdShareable(pluginId)) return null;
    return {
      pluginId,
      sourceId: readRouteText(route.query.sourceId),
      sourceUrl: readRouteText(route.query.source || route.query.sourceUrl),
    };
  };

  const getMarketplaceRouteHighlightKey = (target: MarketplaceHighlightTarget) =>
    [target.pluginId, target.sourceId, target.sourceUrl].join('|');

  const shouldRefreshMarketplaceForRouteHighlight = () => {
    const value = readRouteText(route.query.refreshMarketplace);
    return value === '1' || value.toLowerCase() === 'true';
  };

  const normalizeUrlText = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();

  const findMarketplacePluginForHighlight = (target: MarketplaceHighlightTarget) =>
    marketplacePlugins.value.find((plugin) => {
      if (plugin.id !== target.pluginId) return false;
      if (target.sourceId && plugin.sourceId === target.sourceId) return true;
      if (
        target.sourceUrl &&
        normalizeUrlText(plugin.sourceUrl) === normalizeUrlText(target.sourceUrl)
      ) {
        return true;
      }
      return !target.sourceId && !target.sourceUrl;
    }) ??
    (!target.sourceId && !target.sourceUrl
      ? marketplacePlugins.value.find((plugin) => plugin.id === target.pluginId)
      : null) ??
    null;

  const highlightMarketplacePlugin = async (plugin: PluginMarketplacePlugin) => {
    const key = getMarketplacePluginKey(plugin);
    highlightedMarketplacePluginKey.value = key;
    marketplaceSearch.value = '';
    marketplaceSourceFilter.value = plugin.sourceId;
    await nextTick();
    document
      .querySelector(`[data-marketplace-plugin-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => {
      if (highlightedMarketplacePluginKey.value === key) highlightedMarketplacePluginKey.value = '';
    }, 4200);
  };

  const loadMarketplace = async (refreshSource = false, notify = true) => {
    if (isMarketplaceLoading.value || isMarketplaceRefreshing.value) {
      return marketplaceLoadPromise ?? Promise.resolve();
    }
    if (refreshSource && marketplaceLoaded.value) isMarketplaceRefreshing.value = true;
    else isMarketplaceLoading.value = true;

    marketplaceLoadPromise = (async () => {
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
        } else if (refreshSource && notify) {
          toastStore.actionCompleted('在线插件列表已刷新');
        }
      } catch (error) {
        toastStore.warning(error instanceof Error ? error.message : '在线插件列表加载失败');
      } finally {
        isMarketplaceLoading.value = false;
        isMarketplaceRefreshing.value = false;
        marketplaceLoadPromise = null;
      }
    })();

    return marketplaceLoadPromise;
  };

  const processMarketplaceRouteHighlight = async (force = false) => {
    const target = getMarketplaceRouteHighlightTarget();
    if (!target) return;
    const shouldRefresh = shouldRefreshMarketplaceForRouteHighlight();
    const routeKey = `${getMarketplaceRouteHighlightKey(target)}|${shouldRefresh ? 'refresh' : 'cache'}`;
    if (!force && handledHighlightRouteKey.value === routeKey) return;
    handledHighlightRouteKey.value = routeKey;
    activeView.value = 'marketplace';

    if (!marketplaceLoaded.value || shouldRefresh) await loadMarketplace(shouldRefresh, false);

    let plugin = findMarketplacePluginForHighlight(target);
    if (!plugin && !shouldRefresh) {
      await loadMarketplace(true, false);
      plugin = findMarketplacePluginForHighlight(target);
    }
    if (!plugin) {
      toastStore.warning('未找到需要高亮的插件');
      return;
    }

    await highlightMarketplacePlugin(plugin);
  };

  const switchView = (view: PluginManagementView) => {
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

  const shareMarketplacePlugin = async (plugin: PluginMarketplacePlugin) => {
    const target = createPluginShareTarget(plugin);
    if (!target) {
      toastStore.warning('插件分享信息不完整');
      return;
    }
    try {
      await copyShareTarget(target);
      toastStore.actionCompleted('插件分享链接已复制');
    } catch {
      toastStore.actionFailed('复制插件分享链接');
    }
  };

  const installMarketplacePlugin = async (plugin: PluginMarketplacePlugin) => {
    if (!canInstallMarketplacePlugin(plugin)) return false;
    const key = getMarketplacePluginKey(plugin);
    const next = new Set(busyMarketplacePluginKeys.value);
    next.add(key);
    busyMarketplacePluginKeys.value = next;
    try {
      const result = await window.electron.plugins?.marketplace.install(
        plugin.sourceId,
        plugin.id,
        {
          githubProxyUrl: settingStore.githubProxyUrl,
          enableAfterInstall: false,
        },
      );
      if (!result?.ok) throw new Error(result?.error || '插件安装失败');
      await refreshPlugins({ reloadActive: true });
      await reloadOtherPluginRuntimes();
      await loadMarketplace(false);
      toastStore.actionCompleted(result.updated ? '插件已更新' : '插件已安装');
      return true;
    } catch (error) {
      toastStore.warning(getPluginInstallErrorMessage(error));
      return false;
    } finally {
      const done = new Set(busyMarketplacePluginKeys.value);
      done.delete(key);
      busyMarketplacePluginKeys.value = done;
    }
  };

  const updateAllMarketplacePlugins = async () => {
    if (isUpdatingAllMarketplace.value) return;
    const targets = [...updatableMarketplacePlugins.value];
    if (targets.length === 0) return;

    isUpdatingAllMarketplace.value = true;
    updateAllTotal.value = targets.length;
    updateAllProgress.value = 0;
    let succeeded = 0;
    const failures: string[] = [];
    try {
      for (const plugin of targets) {
        const key = getMarketplacePluginKey(plugin);
        const next = new Set(busyMarketplacePluginKeys.value);
        next.add(key);
        busyMarketplacePluginKeys.value = next;
        try {
          const result = await window.electron.plugins?.marketplace.install(
            plugin.sourceId,
            plugin.id,
            {
              githubProxyUrl: settingStore.githubProxyUrl,
              enableAfterInstall: false,
            },
          );
          if (!result?.ok) throw new Error(result?.error || '插件更新失败');
          succeeded += 1;
        } catch (error) {
          failures.push(`${plugin.name}：${getPluginInstallErrorMessage(error)}`);
        } finally {
          const done = new Set(busyMarketplacePluginKeys.value);
          done.delete(key);
          busyMarketplacePluginKeys.value = done;
          updateAllProgress.value += 1;
        }
      }

      if (succeeded > 0) {
        await refreshPlugins({ reloadActive: true });
        await reloadOtherPluginRuntimes();
      }
      await loadMarketplace(false);
    } finally {
      isUpdatingAllMarketplace.value = false;
      updateAllProgress.value = 0;
      updateAllTotal.value = 0;
    }

    if (failures.length === 0) {
      toastStore.actionCompleted(`已更新 ${succeeded} 个插件`);
    } else {
      toastStore.warning(
        `更新完成：成功 ${succeeded} 个，失败 ${failures.length} 个。${failures[0]}`,
        6000,
      );
    }
  };

  onMounted(() => {
    if (readRouteText(route.query.view) === 'marketplace') switchView('marketplace');
    void processMarketplaceRouteHighlight(false);
  });

  watch(
    () => route.fullPath,
    () => {
      if (route.name !== 'plugin-management') return;
      if (readRouteText(route.query.view) === 'marketplace') switchView('marketplace');
      void processMarketplaceRouteHighlight(false);
    },
  );

  return {
    marketplaceLoaded,
    isMarketplaceLoading,
    isMarketplaceRefreshing,
    isUpdatingAllMarketplace,
    isSourceDialogOpen,
    isAddingSource,
    marketplaceSearch,
    marketplaceSourceFilter,
    newSourceUrl,
    newSourceName,
    highlightedMarketplacePluginKey,
    busyMarketplacePluginKeys,
    busySourceIds,
    marketplacePlugins,
    marketplaceSources,
    sourceSelectOptions,
    marketplaceSourceSummary,
    marketplaceFetchedAtLabel,
    filteredMarketplacePlugins,
    marketplaceCountLabel,
    updatableMarketplaceCount,
    updateAllButtonLabel,
    marketplaceSourceErrors,
    loadMarketplace,
    switchView,
    openSourceDialog,
    addMarketplaceSource,
    patchMarketplaceSource,
    removeMarketplaceSource,
    getMarketplacePluginKey,
    getMarketplaceInstallLabel,
    getMarketplaceCompatibilityMessage,
    getMarketplaceStatusLabel,
    getMarketplaceStatusTitle,
    getMarketplaceInstallTitle,
    canInstallMarketplacePlugin,
    openExternalUrl,
    shareMarketplacePlugin,
    installMarketplacePlugin,
    updateAllMarketplacePlugins,
  };
};
