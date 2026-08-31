<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import { iconCloudDownload, iconCloudUpload, iconRefreshCw } from '@/icons';
import {
  sanitizePortableAppSettings,
  type PluginBackupProviderEntry,
  type SettingsBackupSummary,
} from '../../../../shared/settingsBackup';
import {
  pluginBackupProviders,
  type RegisteredPluginBackupProvider,
} from '@/plugins/runtime/backups';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const toastStore = useToastStore();

defineProps<{
  onClear: () => void;
}>();

const showExportDialog = ref(false);
const showRestoreSourceDialog = ref(false);
const showImportDialog = ref(false);
const exportSettings = ref(true);
const exportPlugins = ref(true);
const importSettings = ref(true);
const importPlugins = ref(true);
const importToken = ref('');
const importSummary = ref<SettingsBackupSummary | null>(null);
const isExporting = ref(false);
const isInspecting = ref(false);
const isImporting = ref(false);
const isListingBackups = ref(false);
const createTarget = ref('local');
const restoreSource = ref('local');
const restoreProviderKey = ref('local');
const providerEntries = ref<PluginBackupProviderEntry[]>([]);
const selectedProviderEntryId = ref('');
const providerListError = ref('');

let createAbortController: AbortController | null = null;
let restoreAbortController: AbortController | null = null;

const LOCAL_BACKUP_LOCATION = 'local';

const formatProviderOptionLabel = (provider: RegisteredPluginBackupProvider) =>
  provider.name === provider.pluginName
    ? provider.name
    : `${provider.name} · ${provider.pluginName}`;

const providerOptions = computed(() => [
  { label: '本地文件', value: LOCAL_BACKUP_LOCATION },
  ...pluginBackupProviders.value.map((provider) => ({
    label: formatProviderOptionLabel(provider),
    value: provider.key,
  })),
]);

const findProvider = (key: string): RegisteredPluginBackupProvider | null =>
  pluginBackupProviders.value.find((provider) => provider.key === key) ?? null;

const selectedCreateProvider = computed(() => findProvider(createTarget.value));
const selectedRestoreProvider = computed(() => findProvider(restoreSource.value));
const activeRestoreProvider = computed(() => findProvider(restoreProviderKey.value));

const canExport = computed(() => exportSettings.value || exportPlugins.value);
const canImport = computed(
  () =>
    Boolean(importToken.value) &&
    ((importSettings.value && importSummary.value?.includes.settings) ||
      (importPlugins.value && importSummary.value?.includes.plugins)),
);

const createActionLabel = computed(() =>
  selectedCreateProvider.value
    ? `创建并保存到 ${selectedCreateProvider.value.name}`
    : '选择位置并创建',
);

const canReadSelectedBackup = computed(() =>
  restoreSource.value === LOCAL_BACKUP_LOCATION
    ? true
    : Boolean(selectedRestoreProvider.value && selectedProviderEntryId.value),
);

const formatBackupTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN');
};

const formatBackupSize = (value?: number) => {
  if (!Number.isFinite(value) || Number(value) < 0) return '';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const resetProviderEntries = () => {
  providerEntries.value = [];
  selectedProviderEntryId.value = '';
  providerListError.value = '';
};

const resetUnavailableRestoreProvider = (reopenSourceDialog = false) => {
  restoreAbortController?.abort();
  restoreAbortController = null;
  isListingBackups.value = false;
  restoreSource.value = LOCAL_BACKUP_LOCATION;
  restoreProviderKey.value = LOCAL_BACKUP_LOCATION;
  importToken.value = '';
  importSummary.value = null;
  showImportDialog.value = false;
  resetProviderEntries();
  if (reopenSourceDialog) showRestoreSourceDialog.value = true;
};

const setRestorePreview = (
  token: string,
  summary: SettingsBackupSummary,
  providerKey = 'local',
) => {
  importToken.value = token;
  importSummary.value = summary;
  importSettings.value = summary.includes.settings;
  importPlugins.value = summary.includes.plugins;
  restoreProviderKey.value = providerKey;
  showRestoreSourceDialog.value = false;
  showImportDialog.value = true;
};

const openExportDialog = () => {
  exportSettings.value = true;
  exportPlugins.value = true;
  showExportDialog.value = true;
};

const handleExport = async () => {
  if (!canExport.value || isExporting.value) return;
  isExporting.value = true;
  try {
    const scope = {
      settings: exportSettings.value,
      plugins: exportPlugins.value,
    };
    const settingsData = exportSettings.value
      ? sanitizePortableAppSettings(settingStore.$state)
      : undefined;
    const provider = selectedCreateProvider.value;
    if (!provider) {
      const result = await window.electron.settingsBackup.export({
        ...scope,
        settingsData,
      });
      if (!result.ok) {
        if (!result.canceled) toastStore.warning(result.error || '创建备份失败');
        return;
      }
      showExportDialog.value = false;
      const detail = result.summary.pluginCount
        ? `，包含 ${result.summary.pluginCount} 个插件`
        : '';
      toastStore.success(`备份已创建${detail}`);
      return;
    }

    const created = await provider.create(scope, settingsData);
    if (!created.ok) {
      if (!created.canceled) toastStore.warning(created.error || '创建备份失败');
      return;
    }
    if (findProvider(provider.key) !== provider) {
      createTarget.value = LOCAL_BACKUP_LOCATION;
      toastStore.warning('备份存储提供方已停用，已切换到本地文件，请重新创建备份');
      return;
    }
    createAbortController?.abort();
    createAbortController = new AbortController();
    await provider.save({
      fileName: created.fileName,
      data: created.data,
      summary: created.summary,
      signal: createAbortController.signal,
    });
    showExportDialog.value = false;
    toastStore.success(`备份已保存到 ${provider.name}`);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '创建备份失败');
  } finally {
    isExporting.value = false;
  }
};

