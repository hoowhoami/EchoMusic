<script setup lang="ts">
import { useThemeStore } from '@/stores/theme';
import type { AppearanceMode } from '@/theme/model';
import Select from '@/components/ui/Select.vue';
const theme = useThemeStore();
const modes = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
</script>
<template>
  <div class="settings-item display-mode-row">
    <div class="space-y-1">
      <h3 class="font-semibold">深浅色模式</h3>
      <p class="text-sm text-text-secondary">选择主题的深浅配色，自定义背景保留所选文字颜色</p>
    </div>
    <Select
      :model-value="theme.nativeThemeSource"
      :options="modes"
      aria-label="深浅色模式"
      class="w-36 shrink-0"
      @update:model-value="theme.updateGeneralPreferences({ mode: $event as AppearanceMode })"
    />
  </div>
</template>
<style scoped src="../settingsSection.css"></style>
<style scoped>
@media (max-width: 650px) {
  .display-mode-row {
    flex-wrap: wrap;
    gap: 16px;
  }
}
</style>
