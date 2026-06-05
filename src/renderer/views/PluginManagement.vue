<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Switch from '@/components/ui/Switch.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { iconPlugin, iconRefreshCw, iconShield, iconTriangleAlert, iconFolderOpen } from '@/icons';
import {
  uninstallRuntimePlugin,
  openPluginDirectory,
  pluginRuntimeState,
  refreshPlugins,
  setRuntimePluginEnabled,
  setRuntimePluginSafeMode,
} from '@/plugins/runtime';
import { useToastStore } from '@/stores/toast';
import type { PluginFailureRecord } from '../../shared/plugins';

const toastStore = useToastStore();
const isRefreshing = ref(false);
const isSafeModeBusy = ref(false);
const isUninstalling = ref(false);
const pendingUninstallPluginId = ref('');
const busyPluginIds = ref<Set<string>>(new Set());
const failedPluginImageIds = ref<Set<string>>(new Set());

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
const showUninstallDialog = computed({
  get: () => Boolean(pendingUninstallPluginId.value),
  set: (open: boolean) => {
    if (!open && !isUninstalling.value) pendingUninstallPluginId.value = '';
  },
});

const failureReasonLabels: Record<PluginFailureRecord['reason'], string> = {
  'activation-error': '插件启动失败',
  'runtime-error': '插件运行异常',
  'render-process-gone': '渲染进程异常退出',
  unresponsive: '渲染进程无响应',
};

const failurePluginIds = computed(() => {
  const failure = pluginRuntimeState.lastFailure;
  if (!failure) return [];
  return Array.from(
    new Set([failure.pluginId, ...(failure.pluginIds ?? [])].filter(Boolean) as string[]),
  );
});

const failurePluginNames = computed(() => {
  const ids = failurePluginIds.value;
  if (ids.length === 0) return '无法定位到具体插件';
  const names = ids.map(
    (id) => records.value.find((record) => record.descriptor.id === id)?.descriptor.name ?? id,
  );
  return names.join('、');
});

const failureTime = computed(() => {
  const createdAt = pluginRuntimeState.lastFailure?.createdAt;
  if (!createdAt) return '';
  return new Date(createdAt).toLocaleString();
});

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
          <div
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-card border border-border-light/40"
          >
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
      <div v-if="pluginRuntimeState.lastFailure" class="plugin-failure-card mt-3">
        <div class="plugin-failure-icon">
          <Icon :icon="iconTriangleAlert" width="16" height="16" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="plugin-failure-title">
            {{ failureReasonLabels[pluginRuntimeState.lastFailure.reason] }}
          </div>
          <div class="plugin-failure-meta">
            嫌疑插件：{{ failurePluginNames }}
            <span v-if="failureTime"> · {{ failureTime }}</span>
          </div>
          <div class="plugin-failure-message">
            {{ pluginRuntimeState.lastFailure.message }}
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
                'is-error': record.status === 'error' || record.descriptor.invalid,
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
                        'is-active': record.status === 'active',
                        'is-error': record.status === 'error' || record.descriptor.invalid,
                        'is-safe': pluginRuntimeState.safeMode && record.descriptor.enabled,
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

              <div v-if="record.error || record.descriptor.error" class="plugin-card-error">
                <Icon :icon="iconTriangleAlert" width="14" height="14" />
                <span>{{ record.error || record.descriptor.error }}</span>
              </div>

              <div class="plugin-card-actions">
                <Button
                  variant="ghost"
                  size="xs"
                  class="plugin-remove-btn"
                  :disabled="busyPluginIds.has(record.descriptor.id)"
                  @click="requestUninstallPlugin(record.descriptor.id)"
                >
                  移除
                </Button>

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
  </div>
</template>

<style scoped>
@reference "@/style.css";

.plugin-management-page {
  background: var(--color-bg-main);
}

/* 页面头部 - 与 Settings 保持一致 */
.plugin-header {
  border-bottom: 1px solid var(--color-border-light);
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
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-light);
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
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border-light));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--color-text-main) 6%, transparent);
  transform: translateY(-1px);
}

.plugin-card.is-disabled {
  opacity: 0.72;
}

.plugin-card.is-error {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.05);
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
  border: 1px solid color-mix(in srgb, var(--plugin-accent) 18%, var(--color-border-light));
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
  background: rgba(239, 68, 68, 0.1);
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
  border-top: 1px solid var(--color-border-light);
}

.plugin-remove-btn {
  @apply text-primary hover:text-primary-hover;
}

.plugin-card.is-error .plugin-remove-btn {
  @apply text-red-500 hover:text-red-400;
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
