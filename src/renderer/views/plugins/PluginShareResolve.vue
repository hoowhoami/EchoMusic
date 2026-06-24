<script setup lang="ts">
defineOptions({ name: 'plugin-share-resolve-page' });

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import { iconArrowLeft, iconCheck, iconPlugin, iconRefreshCw, iconTriangleAlert } from '@/icons';
import { reloadOtherPluginRuntimes, refreshPlugins } from '@/plugins/runtime';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { isPluginIdShareable } from '@/utils/share';
import type { PluginMarketplacePlugin, PluginMarketplaceSource } from '../../../shared/plugins';

type ResolveState = 'loading' | 'need-source' | 'ready' | 'installed' | 'failed';
type FailureReason = 'invalid' | 'not-found' | 'source-failed' | 'load-failed' | 'install-failed';

interface SharedPluginTarget {
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceUrl: string;
  version: string;
  checksum: string;
  homepage: string;
}

const route = useRoute();
const router = useRouter();
const settingStore = useSettingStore();
const toastStore = useToastStore();

const state = ref<ResolveState>('loading');
const reason = ref<FailureReason>('load-failed');
const marketplaceSources = ref<PluginMarketplaceSource[]>([]);
const marketplacePlugins = ref<PluginMarketplacePlugin[]>([]);
const targetPlugin = ref<PluginMarketplacePlugin | null>(null);
const targetSource = ref<PluginMarketplaceSource | null>(null);
const isBusy = ref(false);
const resolving = ref(false);
const installing = ref(false);

const readRouteText = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
};

const normalizeUrlText = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();

const target = computed<SharedPluginTarget | null>(() => {
  const pluginId = readRouteText(route.query.pluginId);
  if (!pluginId || !isPluginIdShareable(pluginId)) return null;
  return {
    pluginId,
    pluginName: readRouteText(route.query.pluginName || route.query.name),
    sourceId: readRouteText(route.query.sourceId),
    sourceUrl: readRouteText(route.query.source || route.query.sourceUrl),
    version: readRouteText(route.query.version),
    checksum: readRouteText(route.query.checksum),
    homepage: readRouteText(route.query.homepage),
  };
});

const titleText = computed(() => {
  if (installing.value)
    return `${targetPlugin.value?.updateAvailable ? '正在更新' : '正在安装'}插件`;
  if (isBusy.value) return '正在处理插件源';
  if (state.value === 'need-source') return '需要添加插件源';
  if (state.value === 'ready') {
    return `${targetPlugin.value?.updateAvailable ? '更新' : '安装'}分享的插件`;
  }
  if (state.value === 'installed') return '插件已安装';
  if (state.value === 'failed') return '分享的插件打不开';
  return '正在打开分享的插件';
});

const descriptionText = computed(() => {
  const name = target.value?.pluginName || target.value?.pluginId || '插件';
  if (installing.value) return '安装完成后会自动刷新插件运行时并回到插件管理页。';
  if (isBusy.value) return '完成后会继续查找分享的插件。';
  if (state.value === 'loading') return `正在查找分享的插件「${name}」。`;
  if (state.value === 'need-source') {
    if (targetSource.value && !targetSource.value.enabled) {
      return `分享的插件「${name}」来自已停用的插件源，启用后会继续查找插件。`;
    }
    return `分享的插件「${name}」来自新的插件源，添加后会继续查找插件。`;
  }
  if (state.value === 'ready' && targetPlugin.value) {
    return `来源：${targetPlugin.value.sourceName || targetPlugin.value.sourceUrl} · 将安装 v${targetPlugin.value.version}`;
  }
  if (state.value === 'installed') return '已完成安装，即将回到插件管理页。';
  if (reason.value === 'invalid') return '这个插件分享链接格式不正确。';
  if (reason.value === 'not-found') return '没有在插件源中找到分享的插件。';
  if (reason.value === 'source-failed') return '插件源添加或启用失败，请检查链接中的来源。';
  if (reason.value === 'install-failed') return '插件安装失败，请确认网络和插件源状态后重试。';
  return '暂时没能加载插件源，请稍后重试。';
});

