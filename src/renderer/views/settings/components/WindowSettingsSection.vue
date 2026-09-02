<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import type { CloseBehavior } from '../../../../shared/app';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { closeBehaviorOptions, sectionTitles } from '../constants';

const settingStore = useSettingStore();
const platform = window.electron?.platform;
const isWindows = computed(() => platform === 'win32');
const supportsCustomWindowControls = computed(() => platform === 'win32' || platform === 'linux');
</script>

<template>
  <SettingsSectionShell id="window" :title="sectionTitles.window.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.window.icon"
        :icon="sectionTitles.window.icon"
        width="20"
        height="20"
        class="text-primary"
      />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">记住窗口大小</h3>
        <p class="text-sm text-text-secondary">在下次启动时自动恢复窗口大小和位置</p>
      </div>
      <Switch v-model="settingStore.rememberWindowSize" />
    </div>
    <template v-if="supportsCustomWindowControls">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">全屏按钮</h3>
          <p class="text-sm text-text-secondary">在标题栏显示全屏按钮</p>
        </div>
        <Switch v-model="settingStore.showFullscreenButton" />
      </div>
    </template>
    <template v-if="isWindows">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">任务栏封面预览</h3>
          <p class="text-sm text-text-secondary">在任务栏窗口以及后台窗口显示封面和歌曲标题</p>
        </div>
        <Switch
          :model-value="settingStore.taskbarCoverPreview"
          @update:model-value="
            settingStore.taskbarCoverPreview = Boolean($event);
            settingStore.syncTaskbarCoverPreview();
          "
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">任务栏播放进度条</h3>
          <p class="text-sm text-text-secondary">在任务栏显示播放进度</p>
        </div>
        <Switch
          :model-value="settingStore.taskbarProgress"
          @update:model-value="
            settingStore.taskbarProgress = Boolean($event);
            settingStore.syncTaskbarProgress();
          "
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">关闭行为</h3>
        <p class="text-sm text-text-secondary">点击窗口关闭按钮时的应用行为</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.closeBehavior"
        :options="closeBehaviorOptions"
        @update:model-value="
          settingStore.closeBehavior = $event as CloseBehavior;
          settingStore.syncCloseBehavior();
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">开机自启动</h3>
        <p class="text-sm text-text-secondary">登录系统时自动启动应用</p>
      </div>
      <Switch
        v-model="settingStore.autoLaunch"
        @update:model-value="settingStore.syncAutoLaunch()"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启动时最小化到托盘</h3>
        <p class="text-sm text-text-secondary">启动后不显示主窗口，直接最小化到系统托盘</p>
      </div>
      <Switch
        v-model="settingStore.startMinimized"
        @update:model-value="settingStore.syncStartMinimized()"
      />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