const refreshProviderBackups = async () => {
  const provider = selectedRestoreProvider.value;
  if (!provider) return;
  restoreAbortController?.abort();
  const controller = new AbortController();
  restoreAbortController = controller;
  isListingBackups.value = true;
  resetProviderEntries();
  try {
    const entries = await provider.list({ signal: controller.signal });
    if (controller.signal.aborted || restoreAbortController !== controller) return;
    providerEntries.value = entries;
    selectedProviderEntryId.value = entries[0]?.id ?? '';
  } catch (error) {
    if (controller.signal.aborted || restoreAbortController !== controller) return;
    providerListError.value = error instanceof Error ? error.message : '无法读取远端备份列表';
  } finally {
    if (restoreAbortController === controller) isListingBackups.value = false;
  }
};

const openRestoreDialog = () => {
  showRestoreSourceDialog.value = true;
  resetProviderEntries();
  if (selectedRestoreProvider.value) void refreshProviderBackups();
};

const handleChooseImport = async () => {
  if (isInspecting.value) return;
  isInspecting.value = true;
  try {
    const provider = selectedRestoreProvider.value;
    if (!provider) {
      const result = await window.electron.settingsBackup.inspect();
      if (!result.ok) {
        if (!result.canceled) toastStore.warning(result.error || '无法读取备份文件');
        return;
      }
      setRestorePreview(result.token, result.summary);
      return;
    }

    if (!selectedProviderEntryId.value) return;
    restoreAbortController?.abort();
    const controller = new AbortController();
    restoreAbortController = controller;
    const data = await provider.load({
      id: selectedProviderEntryId.value,
      signal: controller.signal,
    });
    if (controller.signal.aborted || findProvider(provider.key) !== provider) return;
    const result = await provider.inspect(data);
    if (controller.signal.aborted || findProvider(provider.key) !== provider) return;
    if (!result.ok) {
      toastStore.warning(result.error || '无法读取备份数据');
      return;
    }
    setRestorePreview(result.token, result.summary, provider.key);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '无法读取备份文件');
  } finally {
    isInspecting.value = false;
  }
};

const handleImport = async () => {
  if (!canImport.value || isImporting.value) return;
  isImporting.value = true;
  try {
    const provider = activeRestoreProvider.value;
    if (restoreProviderKey.value !== LOCAL_BACKUP_LOCATION && !provider) {
      resetUnavailableRestoreProvider(true);
      toastStore.warning('备份存储提供方已停用，已切换到本地文件，请重新选择备份');
      return;
    }
    const result = provider
      ? await provider.restore(importToken.value, {
          settings: importSettings.value,
          plugins: importPlugins.value,
        })
      : await window.electron.settingsBackup.import({
          token: importToken.value,
          settings: importSettings.value,
          plugins: importPlugins.value,
        });
    if (!result.ok) {
      if ('canceled' in result && result.canceled) return;
      if ((result.pluginsImported ?? 0) > 0) {
        toastStore.warning(
          `${result.error || '部分插件恢复失败'}。已恢复 ${result.pluginsImported} 个插件，正在重启…`,
          6000,
        );
        window.setTimeout(() => {
          void window.electron.appInfo.relaunch();
        }, 900);
      } else {
        toastStore.warning(result.error || '从备份恢复失败', 6000);
      }
      return;
    }
    showImportDialog.value = false;
    toastStore.success('恢复完成，正在重启 EchoMusic…', 4000);
    if (!provider) {
      window.setTimeout(() => {
        void window.electron.appInfo.relaunch();
      }, 450);
    }
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '从备份恢复失败');
  } finally {
    isImporting.value = false;
  }
};

