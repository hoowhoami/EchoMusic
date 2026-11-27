<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import Select from '@/components/ui/Select.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import type { TaskbarLyricState } from '../../../../shared/taskbar';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const systemFontOptions = ref<{ label: string; value: string }[]>([]);

const globalFontOptions = computed(() => [
  { label: '系统默认', value: 'system-ui' },
  ...systemFontOptions.value,
]);

const lyricFontOptions = computed(() => [
  { label: '跟随全局', value: 'follow' },
  { label: '系统默认', value: 'system-ui' },
  ...systemFontOptions.value,
]);

const desktopLyricFontName = computed(() => desktopLyricStore.settings.fontFamily || 'follow');
const isWindows = computed(() => window.electron?.platform === 'win32');
const taskbarFontName = ref('follow');
let disposeTaskbarState: (() => void) | undefined;
const syncTaskbarFont = (state: TaskbarLyricState) => {
  taskbarFontName.value = state.settings?.fontFamily || 'follow';
};
const applyTaskbarFont = async (fontName: string) => {
  const name = fontName || 'follow';
  taskbarFontName.value = name;
  try {
    const state = await window.electron.taskbarLyric.setSettings({ fontFamily: name });
    taskbarFontName.value = state.settings?.fontFamily || name;
  } catch {
    taskbarFontName.value = name;
  }
};

const fetchSystemFonts = async () => {
  const fonts = await settingStore.fetchSystemFonts();
  const sorted = fonts.slice().sort((a, b) => {
    if (a === b) return 0;
    if (a.startsWith(b)) return 1;
    if (b.startsWith(a)) return -1;
    return a.localeCompare(b);
  });
  systemFontOptions.value = sorted.map((name) => ({ label: name, value: name }));
};

const applyDesktopLyricFont = async (fontName: string) => {
  await desktopLyricStore.syncSettings({ fontFamily: fontName || 'follow' });
};

onMounted(async () => {
  void fetchSystemFonts();
  if (!isWindows.value) return;
  try {
    disposeTaskbarState = window.electron.taskbarLyric.onStateChange(syncTaskbarFont);
    syncTaskbarFont(await window.electron.taskbarLyric.getState());
  } catch {
    // 读取失败时保持默认值，用户仍可重新选择
  }
});
onUnmounted(() => {
  disposeTaskbarState?.();
  disposeTaskbarState = undefined;
});
</script>

<template>
  <SettingsSectionShell id="font" :title="sectionTitles.font.label">
    <template #icon>
      <FontIcon :size="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局字体</h3>
        <p class="text-sm text-text-secondary">应用到软件内所有区域的字体</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="settings-action echo-button-sized echo-button-standard"
          v-if="settingStore.globalFont !== 'system-ui'"
          type="button"
          @click="settingStore.globalFont = 'system-ui'"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45 shrink-0"
          :model-value="settingStore.globalFont"
          :options="globalFontOptions"
          @update:model-value="settingStore.globalFont = String($event)"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放页歌词字体</h3>
        <p class="text-sm text-text-secondary">播放页歌词使用的字体，跟随全局或单独指定</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="settings-action echo-button-sized echo-button-standard"
          v-if="settingStore.lyricFont !== 'follow'"
          type="button"
          @click="settingStore.lyricFont = 'follow'"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45 shrink-0"
          :model-value="settingStore.lyricFont"
          :options="lyricFontOptions"
          @update:model-value="settingStore.lyricFont = String($event)"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">桌面歌词字体</h3>
        <p class="text-sm text-text-secondary">桌面歌词窗口使用的字体，跟随全局或单独指定</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="settings-action echo-button-sized echo-button-standard"
          v-if="desktopLyricFontName !== 'follow'"
          type="button"
          @click="applyDesktopLyricFont('follow')"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45 shrink-0"
          :model-value="desktopLyricFontName"
          :options="lyricFontOptions"
          @update:model-value="applyDesktopLyricFont(String($event))"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div v-if="isWindows" class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">任务栏歌词字体</h3>
        <p class="text-sm text-text-secondary">任务栏歌词使用的字体，跟随全局或单独指定</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="settings-action echo-button-sized echo-button-standard"
          v-if="taskbarFontName !== 'follow'"
          type="button"
          @click="applyTaskbarFont('follow')"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45 shrink-0"
          :model-value="taskbarFontName"
          :options="lyricFontOptions"
          @update:model-value="applyTaskbarFont(String($event))"
        />
      </div>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
