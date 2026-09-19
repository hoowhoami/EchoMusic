<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useWindowZoom } from '@/composables/useWindowZoom';
const { percent, zoomIn, zoomOut, reset, canZoomIn, canZoomOut } = useWindowZoom();
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
const barEnabled = ref(false);
const barBusy = ref(false);
const barMessage = ref('');
onMounted(async () => {
  if (!isWindows.value) return;
  try {
    barEnabled.value = Boolean(
      (await window.electron.ipcRenderer.invoke('taskbar-player:get-state')).enabled,
    );
  } catch {
    barMessage.value = '读取失败，可点击重新显示重试';
  }
});
const setBar = async (value: boolean) => {
  if (barBusy.value) return;
  barBusy.value = true;
  barMessage.value = '';
  try {
    const state = await window.electron.ipcRenderer.invoke('taskbar-player:set-enabled', value);
    barEnabled.value = Boolean(state.enabled);
    if (state.enabled && !state.visible) barMessage.value = '已开启；全屏时暂时隐藏';
  } catch (error) {
    barMessage.value = `打开失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    barBusy.value = false;
  }
};
</script>

<template>
  <SettingsSectionShell id="window" :title="sectionTitles.window.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.window.icon"
        :icon="sectionTitles.window.icon"
        width="20"
        height="20"
        class="text-primary-text"
      />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">界面缩放</h3>
        <p class="text-sm text-text-secondary">
          立即调整整个界面并自动保存。{{ platform === 'darwin' ? '⌘' : 'Ctrl' }} + 加号 /
          减号缩放，0 重置
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0" role="group" aria-label="界面缩放">
        <button
          type="button"
          class="px-3 py-2 disabled:opacity-40"
          aria-label="缩小界面"
          :disabled="!canZoomOut"
          @click="zoomOut"
        >
          −
        </button>
        <output class="min-w-12 text-center" aria-live="polite">{{ percent }}%</output>
        <button
          type="button"
          class="px-3 py-2 disabled:opacity-40"
          aria-label="放大界面"
          :disabled="!canZoomIn"
          @click="zoomIn"
        >
          +
        </button>
        <button class="settings-action" type="button" @click="reset">重置</button>
      </div>
    </div>
    <div class="settings-divider"></div>
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
          <h3 class="font-semibold">任务栏快捷播控（独立横条）</h3>
          <p class="text-sm text-text-secondary">
            在任务栏空闲区显示，可拖出小窗；不影响图标悬停播控。空间不足时显示在任务栏旁。
          </p>
          <p v-if="barMessage" role="status" class="text-sm text-text-secondary">
            {{ barMessage }}
          </p>
          <button class="text-primary-text text-sm" :disabled="barBusy" @click="setBar(true)">
            重新显示
          </button>
        </div>
        <Switch
          :model-value="barEnabled"
          :disabled="barBusy"
          @update:model-value="setBar(Boolean($event))"
        />
      </div>
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
        class="w-45 shrink-0"
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
