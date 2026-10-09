<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { iconLockOpen, iconRefreshCw } from '@/icons';
import type {
  PluginFileGrantGroup,
  PluginGrantManagementAction,
} from '../../../shared/pluginFiles';
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const groups = ref<PluginFileGrantGroup[]>([]),
  error = ref(''),
  busy = ref(false);
let revision = 0;
const load = async (pluginId?: string, grantId?: string, action?: PluginGrantManagementAction) => {
  const current = ++revision;
  busy.value = true;
  error.value = '';
  try {
    const result = await window.electron.plugins?.manageGrants(pluginId, grantId, action);
    if (current !== revision || !props.open) return;
    if (!result?.ok) error.value = result?.error.message ?? '授权管理不可用';
    else groups.value = result.value;
  } catch (e) {
    if (current === revision) error.value = e instanceof Error ? e.message : '读取授权失败';
  } finally {
    if (current === revision) busy.value = false;
  }
};
watch(
  () => props.open,
  () => {
    revision++;
    groups.value = [];
    error.value = '';
    if (props.open) void load();
  },
  { immediate: true },
);
</script>
<template>
  <Dialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="已授权文件与目录"
    description="统一查看和撤销插件授权。已撤销的记录可移除，实际文件与目录会保留。"
    show-close
    content-class="plugin-authorized-files-dialog"
    :content-style="{ width: 'min(520px, 92vw)' }"
  >
    <div v-if="error" class="grant-error" role="alert">
      <p>{{ error }}</p>
      <Button variant="secondary" size="xs" :disabled="busy" @click="load()">重试</Button>
    </div>
    <div v-else-if="!groups.length" class="grant-empty" role="status" aria-live="polite">
      <span class="grant-empty-icon" aria-hidden="true">
        <Icon :icon="busy ? iconRefreshCw : iconLockOpen" width="24" height="24" />
      </span>
      <p class="grant-empty-title">{{ busy ? '正在读取授权…' : '尚未授权任何文件或目录' }}</p>
      <p v-if="!busy" class="grant-empty-description">
        在插件中选择文件或目录后，可在这里查看和撤销授权。
      </p>
    </div>
    <section v-for="group in groups" :key="group.pluginId" class="grant-group">
      <div class="grant-group-heading">
        <h3>{{ group.pluginName }}</h3>
        <span>{{ group.grants.length }} 项授权</span>
      </div>
      <div v-for="grant in group.grants" :key="grant.id" class="grant-row">
        <div class="grant-details">
          <strong class="grant-name">{{ grant.name }}</strong>
          <p class="grant-path">{{ grant.displayPath }}</p>
          <div class="grant-meta">
            <span>{{ grant.kind === 'file' ? '文件' : '目录' }}</span>
            <span>{{ grant.access === 'read' ? '只读' : '读写' }}</span>
            <span :class="{ 'grant-status-muted': grant.revoked || !grant.available }">
              {{ grant.revoked ? '已撤销' : grant.available ? '可用' : '不可用' }}
            </span>
          </div>
          <p v-if="grant.revoked" class="grant-hint">重新使用请在对应插件中选择文件或目录。</p>
        </div>
        <div class="grant-actions">
          <Button
            :disabled="busy"
            :aria-label="
              grant.revoked ? `移除 ${grant.name} 的授权记录` : `撤销 ${grant.name} 的授权`
            "
            variant="secondary"
            size="xs"
            @click="load(group.pluginId, grant.id, grant.revoked ? 'remove' : 'revoke')"
            >{{ grant.revoked ? '移除记录' : '撤销' }}</Button
          >
        </div>
      </div>
    </section>
    <template #footer>
      <Button variant="secondary" size="xs" @click="emit('update:open', false)">关闭</Button>
    </template>
  </Dialog>
</template>
<style scoped>
:global(.plugin-authorized-files-dialog .dialog-header) {
  padding-right: 64px;
}
.grant-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 28px 20px;
  margin-top: 12px;
  border: 1px solid var(--border-light);
  border-radius: 12px;
  background: var(--control-muted-bg);
  text-align: center;
}
.grant-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: 14px;
  border-radius: 14px;
  background: var(--control-hover-bg);
  color: var(--color-text-secondary);
}
.grant-empty-title {
  font-weight: 600;
}
.grant-empty-description {
  max-width: 320px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
.grant-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  margin: 12px 0;
  border: 1px solid var(--border-light);
  border-radius: 12px;
}
.grant-error p {
  min-width: 0;
  overflow-wrap: anywhere;
}
.grant-group {
  margin-top: 16px;
}
.grant-group-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.grant-group-heading h3 {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}
.grant-group-heading > span {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.grant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--border-light);
  border-radius: 12px;
  background: var(--control-muted-bg);
}
.grant-row + .grant-row {
  margin-top: 8px;
}
.grant-details {
  min-width: 0;
}
.grant-name {
  overflow-wrap: anywhere;
  font-weight: 600;
}
.grant-path {
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  margin: 4px 0 8px;
}
.grant-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
}
.grant-meta > span {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--control-hover-bg);
  color: var(--color-text-secondary);
}
.grant-status-muted {
  opacity: 0.7;
}
.grant-hint {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
.grant-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .grant-row {
    flex-wrap: wrap;
  }
  .grant-details {
    flex-basis: 100%;
  }
  .grant-actions {
    margin-left: auto;
  }
}
</style>
