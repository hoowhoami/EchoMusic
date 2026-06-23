<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useSettingStore } from '@/stores/setting';
import { DEFAULT_LYRIC_FILTER_PATTERN } from '@/stores/lyric';
import type { DesktopLyricSettings } from '../../../../shared/desktop-lyric';
import { DEFAULT_DESKTOP_LYRIC_SETTINGS } from '../../../../shared/desktop-lyric';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import {
  desktopLyricAlignOptions,
  desktopLyricColorPresets,
  desktopLyricShadowOptions,
  sectionTitles,
} from '../constants';

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const isLinux = computed(() => window.electron?.platform === 'linux');
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
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
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
        <h3 class="font-semibold">显示翻译</h3>
        <p class="text-sm text-text-secondary">有翻译时在桌面歌词中显示翻译行</p>
      </div>
      <Switch
        :model-value="desktopLyricStore.settings.wantTranslation"
        @update:model-value="commitDesktopLyricSettings({ wantTranslation: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示音译</h3>
        <p class="text-sm text-text-secondary">有音译时在桌面歌词中显示音译行</p>
      </div>
      <Switch
        :model-value="desktopLyricStore.settings.wantRomanization"
        @update:model-value="commitDesktopLyricSettings({ wantRomanization: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字对齐</h3>
        <p class="text-sm text-text-secondary">歌词文字的排版位置</p>
      </div>
      <Select
        class="w-45"
        :model-value="desktopLyricStore.settings.alignment"
        :options="desktopLyricAlignOptions"
        @update:model-value="commitDesktopLyricSettings({ alignment: $event as any })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">对齐微调步长</h3>
        <p class="text-sm text-text-secondary">桌面歌词前进 / 后退按钮每次调整的时间量</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(desktopLyricStore.settings.offsetStep ?? 0.5)"
        :min="0.1"
        :max="5"
        :step="0.1"
        placeholder="0.5"
        suffix="秒"
        @update:model-value="
          commitDesktopLyricSettings({
            offsetStep: Math.max(0.1, Math.min(5, Number($event) || 0.5)),
          })
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字阴影</h3>
        <p class="text-sm text-text-secondary">调整桌面歌词在其他窗口上的清晰度</p>
      </div>
      <Select
        class="w-45"
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
            type="button"
            class="settings-color-reset"
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
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词过滤</h3>
        <p class="text-sm text-text-secondary">过滤非歌词内容（如制作人信息、版权声明等）</p>
      </div>
      <Switch v-model="settingStore.desktopLyricFilterEnabled" />
    </div>
    <template v-if="settingStore.desktopLyricFilterEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item items-start">
        <div class="space-y-1">
          <h3 class="font-semibold">过滤表达式</h3>
          <p class="text-sm text-text-secondary">正则表达式，匹配的行将被替换</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="settingStore.desktopLyricFilterPattern"
            type="button"
            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
            @click="settingStore.desktopLyricFilterPattern = ''"
          >
            恢复默认
          </button>
          <input
            v-model="settingStore.desktopLyricFilterPattern"
            type="text"
            class="settings-input w-64"
            :placeholder="DEFAULT_LYRIC_FILTER_PATTERN"
          />
        </div>
      </div>
    </template>

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
