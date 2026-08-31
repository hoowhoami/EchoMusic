<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import Switch from '@/components/ui/Switch.vue';
import { iconCloudDownload, iconCloudUpload } from '@/icons';
import {
  sanitizePortableAppSettings,
  type SettingsBackupSummary,
} from '../../../../shared/settingsBackup';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const toastStore = useToastStore();

defineProps<{
  onClear: () => void;
}>();

const showExportDialog = ref(false);
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

const canExport = computed(() => exportSettings.value || exportPlugins.value);
const canImport = computed(
  () =>
    Boolean(importToken.value) &&
    ((importSettings.value && importSummary.value?.includes.settings) ||
      (importPlugins.value && importSummary.value?.includes.plugins)),
);

const formatBackupTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN');
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
    const result = await window.electron.settingsBackup.export({
      settings: exportSettings.value,
      plugins: exportPlugins.value,
      settingsData: exportSettings.value
        ? sanitizePortableAppSettings(settingStore.$state)
        : undefined,
    });
    if (!result.ok) {
      if (!result.canceled) toastStore.warning(result.error || '创建备份失败');
      return;
    }
    showExportDialog.value = false;
    const detail = result.summary.pluginCount ? `，包含 ${result.summary.pluginCount} 个插件` : '';
    toastStore.success(`备份已创建${detail}`);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '创建备份失败');
  } finally {
    isExporting.value = false;
  }
};

const handleChooseImport = async () => {
  if (isInspecting.value) return;
  isInspecting.value = true;
  try {
    const result = await window.electron.settingsBackup.inspect();
    if (!result.ok) {
      if (!result.canceled) toastStore.warning(result.error || '无法读取备份文件');
      return;
    }
    importToken.value = result.token;
    importSummary.value = result.summary;
    importSettings.value = result.summary.includes.settings;
    importPlugins.value = result.summary.includes.plugins;
    showImportDialog.value = true;
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
    const result = await window.electron.settingsBackup.import({
      token: importToken.value,
      settings: importSettings.value,
      plugins: importPlugins.value,
    });
    if (!result.ok) {
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
    window.setTimeout(() => {
      void window.electron.appInfo.relaunch();
    }, 450);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '从备份恢复失败');
  } finally {
    isImporting.value = false;
  }
};
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
        <Button
          variant="ghost"
          size="xs"
          class="settings-button"
          :loading="isInspecting"
          @click="handleChooseImport"
        >
          <Icon
            v-if="!isInspecting"
            :icon="iconCloudDownload"
            width="15"
            height="15"
            class="mr-1.5"
          />
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
    :close-on-interact-outside="!isExporting"
    :close-on-escape="!isExporting"
  >
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
      备份文件未加密，任何拿到文件的人都可能读取其中的插件账号与数据，请妥善保管。
    </p>
    <template #footer>
      <Button variant="outline" size="sm" :disabled="isExporting" @click="showExportDialog = false">
        取消
      </Button>
      <Button size="sm" :disabled="!canExport" :loading="isExporting" @click="handleExport">
        选择位置并创建
      </Button>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showImportDialog"
    title="从备份恢复"
    description="恢复会覆盖所选项目的同名设置，并在完成后自动重启 EchoMusic。目标设备已有的其他插件不会被删除。"
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

.backup-options {
  @apply space-y-3;
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

.backup-warning {
  @apply mt-3 text-[11px] leading-5 text-text-secondary;
}
</style>
