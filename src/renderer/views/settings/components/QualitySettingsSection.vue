<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import type { AudioQualityValue } from '@/types';
import Switch from '@/components/ui/Switch.vue';
import Select from '@/components/ui/Select.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import { sectionTitles, audioQualityOptions } from '../constants';
import SettingsSectionShell from './SettingsSectionShell.vue';

const settingStore = useSettingStore();
</script>

<template>
  <SettingsSectionShell id="quality" :title="sectionTitles.quality.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.quality.icon"
        :icon="sectionTitles.quality.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">默认音质</h3>
        <p class="text-sm text-text-secondary">
          新歌曲默认按此音质解析，播放器中可临时覆盖当前歌曲
        </p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.defaultAudioQuality"
        :options="audioQualityOptions"
        @update:model-value="settingStore.defaultAudioQuality = $event as AudioQualityValue"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">智能兼容模式</h3>
        <p class="text-sm text-text-secondary">首选音质不可用时自动尝试备选</p>
      </div>
      <Switch v-model="settingStore.compatibilityMode" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
