<script setup lang="ts">
import PluginSourceInfo from './PluginSourceInfo.vue';
import { getPluginSourceName } from '../../../shared/plugin-source';
import Tooltip from '@/components/ui/Tooltip.vue';

import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import {
  iconArrowBarToDown,
  iconCheck,
  iconExternalLink,
  iconPulse,
  iconRefreshCw,
  iconShare,
  iconTriangleAlert,
} from '@/icons';
import type { PluginMarketplacePlugin } from '../../../shared/plugins';

defineProps<{
  plugin: PluginMarketplacePlugin;
  pluginKey: string;
  highlighted: boolean;
  busy: boolean;
  updatingAll: boolean;
  accentStyle: Record<string, string>;
  statusLabel: string;
  statusTitle: string;
  installLabel: string;
  installTitle: string;
  compatibilityMessage: string;
  canInstall: boolean;
  featureTags: string[];
}>();

const emit = defineEmits<{
  (e: 'share', plugin: PluginMarketplacePlugin): void;
  (e: 'install', plugin: PluginMarketplacePlugin): void;
  (e: 'open-external', url: string): void;
}>();

const getInitial = (plugin: Pick<PluginMarketplacePlugin, 'name'>) =>
  plugin.name.trim()[0]?.toUpperCase() || 'E';

const formatCount = (value: number) =>
  new Intl.NumberFormat('zh-CN', {
    notation: value >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Math.max(0, Number(value) || 0));

const getStatsTitle = (plugin: PluginMarketplacePlugin) =>
  `安装/更新 ${formatCount(plugin.stats.installCount + plugin.stats.updateCount)} · 安装 ${formatCount(plugin.stats.installCount)} · 更新 ${formatCount(plugin.stats.updateCount)}`;

const getVersionTitle = (plugin: PluginMarketplacePlugin) => {
  if (!plugin.installed) return `最新版本 v${plugin.version}`;
  if (plugin.updateAvailable)
    return `已安装 v${plugin.installedVersion}，可更新至 v${plugin.version}`;
  return `已安装 v${plugin.installedVersion}`;
};
</script>

<template>
  <article
    :data-marketplace-plugin-key="pluginKey"
    class="plugin-card marketplace-card"
    :class="{
      'is-disabled': !plugin.compatibility.compatible,
      'is-warning': !plugin.compatibility.compatible,
      'is-shared-target': highlighted,
    }"
  >
    <div class="plugin-card-main">
      <div class="plugin-card-media" :class="{ 'has-icon': plugin.iconUrl }" :style="accentStyle">
        <img
          v-if="plugin.iconUrl"
          :src="plugin.iconUrl"
          :alt="plugin.name"
          class="plugin-card-icon"
        />
        <span v-else class="plugin-card-initial">
          {{ getInitial(plugin) }}
        </span>
      </div>

      <div class="plugin-card-summary">
        <div class="plugin-card-header">
          <Tooltip :content="plugin.name" overflow-only>
            <template #trigger>
              <h3 class="plugin-card-name">{{ plugin.name }}</h3>
            </template>
          </Tooltip>
          <Tooltip :content="statusTitle">
            <template #trigger>
              <span
                class="plugin-status-badge"
                :class="{
                  'is-active': plugin.installed && !plugin.updateAvailable,
                  'is-warning': plugin.updateAvailable || !plugin.compatibility.compatible,
                }"
              >
                {{ statusLabel }}
              </span>
            </template>
          </Tooltip>
        </div>

        <div v-if="plugin.author" class="plugin-card-meta">{{ plugin.author }}</div>
      </div>
    </div>

    <div class="plugin-card-version-source">
      <Tooltip :content="getVersionTitle(plugin)">
        <template #trigger>
          <span class="plugin-card-version">v{{ plugin.version }}</span>
        </template>
      </Tooltip>
      <PluginSourceInfo :name="getPluginSourceName(plugin.sourceName, plugin.sourceUrl)" />
    </div>

    <div v-if="plugin.installed && plugin.updateAvailable" class="marketplace-version-row">
      <span class="marketplace-version-pill is-update">
        <span>已装</span>
        <strong>v{{ plugin.installedVersion }}</strong>
      </span>
    </div>

    <Tooltip :content="plugin.description || '暂无描述'" overflow-only>
      <template #trigger>
        <p class="plugin-card-description">
          {{ plugin.description || '暂无描述' }}
        </p>
      </template>
    </Tooltip>

    <div v-if="compatibilityMessage" class="plugin-card-error is-warning">
      <Icon :icon="iconTriangleAlert" width="14" height="14" />
      <span>{{ compatibilityMessage }}</span>
    </div>

    <div v-if="plugin.tags.length" class="marketplace-tags">
      <span v-for="tag in plugin.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
    </div>

    <div v-if="featureTags.length" class="plugin-feature-tags">
      <span v-for="tag in featureTags.slice(0, 5)" :key="tag">
        {{ tag }}
      </span>
    </div>

    <div class="plugin-card-details">
      <Tooltip :content="plugin.id" overflow-only>
        <template #trigger>
          <div class="plugin-card-id">ID: {{ plugin.id }}</div>
        </template>
      </Tooltip>
    </div>

    <Tooltip :content="getStatsTitle(plugin)">
      <template #trigger>
        <div class="marketplace-stats">
          <Tooltip content="安装和更新总量">
            <template #trigger>
              <span class="marketplace-stat-item">
                <Icon :icon="iconArrowBarToDown" width="13" height="13" />
                {{ formatCount(plugin.stats.installCount + plugin.stats.updateCount) }}
              </span>
            </template>
          </Tooltip>
          <Tooltip content="更新量">
            <template #trigger>
              <span class="marketplace-stat-item">
                <Icon :icon="iconRefreshCw" width="13" height="13" />
                {{ formatCount(plugin.stats.updateCount) }}
              </span>
            </template>
          </Tooltip>
          <Tooltip content="热度">
            <template #trigger>
              <span class="marketplace-stat-item">
                <Icon :icon="iconPulse" width="13" height="13" />
                {{ formatCount(plugin.stats.score) }}
              </span>
            </template>
          </Tooltip>
        </div>
      </template>
    </Tooltip>

    <div class="plugin-card-actions">
      <div class="plugin-card-primary-actions">
        <Button
          variant="ghost"
          size="xs"
          class="plugin-settings-btn"
          tooltip="复制插件分享链接"
          @click="emit('share', plugin)"
        >
          <Icon :icon="iconShare" width="14" height="14" />
          分享
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="plugin-settings-btn"
          :disabled="!plugin.repo"
          @click="emit('open-external', plugin.repo || plugin.homepage)"
        >
          <Icon :icon="iconExternalLink" width="14" height="14" />
          仓库
        </Button>
      </div>

      <Button
        variant="primary"
        size="xs"
        class="marketplace-install-btn"
        :tooltip="installTitle"
        :loading="busy"
        :disabled="!canInstall || updatingAll || busy"
        @click="emit('install', plugin)"
      >
        <Icon
          v-if="plugin.installed && !plugin.updateAvailable"
          :icon="iconCheck"
          width="14"
          height="14"
        />
        <Icon v-else :icon="iconArrowBarToDown" width="14" height="14" />
        {{ installLabel }}
      </Button>
    </div>
  </article>
</template>
