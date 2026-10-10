<script setup lang="ts">
import { computed } from 'vue';
import { useWindowZoom } from '@/composables/useWindowZoom';
import { useSettingStore } from '@/stores/setting';
import Switch from '@/components/ui/Switch.vue';
import DisplayModeControl from './DisplayModeControl.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const platform = window.electron?.platform;
const supportsCustomWindowControls = computed(() => platform === 'win32' || platform === 'linux');
const { percent, zoomIn, zoomOut, reset, canZoomIn, canZoomOut } = useWindowZoom();
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
          class="settings-action w-8"
          aria-label="缩小界面"
          :disabled="!canZoomOut"
          @click="zoomOut"
        >
          −
        </button>
        <output class="min-w-12 text-center" aria-live="polite">{{ percent }}%</output>
        <button
          type="button"
          class="settings-action w-8"
          aria-label="放大界面"
          :disabled="!canZoomIn"
          @click="zoomIn"
        >
          +
        </button>
        <button class="settings-action" type="button" @click="reset">重置</button>
      </div>
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
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">专辑动态封面</h3>
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
