<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import InstalledPluginCard from '@/views/plugins/InstalledPluginCard.vue';
import PluginLocalInstallOverlay from '@/views/plugins/PluginLocalInstallOverlay.vue';
import MarketplacePluginCard from '@/views/plugins/MarketplacePluginCard.vue';
import PluginSourceDialog from '@/views/plugins/PluginSourceDialog.vue';
import { usePluginFailures } from '@/views/plugins/usePluginFailures';
import { usePluginLocalInstall } from '@/views/plugins/usePluginLocalInstall';
import { usePluginMarketplace } from '@/views/plugins/usePluginMarketplace';
import { usePluginSettingsDialog } from '@/views/plugins/usePluginSettingsDialog';
import {
  iconArrowBarDown,
  iconCloud,
  iconFolderOpen,
  iconPlugin,
  iconRefreshCw,
  iconShield,
  iconTriangleAlert,
} from '@/icons';
import {
  uninstallRuntimePlugin,
  openPluginDirectory,
  pluginRuntimeState,
  reloadOtherPluginRuntimes,
  refreshPlugins,
  setRuntimePluginEnabled,
  setRuntimePluginSafeMode,
} from '@/plugins/runtime';
import { useToastStore } from '@/stores/toast';
import type { EchoPluginManifest } from '../../shared/plugins';

const route = useRoute();
const toastStore = useToastStore();
const activeView = ref<'installed' | 'marketplace'>('installed');
const isRefreshing = ref(false);
const isSafeModeBusy = ref(false);
const isUninstalling = ref(false);
const pendingUninstallPluginId = ref('');
const busyPluginIds = ref<Set<string>>(new Set());
const failedPluginIconIds = ref<Set<string>>(new Set());

const {
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
} = usePluginMarketplace({ route, activeView });

const records = computed(() => pluginRuntimeState.records);
const pluginCountLabel = computed(() => {
  const total = records.value.length;
  const enabled = records.value.filter((record) => record.descriptor.enabled).length;
  return `${enabled}/${total} 个已启用`;
});

const {
  isLocalInstallDragging,
  isLocalInstalling,
  localInstallOverlayTitle,
  localInstallOverlayDescription,
  handlePluginDragEnter,
  handlePluginDragOver,
  handlePluginDragLeave,
  handlePluginDrop,
} = usePluginLocalInstall({ marketplaceLoaded, loadMarketplace });

const {
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
} = usePluginFailures({ records });

const {
  settingsPluginId,
  activeSettingsContribution,
  activeSettingsTitle,
  activeSettingsDescription,
  showSettingsDialog,
  getSettingsContribution,
  getPluginSettingsButtonTitle,
  requestOpenPluginSettings,
} = usePluginSettingsDialog({ records });

const pendingUninstallRecord = computed(
  () =>
    records.value.find((record) => record.descriptor.id === pendingUninstallPluginId.value) ?? null,
);
const showUninstallDialog = computed({
  get: () => Boolean(pendingUninstallPluginId.value),
  set: (open: boolean) => {
    if (!open && !isUninstalling.value) pendingUninstallPluginId.value = '';
  },
});

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