watch(restoreSource, () => {
  restoreAbortController?.abort();
  isListingBackups.value = false;
  resetProviderEntries();
  if (showRestoreSourceDialog.value && selectedRestoreProvider.value) {
    void refreshProviderBackups();
  }
});

watch(showRestoreSourceDialog, (open) => {
  if (open) return;
  restoreAbortController?.abort();
  isListingBackups.value = false;
});

watch(pluginBackupProviders, () => {
  if (createTarget.value !== LOCAL_BACKUP_LOCATION && !findProvider(createTarget.value)) {
    createAbortController?.abort();
    createAbortController = null;
    createTarget.value = LOCAL_BACKUP_LOCATION;
  }

  const restoreSourceUnavailable =
    restoreSource.value !== LOCAL_BACKUP_LOCATION && !findProvider(restoreSource.value);
  const inspectedProviderUnavailable =
    restoreProviderKey.value !== LOCAL_BACKUP_LOCATION && !findProvider(restoreProviderKey.value);

  if (inspectedProviderUnavailable) {
    const wasShowingRestorePreview = showImportDialog.value;
    resetUnavailableRestoreProvider(wasShowingRestorePreview);
    if (wasShowingRestorePreview) {
      toastStore.warning('备份存储提供方已停用，已切换到本地文件，请重新选择备份');
    }
  } else if (restoreSourceUnavailable) {
    restoreAbortController?.abort();
    restoreAbortController = null;
    isListingBackups.value = false;
    restoreSource.value = LOCAL_BACKUP_LOCATION;
    resetProviderEntries();
  }
});

onBeforeUnmount(() => {
  createAbortController?.abort();
  restoreAbortController?.abort();
});
</script>

