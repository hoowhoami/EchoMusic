<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import type { CloseBehavior } from '../../../../shared/app';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { closeBehaviorOptions } from '../constants';
import { iconPictureInPicture, iconSettings, iconPlayerPlay } from '@/icons';

const settingStore = useSettingStore();
const platform = window.electron?.platform;
const isMac = computed(() => platform === 'darwin');
const isWindows = computed(() => platform === 'win32');
</script>

<template>
  <SettingsSectionShell id="window" title="窗口行为">
    <template #icon>
      <Icon :icon="iconPictureInPicture" width="20" height="20" class="text-primary-text" />
    </template>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">记住窗口大小</h3>
        <p class="text-sm text-text-secondary">下次启动时恢复窗口大小和位置</p>
      </div>
      <Switch v-model="settingStore.rememberWindowSize" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">关闭行为</h3>
        <p class="text-sm text-text-secondary">点击窗口关闭按钮时的应用行为</p>
      </div>
      <Select
        class="shrink-0 w-45"
        aria-label="关闭行为"
        :model-value="settingStore.closeBehavior"
        :options="closeBehaviorOptions"
        @update:model-value="
          settingStore.closeBehavior = $event as CloseBehavior;
          settingStore.syncCloseBehavior();
        "
      />
    </div>
  </SettingsSectionShell>
  <SettingsSectionShell v-if="isWindows || isMac" id="systemIntegration" title="系统集成">
    <template #icon>
      <Icon :icon="iconSettings" width="20" height="20" class="text-primary-text" />
    </template>
    <template v-if="isWindows">
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">任务栏封面预览</h3>
          <p class="text-sm text-text-secondary">
            悬停任务栏图标时显示专辑封面；无封面时显示 EchoMusic 图标
          </p>
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
    <template v-if="isMac">
      <div class="settings-item">
        <div class="space-y-1" :class="{ 'opacity-60': settingStore.closeBehavior !== 'tray' }">
          <h3 class="font-semibold">后台运行时在 Dock 栏中隐藏</h3>
          <p id="background-dock-description" class="text-sm text-text-secondary">
            关闭窗口后隐藏 Dock 图标，恢复窗口时重新显示；仅在「最小化到托盘」时生效
          </p>
        </div>
        <Switch
          :model-value="settingStore.hideDockInBackground"
          :disabled="settingStore.closeBehavior !== 'tray'"
          aria-label="后台运行时在 Dock 栏中隐藏"
          aria-describedby="background-dock-description"
          @update:model-value="
            settingStore.hideDockInBackground = Boolean($event);
            settingStore.syncCloseBehavior();
          "
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1" :class="{ 'opacity-60': settingStore.closeBehavior !== 'tray' }">
          <h3 class="font-semibold">后台运行时在菜单栏中隐藏</h3>
          <p id="background-menu-description" class="text-sm text-text-secondary">
            关闭窗口后隐藏菜单栏图标，恢复窗口时重新显示；仅在「最小化到托盘」时生效
          </p>
        </div>
        <Switch
          :model-value="settingStore.hideMenuBarInBackground"
          :disabled="settingStore.closeBehavior !== 'tray'"
          aria-label="后台运行时在菜单栏中隐藏"
          aria-describedby="background-menu-description"
          @update:model-value="
            settingStore.hideMenuBarInBackground = Boolean($event);
            settingStore.syncCloseBehavior();
          "
        />
      </div>
      <p
        v-if="settingStore.hideDockInBackground && settingStore.hideMenuBarInBackground"
        class="text-sm text-text-secondary"
      >
        最小化到托盘且两个图标均隐藏时，可通过 Finder、Spotlight 或显示窗口全局快捷键恢复。
      </p>
    </template>
  </SettingsSectionShell>
  <SettingsSectionShell id="startup" title="启动行为">
    <template #icon>
      <Icon :icon="iconPlayerPlay" width="20" height="20" class="text-primary-text" />
    </template>
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
        <p class="text-sm text-text-secondary">启动后隐藏主窗口，在托盘中运行</p>
      </div>
      <Switch
        v-model="settingStore.startMinimized"
        @update:model-value="settingStore.syncStartMinimized()"
      />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