const getPluginFeatureTags = (manifest: EchoPluginManifest) => {
  const tags: string[] = [];
  if (manifest.runtime?.miniPlayer) tags.push('Mini 运行时');
  if (manifest.runtime?.desktopLyric) tags.push('桌面歌词');
  if (manifest.capabilities?.lyricEffects) tags.push('歌词动效');
  if (manifest.capabilities?.lyrics) tags.push('歌词解析');
  if (manifest.capabilities?.audioSource) tags.push('音源解析');
  if (manifest.capabilities?.audioSpectrum) tags.push('音频频谱');
  if (manifest.capabilities?.kugouApi) tags.push('酷狗 API');
  if (manifest.capabilities?.localFiles) tags.push('本地文件');
  if (manifest.capabilities?.process) tags.push('本地进程');
  if (manifest.capabilities?.sqlite) tags.push('SQLite');
  if (manifest.contributes?.windows?.length) tags.push('插件浮窗');
  return tags;
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
              <InstalledPluginCard
                v-for="record in records"
                :key="record.descriptor.id"
                :record="record"
                :busy="busyPluginIds.has(record.descriptor.id)"
                :safe-mode="pluginRuntimeState.safeMode"
                :icon-url="getPluginIconUrl(record)"
                :initial="getPluginInitial(record)"
                :accent-style="getPluginAccentStyle(record.descriptor.id)"
                :status-label="getStatusLabel(record)"
                :status-title="getStatusTitle(record)"
                :compatibility-message="getPluginCompatibilityMessage(record)"
                :feature-tags="getPluginFeatureTags(record.descriptor.manifest)"
                :card-failure="getPluginCardFailure(record)"
                :has-current-failure="hasCurrentPluginCardFailure(record)"
                :has-failure="hasPluginCardFailure(record)"
                :has-historical-failure="hasHistoricalPluginCardFailure(record)"
                :failure-title="getPluginFailureButtonTitle(record)"
                :settings-available="Boolean(getSettingsContribution(record.descriptor.id))"
                :settings-title="getPluginSettingsButtonTitle(record)"
                @toggle="togglePlugin"
                @settings="requestOpenPluginSettings"
                @uninstall="requestUninstallPlugin"
                @failure-detail="openPluginFailureDetail"
                @icon-error="markPluginIconFailed"
              />
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
              v-if="updatableMarketplaceCount > 0 || isUpdatingAllMarketplace"
              variant="primary"
              size="sm"
              class="marketplace-update-all-btn h-9! shrink-0"
              :loading="isUpdatingAllMarketplace"
              :disabled="isUpdatingAllMarketplace || isMarketplaceRefreshing"
              :title="`更新全部 ${updatableMarketplaceCount} 个插件`"
              @click="updateAllMarketplacePlugins"
            >
              <Icon
                v-if="!isUpdatingAllMarketplace"
                :icon="iconArrowBarDown"
                width="16"
                height="16"
              />
              <span class="ml-1">{{ updateAllButtonLabel }}</span>
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
            <MarketplacePluginCard
              v-for="plugin in filteredMarketplacePlugins"
              :key="getMarketplacePluginKey(plugin)"
              :plugin="plugin"
              :plugin-key="getMarketplacePluginKey(plugin)"
              :highlighted="highlightedMarketplacePluginKey === getMarketplacePluginKey(plugin)"
              :busy="busyMarketplacePluginKeys.has(getMarketplacePluginKey(plugin))"
              :updating-all="isUpdatingAllMarketplace"
              :accent-style="getPluginAccentStyle(plugin.id)"
              :status-label="getMarketplaceStatusLabel(plugin)"
              :status-title="getMarketplaceStatusTitle(plugin)"
              :install-label="getMarketplaceInstallLabel(plugin)"
              :install-title="getMarketplaceInstallTitle(plugin)"
              :compatibility-message="getMarketplaceCompatibilityMessage(plugin)"
              :can-install="canInstallMarketplacePlugin(plugin)"
              :feature-tags="getPluginFeatureTags(plugin.manifest)"
              @share="shareMarketplacePlugin"
              @install="installMarketplacePlugin"
              @open-external="openExternalUrl"
            />
          </div>
        </template>
      </div>
    </Scrollbar>

    <PluginLocalInstallOverlay
      :dragging="isLocalInstallDragging"
      :installing="isLocalInstalling"
      :title="localInstallOverlayTitle"
      :description="localInstallOverlayDescription"
    />

    <PluginSourceDialog
      v-model:open="isSourceDialogOpen"
      v-model:source-url="newSourceUrl"
      v-model:source-name="newSourceName"
      :sources="marketplaceSources"
      :busy-source-ids="busySourceIds"
      :adding="isAddingSource"
      @add="addMarketplaceSource"
      @patch="patchMarketplaceSource"
      @remove="removeMarketplaceSource"
    />

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

<style src="./plugins/pluginManagement.css"></style>