const isWorking = computed(
  () => state.value === 'loading' || resolving.value || isBusy.value || installing.value,
);

const installWarnings = computed(() => {
  const plugin = targetPlugin.value;
  const shared = target.value;
  if (!plugin || !shared) return [];
  const warnings: string[] = [];
  if (shared.version && shared.version !== plugin.version) {
    warnings.push(`分享时版本为 v${shared.version}，当前插件源提供 v${plugin.version}。`);
  }
  if (shared.checksum && plugin.checksum && shared.checksum !== plugin.checksum) {
    warnings.push('分享链接中的校验值与当前插件源不一致，请确认来源后再安装。');
  }
  if (!plugin.compatibility.compatible) {
    warnings.push(plugin.compatibility.message || '插件与当前 EchoMusic 主程序版本不兼容。');
  }
  return warnings;
});

const findSource = (shared: SharedPluginTarget) =>
  marketplaceSources.value.find((source) => {
    if (shared.sourceId && source.id === shared.sourceId) return true;
    if (shared.sourceUrl && normalizeUrlText(source.url) === normalizeUrlText(shared.sourceUrl)) {
      return true;
    }
    return false;
  }) ?? null;

const findPlugin = (shared: SharedPluginTarget) =>
  marketplacePlugins.value.find((plugin) => {
    if (plugin.id !== shared.pluginId) return false;
    if (shared.sourceId && plugin.sourceId === shared.sourceId) return true;
    if (
      shared.sourceUrl &&
      normalizeUrlText(plugin.sourceUrl) === normalizeUrlText(shared.sourceUrl)
    ) {
      return true;
    }
    return !shared.sourceId && !shared.sourceUrl;
  }) ??
  (!shared.sourceId && !shared.sourceUrl
    ? marketplacePlugins.value.find((plugin) => plugin.id === shared.pluginId)
    : null) ??
  null;

const loadMarketplace = async (refresh = false) => {
  const result = await window.electron.plugins?.marketplace.list({
    refresh,
    githubProxyUrl: settingStore.githubProxyUrl,
  });
  marketplaceSources.value = result?.sources ?? [];
  marketplacePlugins.value = result?.plugins ?? [];
  if (result && !result.ok) throw new Error(result.error || '插件源加载失败');
};

const resolveShare = async (refresh = false) => {
  const shared = target.value;
  if (!shared) {
    reason.value = 'invalid';
    state.value = 'failed';
    return;
  }

  resolving.value = true;
  state.value = 'loading';
  targetPlugin.value = null;
  try {
    await loadMarketplace(refresh);
    const source = findSource(shared);
    targetSource.value = source;

    let plugin = findPlugin(shared);
    if (!plugin && (shared.sourceId || shared.sourceUrl)) {
      if ((source && !source.enabled) || (!source && shared.sourceUrl)) {
        state.value = 'need-source';
        return;
      }
      if (source) {
        await loadMarketplace(true);
        plugin = findPlugin(shared);
      }
    }

    if (!plugin) {
      reason.value = 'not-found';
      state.value = 'failed';
      return;
    }

    targetPlugin.value = plugin;
    if (plugin.installed && !plugin.updateAvailable) {
      state.value = 'installed';
      window.setTimeout(() => {
        void goPluginManagement();
      }, 700);
      return;
    }
    state.value = 'ready';
  } catch (error) {
    reason.value = 'load-failed';
    state.value = 'failed';
    toastStore.warning(error instanceof Error ? error.message : '插件分享加载失败');
  } finally {
    resolving.value = false;
  }
};