<template>
  <SettingsSectionShell id="data" :title="sectionTitles.data.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.data.icon"
        :icon="sectionTitles.data.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">备份与恢复</h3>
        <p class="text-sm text-text-secondary">
          备份应用设置、已安装插件及插件数据，或在其他设备恢复
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="xs" class="settings-button" @click="openExportDialog">
          <Icon :icon="iconCloudUpload" width="15" height="15" class="mr-1.5" />
          创建备份
        </Button>
        <Button variant="ghost" size="xs" class="settings-button" @click="openRestoreDialog">
          <Icon :icon="iconCloudDownload" width="15" height="15" class="mr-1.5" />
          恢复备份
        </Button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">查看运行日志</h3>
        <p class="text-sm text-text-secondary">打开本地日志目录以供排查问题</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="settings-button"
        @click="settingStore.openLogDirectory()"
      >
        立即查看
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">清除应用数据</h3>
        <p class="text-sm text-text-secondary">移除所有持久化设置及缓存信息</p>
      </div>
      <Button variant="ghost" size="xs" class="settings-button danger" @click="onClear">
        立即清除
      </Button>
    </div>
  </SettingsSectionShell>

  <Dialog
    v-model:open="showExportDialog"
    title="创建备份"
    description="选择要写入备份文件的内容。账号登录状态、设备身份和本机文件路径不会被备份。"
    content-class="backup-dialog"
    :close-on-interact-outside="!isExporting"
    :close-on-escape="!isExporting"
  >
    <div class="backup-location">
      <div class="backup-location-label">保存到</div>
      <div class="backup-location-select">
        <Select
          v-model="createTarget"
          class="w-full"
          :options="providerOptions"
          :disabled="isExporting"
          aria-label="备份保存位置"
        />
      </div>
      <p class="backup-location-description">
        <template v-if="selectedCreateProvider">
          {{ selectedCreateProvider.description || '由插件负责保存备份数据' }} · 提供者：{{
            selectedCreateProvider.pluginName
          }}
        </template>
        <template v-else>保存为本机 EchoMusic 备份文件</template>
      </p>
    </div>
    <div class="backup-options">
      <div class="backup-option">
        <div class="min-w-0">
          <div class="backup-option-title">应用设置</div>
          <div class="backup-option-description">外观、播放、歌词、快捷键、网络等偏好</div>
        </div>
        <Switch v-model="exportSettings" class="shrink-0" :disabled="isExporting" />
      </div>
      <div class="backup-option">
        <div class="min-w-0">
          <div class="backup-option-title">插件及插件设置</div>
          <div class="backup-option-description">包含插件本体、启用状态和插件数据</div>
        </div>
        <Switch v-model="exportPlugins" class="shrink-0" :disabled="isExporting" />
      </div>
    </div>
    <p class="backup-warning">
      备份内容未加密，任何拿到数据的人都可能读取其中的插件账号与数据。选择插件存储时，备份数据会交给对应插件处理。
    </p>
    <template #footer>
      <Button variant="outline" size="sm" :disabled="isExporting" @click="showExportDialog = false">
        取消
      </Button>
      <Button size="sm" :disabled="!canExport" :loading="isExporting" @click="handleExport">
        {{ createActionLabel }}
      </Button>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showRestoreSourceDialog"
    title="选择备份"
    description="选择备份所在位置。插件存储会由对应插件列出和读取远端备份。"
    content-class="backup-dialog"
    :close-on-interact-outside="!isInspecting"
    :close-on-escape="!isInspecting"
  >
    <div class="backup-location">
      <div class="backup-location-label">从这里恢复</div>
      <div class="backup-location-select">
        <Select
          v-model="restoreSource"
          class="w-full"
          :options="providerOptions"
          :disabled="isInspecting"
          aria-label="备份来源"
        />
      </div>
      <p class="backup-location-description">
        <template v-if="selectedRestoreProvider">
          {{ selectedRestoreProvider.description || '由插件负责读取备份数据' }} · 提供者：{{
            selectedRestoreProvider.pluginName
          }}
        </template>
        <template v-else>从本机选择一个 EchoMusic 备份文件</template>
      </p>
    </div>

    <template v-if="selectedRestoreProvider">
      <div class="provider-list-header">
        <span>可用备份</span>
        <Button
          variant="ghost"
          size="xs"
          :loading="isListingBackups"
          :disabled="isInspecting"
          @click="refreshProviderBackups"
        >
          <Icon v-if="!isListingBackups" :icon="iconRefreshCw" width="14" height="14" />
          刷新
        </Button>
      </div>
      <div v-if="providerEntries.length" class="provider-backup-list">
        <button
          v-for="entry in providerEntries"
          :key="entry.id"
          type="button"
          class="provider-backup-entry"
          :class="{ 'is-selected': selectedProviderEntryId === entry.id }"
          :disabled="isInspecting"
          @click="selectedProviderEntryId = entry.id"
        >
          <span class="provider-backup-entry-main">
            <span class="provider-backup-entry-name">{{ entry.name }}</span>
            <span v-if="entry.description" class="provider-backup-entry-description">
              {{ entry.description }}
            </span>
          </span>
          <span class="provider-backup-entry-meta">
            <span v-if="entry.createdAt">{{ formatBackupTime(entry.createdAt) }}</span>
            <span v-if="formatBackupSize(entry.size)">{{ formatBackupSize(entry.size) }}</span>
          </span>
        </button>
      </div>
      <div v-else-if="providerListError" class="provider-list-state is-error">
        {{ providerListError }}
      </div>
      <div v-else class="provider-list-state">
        {{ isListingBackups ? '正在读取备份列表…' : '没有可用备份' }}
      </div>
    </template>

    <template #footer>
      <Button
        variant="outline"
        size="sm"
        :disabled="isInspecting"
        @click="showRestoreSourceDialog = false"
      >
        取消
      </Button>
      <Button
        size="sm"
        :disabled="!canReadSelectedBackup || isListingBackups"
        :loading="isInspecting"
        @click="handleChooseImport"
      >
        {{ selectedRestoreProvider ? '读取所选备份' : '选择本地备份' }}
      </Button>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showImportDialog"
    title="从备份恢复"
    description="恢复会覆盖所选项目的同名设置，并在完成后自动重启 EchoMusic。目标设备已有的其他插件不会被删除。使用插件存储时，继续后还需确认插件恢复权限。"
    content-class="backup-dialog"
    :close-on-interact-outside="!isImporting"
    :close-on-escape="!isImporting"
  >
    <div v-if="importSummary" class="backup-meta">
      <span>备份版本：EchoMusic {{ importSummary.appVersion || '未知' }}</span>
      <span>创建时间：{{ formatBackupTime(importSummary.createdAt) }}</span>
    </div>
    <div class="backup-options">
      <div v-if="importSummary?.includes.settings" class="backup-option">
        <div class="min-w-0">
          <div class="backup-option-title">应用设置</div>
          <div class="backup-option-description">{{ importSummary.settingCount }} 项可迁移设置</div>
        </div>
        <Switch v-model="importSettings" class="shrink-0" :disabled="isImporting" />
      </div>
      <div v-if="importSummary?.includes.plugins" class="backup-option">
        <div class="min-w-0">
          <div class="backup-option-title">插件及插件设置</div>
          <div class="backup-option-description">
            {{ importSummary.pluginCount }} 个插件
            <template v-if="importSummary.pluginNames.length">
              · {{ importSummary.pluginNames.slice(0, 4).join('、')
              }}<template v-if="importSummary.pluginNames.length > 4"> 等</template>
            </template>
          </div>
        </div>
        <Switch v-model="importPlugins" class="shrink-0" :disabled="isImporting" />
      </div>
    </div>
    <template #footer>
      <Button variant="outline" size="sm" :disabled="isImporting" @click="showImportDialog = false">
        取消
      </Button>
      <Button size="sm" :disabled="!canImport" :loading="isImporting" @click="handleImport">
        恢复并重启
      </Button>
    </template>
  </Dialog>
