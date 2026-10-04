<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Switch from '@/components/ui/Switch.vue';
import DisplayModeControl from './DisplayModeControl.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
</script>

<template>
  <SettingsSectionShell id="interface" :title="sectionTitles.interface.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.interface.icon"
        :icon="sectionTitles.interface.icon"
        width="20"
        height="20"
        class="text-primary-text"
      />
    </template>

    <DisplayModeControl />
    <div class="settings-divider" />
    <div class="settings-item">
      <div>
        <h3>专辑动态封面</h3>
        <p class="text-sm text-text-secondary">在专辑详情展示动态封面，播放页可单独设置</p>
      </div>
      <Switch v-model="settingStore.dynamicAlbumCover" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">搜索框默认推荐词</h3>
        <p class="text-sm text-text-secondary">在搜索框显示默认推荐词，可能有广告</p>
      </div>
      <Switch v-model="settingStore.searchDefaultEnabled" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
