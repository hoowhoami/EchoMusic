<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import Select from '@/components/ui/Select.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
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

onMounted(() => {
  void fetchSystemFonts();
});
</script>

<template>
  <SettingsSectionShell id="font" :title="sectionTitles.font.label">
    <template #icon>
      <FontIcon :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局字体</h3>
        <p class="text-sm text-text-secondary">应用到软件内所有区域的字体</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="settingStore.globalFont !== 'system-ui'"
          type="button"
          class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
          @click="settingStore.globalFont = 'system-ui'"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45"
          :model-value="settingStore.globalFont"
          :options="globalFontOptions"
          @update:model-value="settingStore.globalFont = String($event)"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">页面歌词字体</h3>
        <p class="text-sm text-text-secondary">歌词页面使用的字体，跟随全局或单独指定</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="settingStore.lyricFont !== 'follow'"
          type="button"
          class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
          @click="settingStore.lyricFont = 'follow'"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45"
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
          v-if="desktopLyricFontName !== 'follow'"
          type="button"
          class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
          @click="applyDesktopLyricFont('follow')"
        >
          重置
        </button>
        <Select
          filterable
          class="w-45"
          :model-value="desktopLyricFontName"
          :options="lyricFontOptions"
          @update:model-value="applyDesktopLyricFont(String($event))"
        />
      </div>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