</template>

<style scoped src="../settingsSection.css"></style>
<style scoped>
@reference "@/style.css";

:global(.dialog-content.backup-dialog) {
  min-height: min(420px, calc(100vh - 240px));
  max-height: calc(100vh - 180px);
}

.backup-options {
  @apply space-y-3;
}

.backup-location {
  @apply mb-4 space-y-2;
}

.backup-location-label,
.provider-list-header {
  @apply text-[12px] font-semibold text-text-main;
}

.backup-location-description {
  @apply text-[11px] leading-5 text-text-secondary;
}

.backup-location-select,
.backup-location-select :deep(.echo-popover-trigger),
.backup-location-select :deep(.echo-select-trigger) {
  @apply w-full;
}

.backup-option {
  @apply flex items-center justify-between gap-5 rounded-xl border px-4 py-3;
  background: var(--control-muted-bg);
  border-color: var(--control-border);
}

.backup-option-title {
  @apply text-[13px] font-semibold text-text-main;
}

.backup-option-description {
  @apply mt-1 truncate text-[11px] text-text-secondary;
}

.backup-meta {
  @apply mb-3 flex flex-col gap-1 rounded-xl border px-4 py-3 text-[11px] text-text-secondary;
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 20%, var(--control-border));
}

.provider-list-header {
  @apply mb-2 flex items-center justify-between;
}

.provider-backup-list {
  @apply max-h-64 space-y-2 overflow-y-auto pr-1;
}

.provider-backup-entry {
  @apply flex w-full items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition-colors;
  background: var(--control-muted-bg);
  border-color: var(--control-border);
}

.provider-backup-entry:hover:not(:disabled),
.provider-backup-entry.is-selected {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--control-border));
  background: color-mix(in srgb, var(--color-primary) 9%, var(--control-muted-bg));
}

.provider-backup-entry:disabled {
  @apply cursor-not-allowed opacity-60;
}

.provider-backup-entry-main {
  @apply min-w-0;
}

.provider-backup-entry-name {
  @apply block truncate text-[12px] font-semibold text-text-main;
}

.provider-backup-entry-description {
  @apply mt-1 block truncate text-[10px] text-text-secondary;
}

.provider-backup-entry-meta {
  @apply flex shrink-0 flex-col items-end gap-1 text-[10px] text-text-secondary;
}

.provider-list-state {
  @apply flex min-h-24 items-center justify-center rounded-xl border px-4 py-6 text-center text-[11px] text-text-secondary;
  background: var(--control-muted-bg);
  border-color: var(--control-border);
}

.provider-list-state.is-error {
  color: var(--color-danger);
}

.backup-warning {
  @apply mt-3 text-[11px] leading-5 text-text-secondary;
}
</style>
