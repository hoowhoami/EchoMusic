<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import Switch from '@/components/ui/Switch.vue';
import { iconPlus, iconTrash } from '@/icons';
import type { PluginMarketplaceSource } from '../../../shared/plugins';

const props = defineProps<{
  open: boolean;
  sources: PluginMarketplaceSource[];
  busySourceIds: Set<string>;
  adding: boolean;
  sourceUrl: string;
  sourceName: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:sourceUrl', value: string): void;
  (e: 'update:sourceName', value: string): void;
  (e: 'add'): void;
  (e: 'patch', source: PluginMarketplaceSource, patch: { name?: string; enabled?: boolean }): void;
  (e: 'remove', source: PluginMarketplaceSource): void;
}>();

const canAdd = computed(() => Boolean(props.sourceUrl.trim()) && !props.adding);
</script>

<template>
  <Dialog
    :open="open"
    title="插件源"
    description="添加 GitHub 仓库地址后，EchoMusic 会读取 echo-plugins.json 索引并同步插件清单。"
    show-close
    content-class="plugin-source-dialog"
    body-class="plugin-source-dialog-body"
    @update:open="emit('update:open', $event)"
  >
    <div class="plugin-source-manager">
      <div class="plugin-source-add">
        <Input
          :model-value="sourceUrl"
          placeholder="https://github.com/owner/repo"
          input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          @update:model-value="emit('update:sourceUrl', $event)"
        />
        <Input
          :model-value="sourceName"
          placeholder="显示名称，可选"
          input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          @update:model-value="emit('update:sourceName', $event)"
        />
        <Button
          variant="primary"
          size="xs"
          :loading="adding"
          :disabled="!canAdd"
          @click="emit('add')"
        >
          <Icon :icon="iconPlus" width="14" height="14" />
          添加
        </Button>
      </div>

      <div v-if="sources.length === 0" class="plugin-source-empty">暂无插件源</div>

      <div v-else class="plugin-source-list">
        <div v-for="source in sources" :key="source.id" class="plugin-source-row">
          <div class="plugin-source-main">
            <div class="plugin-source-title">
              <strong>{{ source.name }}</strong>
              <span v-if="source.official">官方</span>
            </div>
            <p :title="source.url">{{ source.url }}</p>
            <small>
              {{ source.pluginCount }} 个插件
              <template v-if="source.lastFetchedAt">
                · {{ new Date(source.lastFetchedAt).toLocaleString() }}
              </template>
            </small>
            <div v-if="source.lastError" class="plugin-source-error">
              {{ source.lastError }}
            </div>
          </div>

          <div class="plugin-source-actions">
            <Switch
              :model-value="source.enabled"
              :disabled="busySourceIds.has(source.id)"
              @update:model-value="(enabled) => emit('patch', source, { enabled })"
            />
            <Button
              variant="ghost"
              size="xs"
              class="plugin-source-delete-btn"
              :title="source.official ? '官方插件源可停用，但不能删除' : '删除插件源'"
              :disabled="source.official || busySourceIds.has(source.id)"
              @click="emit('remove', source)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Dialog>
</template>
