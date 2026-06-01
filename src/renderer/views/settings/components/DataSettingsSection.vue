<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Button from '@/components/ui/Button.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
defineProps<{
  onClear: () => void;
}>();
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
</template>

<style scoped src="../settingsSection.css"></style>
