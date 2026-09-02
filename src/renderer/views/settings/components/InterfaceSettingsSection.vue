<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Switch from '@/components/ui/Switch.vue';
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
        class="text-primary"
      />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音质音效徽标</h3>
        <p class="text-sm text-text-secondary">在播放器音质按钮上显示当前实际音质或音效标识</p>
      </div>
      <Switch v-model="settingStore.showAudioQualityBadge" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">桌面歌词状态</h3>
        <p class="text-sm text-text-secondary">在播放器桌面歌词图标上显示开启或关闭状态角标</p>
      </div>
      <Switch v-model="settingStore.showDesktopLyricStatus" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放列表计数</h3>
        <p class="text-sm text-text-secondary">在播放器播放列表图标上显示计数</p>
      </div>
      <Switch v-model="settingStore.showPlaylistCount" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">搜索框默认推荐词</h3>
        <p class="text-sm text-text-secondary">在搜索框显示默认推荐词，可能有广告</p>
      </div>
      <Switch v-model="settingStore.searchDefaultEnabled" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">侧边栏折叠</h3>
        <p class="text-sm text-text-secondary">启用后可通过快捷键或标题栏按钮折叠侧边栏</p>
      </div>
      <Switch v-model="settingStore.sidebarCollapseEnabled" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