const applySource = async () => {
  const shared = target.value;
  if (!shared || isBusy.value) return;
  isBusy.value = true;
  state.value = 'loading';
  try {
    const source = findSource(shared);
    if (source) {
      if (!source.enabled) {
        const result = await window.electron.plugins?.marketplace.patchSource(source.id, {
          enabled: true,
        });
        if (!result?.ok) throw new Error(result?.error || '插件源启用失败');
        marketplaceSources.value = result.sources;
      }
    } else {
      if (!shared.sourceUrl) throw new Error('分享链接没有包含插件源地址');
      const result = await window.electron.plugins?.marketplace.addSource(
        {
          url: shared.sourceUrl,
          name: shared.pluginName ? `${shared.pluginName} 来源` : undefined,
        },
        { githubProxyUrl: settingStore.githubProxyUrl },
      );
      if (!result?.ok) throw new Error(result?.error || '插件源添加失败');
      marketplaceSources.value = result.sources;
    }
    await resolveShare(true);
  } catch (error) {
    reason.value = 'source-failed';
    state.value = 'failed';
    toastStore.warning(error instanceof Error ? error.message : '插件源处理失败');
  } finally {
    isBusy.value = false;
  }
};

const installPlugin = async () => {
  const plugin = targetPlugin.value;
  if (!plugin || installing.value || !plugin.compatibility.compatible) return;
  installing.value = true;
  try {
    const result = await window.electron.plugins?.marketplace.install(plugin.sourceId, plugin.id, {
      githubProxyUrl: settingStore.githubProxyUrl,
      enableAfterInstall: false,
    });
    if (!result?.ok) throw new Error(result?.error || '插件安装失败');
    await refreshPlugins({ reloadActive: true });
    await reloadOtherPluginRuntimes();
    state.value = 'installed';
    toastStore.actionCompleted(result.updated ? '插件已更新' : '插件已安装');
    await goPluginManagement();
  } catch (error) {
    reason.value = 'install-failed';
    state.value = 'failed';
    toastStore.warning(error instanceof Error ? error.message : '插件安装失败');
  } finally {
    installing.value = false;
  }
};

const goPluginManagement = async () => {
  const shared = target.value;
  const plugin = targetPlugin.value;
  await router.replace({
    name: 'plugin-management',
    query: {
      view: 'marketplace',
      ...(shared
        ? {
            highlightPluginId: shared.pluginId,
            ...(plugin?.sourceId || shared.sourceId
              ? { sourceId: plugin?.sourceId || shared.sourceId }
              : {}),
            ...(plugin?.sourceUrl || shared.sourceUrl
              ? { source: plugin?.sourceUrl || shared.sourceUrl }
              : {}),
            refreshMarketplace: '1',
          }
        : {}),
    },
  });
};

const retry = () => {
  void resolveShare(true);
};

onMounted(() => {
  void resolveShare(false);
});
</script>

