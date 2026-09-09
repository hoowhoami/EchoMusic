import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import {
  acceptMarketplaceCatalog,
  getMarketplaceRevision,
  marketplacePlugins,
  busyMarketplacePluginKeys,
  isUpdatingAllMarketplace,
  updateAllProgress,
  updateAllTotal,
  installMarketplaceUpdate,
  updateMarketplaceBatch,
} from '@/stores/pluginUpdates';
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
  const isSourceDialogOpen = ref(false);
  const isAddingSource = ref(false);
  const marketplaceSearch = ref('');
  const marketplaceSourceFilter = ref('all');
  const newSourceUrl = ref('');
  const newSourceName = ref('');
  const highlightedMarketplacePluginKey = ref('');
  const handledHighlightRouteKey = ref('');
  const busySourceIds = ref<Set<string>>(new Set());
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
    if (marketplaceLoaded.value) isMarketplaceRefreshing.value = true;
    else isMarketplaceLoading.value = true;

    marketplaceLoadPromise = (async () => {
      const revision = getMarketplaceRevision();
      try {
        // 首次进入立即显示本地目录，再检查是否需要联网更新。
        if (!marketplaceLoaded.value && !refreshSource) {
          const cached = await window.electron.plugins?.marketplace.list({
            ...getMarketplaceRequestOptions(),
            cachedOnly: true,
          });
          if (cached?.plugins.length) {
            marketplaceSources.value = cached.sources;
            acceptMarketplaceCatalog(cached.plugins, revision);
            marketplaceFetchedAt.value = cached.fetchedAt;
            marketplaceLoaded.value = true;
            isMarketplaceLoading.value = false;
            isMarketplaceRefreshing.value = true;
          }
        }
        const result = await window.electron.plugins?.marketplace.list(
          getMarketplaceRequestOptions(refreshSource),
        );
        marketplaceSources.value = result?.sources ?? [];
        acceptMarketplaceCatalog(result?.plugins ?? [], revision);
        marketplaceFetchedAt.value = result?.fetchedAt ?? 0;
        marketplaceLoaded.value = true;
        if (result && !result.ok && notify) {
          toastStore.warning(result.error || '插件源刷新失败');
        } else if (refreshSource && notify) {
          toastStore.actionCompleted('在线插件列表已刷新');
        }
      } catch (error) {
        if (notify)
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
    if (view === 'marketplace') {
      void loadMarketplace(false, false);
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
    if (plugin.updateAvailable) return '可更新';
    if (plugin.installed) return '已安装';
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
    try {
      const ok = await installMarketplaceUpdate(plugin);
      if (ok) toastStore.actionCompleted(plugin.installed ? '插件已更新' : '插件已安装');
      return ok;
    } catch (error) {
      toastStore.warning(getPluginInstallErrorMessage(error));
      return false;
    }
  };

  const updateAllMarketplacePlugins = () =>
    updateMarketplaceBatch(updatableMarketplacePlugins.value);

  const checkMarketplace = () => {
    if (
      route.name === 'plugin-management' &&
      activeView.value === 'marketplace' &&
      document.visibilityState === 'visible' &&
      navigator.onLine
    ) {
      void loadMarketplace(false, false);
    }
  };
  let refreshInterval: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    refreshInterval = setInterval(checkMarketplace, 60_000);
    window.addEventListener('focus', checkMarketplace);
    window.addEventListener('online', checkMarketplace);
    document.addEventListener('visibilitychange', checkMarketplace);
    if (readRouteText(route.query.view) === 'marketplace') switchView('marketplace');
    void processMarketplaceRouteHighlight(false);
  });

  onUnmounted(() => {
    clearInterval(refreshInterval);
    window.removeEventListener('focus', checkMarketplace);
    window.removeEventListener('online', checkMarketplace);
    document.removeEventListener('visibilitychange', checkMarketplace);
  });

  watch(
    () => route.fullPath,
    () => {
      if (route.name !== 'plugin-management') return;
      if (readRouteText(route.query.view) === 'marketplace') switchView('marketplace');
      else checkMarketplace();
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
