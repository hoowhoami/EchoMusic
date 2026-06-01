<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import type { ShortcutScope } from '@/types';
import type { ShortcutCommand } from '../../../../shared/shortcuts';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles, shortcutItems } from '../constants';
import { useSettingsShortcuts } from '../composables/useSettingsShortcuts';

const settingStore = useSettingStore();
const {
  getShortcutPlaceholder,
  getShortcutValue,
  isRecording,
  isShortcutModified,
  resetAllShortcuts,
  resetShortcut,
  startRecording,
} = useSettingsShortcuts();

const handleResetBoth = (command: ShortcutCommand) => {
  resetShortcut(command, 'local' as ShortcutScope);
  resetShortcut(command, 'global' as ShortcutScope);
};
</script>

<template>
  <SettingsSectionShell id="shortcuts" :title="sectionTitles.shortcuts.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.shortcuts.icon"
        :icon="sectionTitles.shortcuts.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="shortcut-grid-header">
      <div>功能说明</div>
      <div class="shortcut-col-title">快捷键</div>
      <div class="shortcut-col-title">全局快捷键</div>
      <div></div>
    </div>
    <div class="settings-divider"></div>
    <div class="shortcut-list">
      <div v-for="item in shortcutItems" :key="item.command" class="shortcut-grid-row">
        <div class="space-y-1">
          <h3 class="font-semibold">{{ item.title }}</h3>
          <p class="text-sm text-text-secondary">{{ item.desc }}</p>
        </div>
        <div class="shortcut-cell shortcut-cell-offset">
          <input
            class="shortcut-input"
            :class="{ recording: isRecording(item.command, 'local') }"
            :value="getShortcutValue(item.command, 'local')"
            :placeholder="getShortcutPlaceholder(item.command, 'local')"
            readonly
            @click="startRecording(item.command, 'local')"
            @focus="startRecording(item.command, 'local')"
          />
        </div>
        <div class="shortcut-cell shortcut-cell-offset">
          <input
            class="shortcut-input"
            :class="{
              recording: isRecording(item.command, 'global'),
              'shortcut-input-disabled': !settingStore.globalShortcutsEnabled,
            }"
            :value="getShortcutValue(item.command, 'global')"
            :placeholder="getShortcutPlaceholder(item.command, 'global')"
            :disabled="!settingStore.globalShortcutsEnabled"
            readonly
            @click="startRecording(item.command, 'global')"
            @focus="startRecording(item.command, 'global')"
          />
        </div>
        <div class="shortcut-cell-reset">
          <button
            v-if="
              isShortcutModified(item.command, 'local') ||
              isShortcutModified(item.command, 'global')
            "
            type="button"
            class="shortcut-reset-btn"
            title="恢复默认"
            @click="handleResetBoth(item.command)"
          >
            重置
          </button>
        </div>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启用全局快捷键</h3>
        <p class="text-sm text-text-secondary">允许应用在后台响应系统级快捷键</p>
      </div>
      <Switch v-model="settingStore.globalShortcutsEnabled" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">恢复默认</h3>
        <p class="text-sm text-text-secondary">恢复所有快捷键为默认</p>
      </div>
      <Button variant="outline" size="xs" class="settings-button" @click="resetAllShortcuts">
        恢复默认
      </Button>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