<template>
  <div class="plugin-share-page">
    <section class="plugin-share-shell">
      <div class="plugin-share-kicker">
        <Icon :icon="iconPlugin" width="15" height="15" />
        插件分享
      </div>

      <div class="plugin-share-main">
        <div
          class="plugin-share-icon"
          :class="{
            'is-warning': state === 'failed',
            'is-success': state === 'installed',
            'is-loading': isWorking,
          }"
        >
          <Icon
            :icon="
              isWorking
                ? iconRefreshCw
                : state === 'installed'
                  ? iconCheck
                  : state === 'failed'
                    ? iconTriangleAlert
                    : iconPlugin
            "
            width="30"
            height="30"
            :class="{ 'animate-spin': isWorking }"
          />
        </div>

        <div class="plugin-share-copy">
          <h1>{{ titleText }}</h1>
          <p>{{ descriptionText }}</p>
        </div>
      </div>

      <div v-if="targetPlugin" class="plugin-share-plugin">
        <div
          class="plugin-share-plugin-icon"
          :style="{ '--plugin-accent': '#1a73e8' }"
          :class="{ 'has-icon': targetPlugin.iconUrl }"
        >
          <img v-if="targetPlugin.iconUrl" :src="targetPlugin.iconUrl" :alt="targetPlugin.name" />
          <span v-else>{{ targetPlugin.name.trim()[0]?.toUpperCase() || 'E' }}</span>
        </div>
        <div>
          <h2>{{ targetPlugin.name }}</h2>
          <p>{{ targetPlugin.description || '暂无描述' }}</p>
        </div>
      </div>

      <div v-if="installWarnings.length" class="plugin-share-warning">
        <Icon :icon="iconTriangleAlert" width="15" height="15" />
        <span>{{ installWarnings[0] }}</span>
      </div>

      <div v-if="target" class="plugin-share-meta">
        <span>插件 ID</span>
        <strong>{{ target.pluginId }}</strong>
        <span>插件源</span>
        <strong>{{ target.sourceUrl || target.sourceId || '未指定' }}</strong>
      </div>

      <div class="plugin-share-actions">
        <Button
          v-if="state === 'need-source'"
          variant="primary"
          size="sm"
          :loading="isBusy"
          @click="applySource"
        >
          {{ targetSource ? '启用并刷新' : '添加并刷新' }}
        </Button>
        <Button
          v-else-if="state === 'ready'"
          variant="primary"
          size="sm"
          :loading="installing"
          :disabled="!targetPlugin?.compatibility.compatible"
          @click="installPlugin"
        >
          {{ targetPlugin?.updateAvailable ? '更新插件' : '安装插件' }}
        </Button>
        <Button
          v-else-if="state === 'failed'"
          variant="primary"
          size="sm"
          :loading="resolving"
          @click="retry"
        >
          <Icon v-if="!resolving" :icon="iconRefreshCw" width="15" height="15" />
          重新打开
        </Button>
        <Button variant="secondary" size="sm" :disabled="isWorking" @click="goPluginManagement">
          <Icon :icon="iconArrowLeft" width="15" height="15" />
          插件管理
        </Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.plugin-share-page {
  min-height: calc(100vh - 140px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 72px;
  background: var(--color-bg-main);
}

.plugin-share-shell {
  width: min(680px, 100%);
  padding: 28px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-elevated);
}

.plugin-share-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  font-size: 12px;
  font-weight: 800;
}

.plugin-share-main,
.plugin-share-plugin {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin-top: 20px;
}

.plugin-share-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: 8px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 22%, transparent);
}

.plugin-share-icon.is-warning {
  color: var(--state-warning);
  background: color-mix(in srgb, var(--state-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--state-warning) 24%, transparent);
}

.plugin-share-icon.is-success {
  color: #0f9d58;
  background: color-mix(in srgb, #0f9d58 12%, transparent);
  border-color: color-mix(in srgb, #0f9d58 24%, transparent);
}

.plugin-share-icon.is-loading {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 28%, transparent);
}

.plugin-share-copy {
  min-width: 0;
  flex: 1;
}

.plugin-share-copy h1 {
  margin: 0;
  color: var(--color-text-main);
  font-size: 26px;
  line-height: 1.2;
  font-weight: 800;
}

.plugin-share-copy p,
.plugin-share-plugin p {
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.7;
}

.plugin-share-plugin {
  padding: 14px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--control-muted-bg);
}

.plugin-share-plugin-icon {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--plugin-accent);
  background: color-mix(in srgb, var(--plugin-accent) 12%, transparent);
  overflow: hidden;
}

.plugin-share-plugin-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.plugin-share-plugin-icon span {
  font-size: 1.35rem;
  font-weight: 800;
}

.plugin-share-plugin h2 {
  margin: 0;
  color: var(--color-text-main);
  font-size: 15px;
  font-weight: 800;
}

.plugin-share-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(245, 158, 11, 0.18);
  background: rgba(245, 158, 11, 0.08);
  color: rgb(180, 83, 9);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.55;
}

:global(.dark) .plugin-share-warning {
  color: rgb(251, 191, 36);
}

.plugin-share-meta {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px 14px;
  margin-top: 18px;
  padding: 14px;
  border-radius: 8px;
  background: var(--control-muted-bg);
}

.plugin-share-meta span {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 800;
}

.plugin-share-meta strong {
  min-width: 0;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.plugin-share-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 22px;
}

@media (max-width: 560px) {
  .plugin-share-main,
  .plugin-share-plugin {
    flex-direction: column;
  }

  .plugin-share-meta {
    grid-template-columns: 1fr;
  }
}
</style>
