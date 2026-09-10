<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { iconPlugin } from '@/icons';
import { sectionTitles } from '../constants';
import { pluginRuntimeState } from '@/plugins/runtime';

const router = useRouter();
const title = sectionTitles.plugins;
const resolvedTitle = computed(() => title.label);

const pluginCount = computed(() => pluginRuntimeState.records.length);
const enabledCount = computed(
  () => pluginRuntimeState.records.filter((r) => r.descriptor.enabled).length,
);

const handleOpenPluginManagement = () => {
  router.push('/main/settings/plugins');
};

const handleOpenDocs = () => {
  window.electron.ipcRenderer.send(
    'open-external',
    'https://github.com/hoowhoami/EchoMusicPlugins',
  );
};
</script>

<template>
  <SettingsSectionShell id="plugins" :title="resolvedTitle">
    <template #icon>
      <Icon :icon="iconPlugin" width="20" height="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">插件管理</h3>
        <p class="text-sm text-text-secondary">
          浏览在线插件源，管理已安装插件和插件设置
          <span v-if="pluginCount > 0">（{{ enabledCount }}/{{ pluginCount }} 个已启用）</span>
        </p>
      </div>
      <Button
        variant="unstyled"
        size="none"
        class="settings-action"
        @click="handleOpenPluginManagement"
      >
        管理面板
      </Button>
    </div>

    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">插件文档</h3>
        <p class="text-sm text-text-secondary">了解如何开发和使用插件</p>
      </div>
      <Button variant="unstyled" size="none" class="settings-action" @click="handleOpenDocs">
        查看文档
      </Button>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
