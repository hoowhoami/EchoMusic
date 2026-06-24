<script setup lang="ts">
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import {
  iconArrowBarDown,
  iconCheck,
  iconExternalLink,
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
          <h3 class="plugin-card-name" :title="plugin.name">{{ plugin.name }}</h3>
          <span
            class="plugin-status-badge"
            :title="statusTitle"
            :class="{
              'is-active': plugin.installed && !plugin.updateAvailable,
              'is-warning': plugin.updateAvailable || !plugin.compatibility.compatible,
            }"
          >
            {{ statusLabel }}
          </span>
        </div>

        <div class="plugin-card-meta">
          <span>v{{ plugin.version }}</span>
          <span v-if="plugin.author"> · {{ plugin.author }}</span>
        </div>
      </div>
    </div>

    <p class="plugin-card-description">{{ plugin.description || '暂无描述' }}</p>

    <div v-if="compatibilityMessage" class="plugin-card-error is-warning">
      <Icon :icon="iconTriangleAlert" width="14" height="14" />
      <span>{{ compatibilityMessage }}</span>
    </div>

    <div class="marketplace-tags">
      <span>{{ plugin.sourceName }}</span>
      <span v-for="tag in plugin.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
    </div>

    <div v-if="featureTags.length" class="plugin-feature-tags">
      <span v-for="tag in featureTags.slice(0, 5)" :key="tag">
        {{ tag }}
      </span>
    </div>

    <div class="plugin-card-id" :title="plugin.id">ID: {{ plugin.id }}</div>

    <div class="plugin-card-actions">
      <div class="plugin-card-primary-actions">
        <Button
          variant="ghost"
          size="xs"
          class="plugin-settings-btn"
          title="复制插件分享链接"
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
        :title="installTitle"
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
        <Icon v-else :icon="iconArrowBarDown" width="14" height="14" />
        {{ installLabel }}
      </Button>
    </div>
  </article>
</template>
