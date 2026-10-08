<script setup lang="ts">
import { computed } from 'vue';
import PluginCardOrigin from './PluginCardOrigin.vue';
import { getInstalledPluginSourceName } from '../../../shared/pluginSource';
import Tooltip from '@/components/ui/Tooltip.vue';

import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import Tag from '@/components/ui/Tag.vue';
import { iconSettings, iconTriangleAlert } from '@/icons';
import type { PluginRuntimeRecord } from '@/plugins/runtime';

type FailureDetail = {
  reason: string;
  isHistorical?: boolean;
} | null;

const props = defineProps<{
  record: PluginRuntimeRecord;
  busy: boolean;
  safeMode: boolean;
  iconUrl: string;
  initial: string;
  accentStyle: Record<string, string>;
  statusLabel: string;
  statusTitle: string;
  compatibilityMessage: string;
  featureTags: string[];
  cardFailure: FailureDetail;
  hasCurrentFailure: boolean;
  hasFailure: boolean;
  hasHistoricalFailure: boolean;
  failureTitle: string;
  settingsAvailable: boolean;
  settingsTitle: string;
}>();

const displayTags = computed(() => [
  ...new Set([...(props.record.descriptor.tags ?? []), ...props.featureTags]),
]);

const emit = defineEmits<{
  (e: 'toggle', pluginId: string, enabled: boolean): void;
  (e: 'settings', record: PluginRuntimeRecord): void;
  (e: 'uninstall', pluginId: string): void;
  (e: 'failure-detail', pluginId: string): void;
  (e: 'icon-error', pluginId: string): void;
}>();
</script>

<template>
  <article
    class="plugin-card card-hover card-hover-border"
    :class="{
      'is-disabled':
        !record.descriptor.enabled ||
        record.descriptor.invalid ||
        !record.descriptor.compatibility.compatible,
      'is-error': hasCurrentFailure && cardFailure?.reason !== 'incompatible',
      'is-warning': cardFailure?.reason === 'incompatible',
    }"
  >
    <div class="plugin-card-main">
      <div class="plugin-card-media" :class="{ 'has-icon': iconUrl }" :style="accentStyle">
        <img
          v-if="iconUrl"
          :src="iconUrl"
          :alt="record.descriptor.name"
          class="plugin-card-icon"
          @error="emit('icon-error', record.descriptor.id)"
        />
        <span v-else class="plugin-card-initial">
          {{ initial }}
        </span>
      </div>

      <div class="plugin-card-header">
        <Tooltip :content="record.descriptor.name" overflow-only>
          <template #trigger>
            <h3 class="plugin-card-name">
              {{ record.descriptor.name }}
            </h3>
          </template>
        </Tooltip>
        <Tooltip :content="statusTitle">
          <template #trigger>
            <Tag
              size="sm"
              class="plugin-status-badge"
              :class="{
                'is-active': record.status === 'active' && !hasCurrentFailure,
                'is-error': hasCurrentFailure && cardFailure?.reason !== 'incompatible',
                'is-safe': safeMode && record.descriptor.enabled && !hasCurrentFailure,
                'is-warning': cardFailure?.reason === 'incompatible',
              }"
            >
              {{ statusLabel }}
            </Tag>
          </template>
        </Tooltip>
      </div>

      <div class="plugin-card-byline">
        <div v-if="record.descriptor.manifest.author" class="plugin-card-meta">
          {{ record.descriptor.manifest.author }}
        </div>
        <span class="plugin-card-version">v{{ record.descriptor.version }}</span>
      </div>
    </div>

    <Tooltip :content="record.descriptor.description || '暂无描述'" overflow-only>
      <template #trigger>
        <p class="plugin-card-description">
          {{ record.descriptor.description || '暂无描述' }}
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
        :id="record.descriptor.id"
        :source-name="getInstalledPluginSourceName(record.descriptor.installSource)"
      />
    </div>

    <div class="plugin-card-actions">
      <div class="plugin-card-action-group">
        <div class="plugin-card-primary-actions">
          <Button
            variant="secondary"
            size="xs"
            class="plugin-settings-btn"
            :class="{ 'is-unavailable': !settingsAvailable }"
            :tooltip="settingsTitle"
            :disabled="busy"
            @click="emit('settings', record)"
          >
            <Icon :icon="iconSettings" width="14" height="14" />
            设置
          </Button>

          <Button
            variant="danger"
            size="xs"
            class="plugin-remove-btn"
            :disabled="busy"
            @click="emit('uninstall', record.descriptor.id)"
          >
            移除
          </Button>
        </div>

        <Tooltip v-if="hasFailure" :content="failureTitle">
          <template #trigger>
            <button
              class="action-icon plugin-card-failure-btn"
              :class="{
                'is-historical': hasHistoricalFailure,
                'is-warning': cardFailure?.reason === 'incompatible',
              }"
              type="button"
              :aria-label="failureTitle"
              @click="emit('failure-detail', record.descriptor.id)"
            >
              <Icon :icon="iconTriangleAlert" width="14" height="14" />
            </button>
          </template>
        </Tooltip>
      </div>

      <Switch
        :model-value="record.descriptor.enabled"
        :disabled="record.descriptor.invalid || !record.descriptor.compatibility.compatible || busy"
        @update:model-value="(value) => emit('toggle', record.descriptor.id, value)"
      />
    </div>
  </article>
</template>
