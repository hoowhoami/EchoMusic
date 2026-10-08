<script setup lang="ts">
import { computed } from 'vue';
import PluginCardOrigin from './PluginCardOrigin.vue';
import { getPluginSourceName } from '../../../shared/pluginSource';
import Tooltip from '@/components/ui/Tooltip.vue';

import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Tag from '@/components/ui/Tag.vue';
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

const props = defineProps<{
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

const displayTags = computed(() => [...new Set([...props.plugin.tags, ...props.featureTags])]);

const versionLabel = computed(() => {
  const plugin = props.plugin;
  if (!plugin.installed) return `v${plugin.version}`;
  const installedVersion = plugin.installedVersion ? `v${plugin.installedVersion}` : '版本未知';
  return plugin.updateAvailable ? `${installedVersion} → v${plugin.version}` : installedVersion;
});

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

const getVersionTitle = (plugin: PluginMarketplacePlugin) => {
  if (!plugin.installed) return `可安装版本 v${plugin.version}`;
  const installedVersion = plugin.installedVersion ? `v${plugin.installedVersion}` : '版本未知';
  if (plugin.updateAvailable) return `已安装 ${installedVersion}，可更新至 v${plugin.version}`;
  return `已安装 ${installedVersion}`;
};
</script>

<template>
  <article
    :data-marketplace-plugin-key="pluginKey"
    class="plugin-card card-hover card-hover-border marketplace-card"
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

      <div class="plugin-card-header">
        <Tooltip :content="plugin.name" overflow-only>
          <template #trigger>
            <h3 class="plugin-card-name">{{ plugin.name }}</h3>
          </template>
        </Tooltip>
        <Tooltip
          v-if="plugin.updateAvailable || !plugin.compatibility.compatible"
          :content="statusTitle"
        >
          <template #trigger>
            <Tag size="sm" class="plugin-status-badge is-warning">
              {{ statusLabel }}
            </Tag>
          </template>
        </Tooltip>
      </div>

      <div class="plugin-card-byline">
        <div v-if="plugin.author" class="plugin-card-meta">{{ plugin.author }}</div>
        <Tooltip :content="getVersionTitle(plugin)">
          <template #trigger>
            <span class="plugin-card-version">{{ versionLabel }}</span>
          </template>
        </Tooltip>
      </div>
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

    <div v-if="displayTags.length" class="plugin-feature-tags">
      <Tag v-for="tag in displayTags" :key="tag" size="sm">{{ tag }}</Tag>
    </div>

    <div class="plugin-card-details">
      <PluginCardOrigin
        :id="plugin.id"
        :source-name="getPluginSourceName(plugin.sourceName, plugin.sourceUrl)"
      />
      <div class="marketplace-stats">
        <Tooltip content="安装和更新总量">
          <template #trigger>
            <span class="marketplace-stat-item">
              <Icon :icon="iconArrowBarToDown" width="13" height="13" />
              <span class="marketplace-stat-value">{{
                formatCount(plugin.stats.installCount + plugin.stats.updateCount)
              }}</span>
            </span>
          </template>
        </Tooltip>
        <Tooltip content="更新量">
          <template #trigger>
            <span class="marketplace-stat-item">
              <Icon :icon="iconRefreshCw" width="13" height="13" />
              <span class="marketplace-stat-value">{{
                formatCount(plugin.stats.updateCount)
              }}</span>
            </span>
          </template>
        </Tooltip>
        <Tooltip content="热度">
          <template #trigger>
            <span class="marketplace-stat-item">
              <Icon :icon="iconPulse" width="13" height="13" />
              <span class="marketplace-stat-value">{{ formatCount(plugin.stats.score) }}</span>
            </span>
          </template>
        </Tooltip>
      </div>
    </div>

    <div class="plugin-card-actions">
      <div class="plugin-card-primary-actions">
        <Button
          variant="secondary"
          size="xs"
          class="plugin-share-btn"
          tooltip="复制插件分享链接"
          @click="emit('share', plugin)"
        >
          <Icon :icon="iconShare" width="14" height="14" />
          分享
        </Button>
        <Button
          variant="secondary"
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
