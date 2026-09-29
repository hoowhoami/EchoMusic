<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import type { DesktopLyricSettings } from '../../../../shared/desktopLyric';
import { DEFAULT_DESKTOP_LYRIC_SETTINGS } from '../../../../shared/desktopLyric';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import {
  desktopLyricAlignOptions,
  desktopLyricColorPresets,
  desktopLyricLayoutOptions,
  desktopLyricShadowOptions,
  sectionTitles,
} from '../constants';

const desktopLyricStore = useDesktopLyricStore();
const isLinux = computed(() => window.electron?.platform === 'linux');
const isWayland = computed(() => window.electron?.isWayland ?? false);
const activeDesktopLyricColorField = ref<'playedColor' | 'unplayedColor' | null>(null);

const hasCustomDesktopLyricColors = computed(
  () =>
    desktopLyricStore.settings.playedColor !== DEFAULT_DESKTOP_LYRIC_SETTINGS.playedColor ||
    desktopLyricStore.settings.unplayedColor !== DEFAULT_DESKTOP_LYRIC_SETTINGS.unplayedColor,
);

const activeDesktopLyricColorValue = computed(() => {
  if (!activeDesktopLyricColorField.value) return '#31cfa1';
  return desktopLyricStore.settings[activeDesktopLyricColorField.value];
});

const commitDesktopLyricSettings = async (partial?: Partial<DesktopLyricSettings>) => {
  await desktopLyricStore.syncSettings(partial);
};

const openDesktopLyricColorPicker = (field: 'playedColor' | 'unplayedColor') => {
  activeDesktopLyricColorField.value = field;
};

const closeDesktopLyricColorPicker = () => {
  activeDesktopLyricColorField.value = null;
};

const applyDesktopLyricColor = async (value: string) => {
  if (!activeDesktopLyricColorField.value) return;
  await commitDesktopLyricSettings({
    [activeDesktopLyricColorField.value]: value,
  });
  closeDesktopLyricColorPicker();
};
</script>

<template>
  <SettingsSectionShell id="desktopLyric" :title="sectionTitles.desktopLyric.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.desktopLyric.icon"
        :icon="sectionTitles.desktopLyric.icon"
        width="20"
        height="20"
        class="text-primary-text"
      />
      <FontIcon v-else :size="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">置顶显示</h3>
        <p class="text-sm text-text-secondary">
          关闭后桌面歌词不会固定显示在其他窗口或全屏应用之上
        </p>
        <p v-if="isLinux" class="text-xs text-text-secondary/70">
          原生 Wayland 下置顶和鼠标穿透受协议限制
        </p>
      </div>
      <Switch
        :model-value="desktopLyricStore.settings.alwaysOnTop"
        @update:model-value="commitDesktopLyricSettings({ alwaysOnTop: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">锁定时显示解锁按钮</h3>
        <p class="text-sm text-text-secondary">
          {{
            isWayland
              ? '原生 Wayland 下锁定后需通过托盘菜单解锁'
              : '关闭后需通过托盘菜单解锁桌面歌词'
          }}
        </p>
      </div>
      <Switch
        :model-value="isWayland ? false : desktopLyricStore.settings.showUnlockButton"
        :disabled="isWayland"
        @update:model-value="commitDesktopLyricSettings({ showUnlockButton: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示布局</h3>
        <p class="text-sm text-text-secondary">切换桌面歌词的横排或竖排显示</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="desktopLyricStore.settings.layout"
        :options="desktopLyricLayoutOptions"
        @update:model-value="
          commitDesktopLyricSettings({
            layout: $event as DesktopLyricSettings['layout'],
          })
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">下一行预览</h3>
        <p class="text-sm text-text-secondary">没有显示翻译或音译时，显示下一行歌词</p>
      </div>
      <Switch
        :model-value="desktopLyricStore.settings.showNextLinePreview"
        @update:model-value="commitDesktopLyricSettings({ showNextLinePreview: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字对齐</h3>
        <p class="text-sm text-text-secondary">歌词文字的排版位置</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="desktopLyricStore.settings.alignment"
        :options="desktopLyricAlignOptions"
        @update:model-value="commitDesktopLyricSettings({ alignment: $event as any })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字阴影</h3>
        <p class="text-sm text-text-secondary">调整桌面歌词在其他窗口上的清晰度</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="desktopLyricStore.settings.shadowStrength"
        :options="desktopLyricShadowOptions"
        @update:model-value="
          commitDesktopLyricSettings({
            shadowStrength: $event as DesktopLyricSettings['shadowStrength'],
          })
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字粗体</h3>
        <p class="text-sm text-text-secondary">歌词使用更高字重显示</p>
      </div>
      <Switch
        :model-value="desktopLyricStore.settings.bold"
        @update:model-value="commitDesktopLyricSettings({ bold: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item items-start">
      <div class="space-y-1">
        <h3 class="font-semibold">文字颜色</h3>
        <p class="text-sm text-text-secondary">设置逐字歌词的已播颜色与未播颜色</p>
      </div>
      <div class="settings-color-stack">
        <div class="settings-color-grid">
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">已播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: desktopLyricStore.settings.playedColor }"
              @click="openDesktopLyricColorPicker('playedColor')"
            ></button>
          </div>
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">未播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: desktopLyricStore.settings.unplayedColor }"
              @click="openDesktopLyricColorPicker('unplayedColor')"
            ></button>
          </div>
        </div>
        <div class="settings-color-actions">
          <button
            class="settings-action"
            type="button"
            :class="{ invisible: !hasCustomDesktopLyricColors }"
            @click="
              commitDesktopLyricSettings({
                playedColor: DEFAULT_DESKTOP_LYRIC_SETTINGS.playedColor,
                unplayedColor: DEFAULT_DESKTOP_LYRIC_SETTINGS.unplayedColor,
              })
            "
          >
            重置
          </button>
        </div>
      </div>
    </div>

    <ColorPickerDialog
      :open="activeDesktopLyricColorField !== null"
      :title="activeDesktopLyricColorField === 'unplayedColor' ? '选择未播字色' : '选择已播字色'"
      :value="activeDesktopLyricColorValue"
      :presets="desktopLyricColorPresets"
      @update:open="(open) => !open && closeDesktopLyricColorPicker()"
      @confirm="applyDesktopLyricColor"
    />
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
