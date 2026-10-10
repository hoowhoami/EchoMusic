<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { resolveCoverLyricColor } from '../../../../shared/lyricColor';
import { DEFAULT_MINI_LYRIC_STYLE, normalizeMiniLyricStyle } from '../../../../shared/miniPlayer';
import { desktopLyricColorPresets, sectionTitles } from '../constants';
import SettingsSectionShell from './SettingsSectionShell.vue';

const settingStore = useSettingStore();
const themeStore = useThemeStore();
type MiniColorField = 'played' | 'unplayed';
const activeColorField = ref<MiniColorField | null>(null);
const miniCoverColor = computed(() =>
  themeStore.coverColorReady
    ? resolveCoverLyricColor(
        themeStore.coverColor,
        themeStore.isDark ? 'dark' : 'light',
        themeStore.accentSurfaces,
      )
    : undefined,
);
const miniColorPreview = computed(
  () =>
    (settingStore.miniLyricFollowCoverColor ? miniCoverColor.value : undefined) ||
    settingStore.miniLyricPlayedColor ||
    themeStore.accentTextColor,
);
const miniUnplayedColorPreview = computed(
  () =>
    (settingStore.miniLyricUnplayedFollowCoverColor ? miniCoverColor.value : undefined) ||
    settingStore.miniLyricUnplayedColor ||
    themeStore.cssTokens['--floating-text-secondary'] ||
    themeStore.cssTokens['--text-secondary'],
);
const activeFollowsCover = computed(() =>
  activeColorField.value === 'unplayed'
    ? settingStore.miniLyricUnplayedFollowCoverColor
    : settingStore.miniLyricFollowCoverColor,
);
const activeColorValue = computed(() =>
  activeFollowsCover.value
    ? '__cover__'
    : activeColorField.value === 'unplayed'
      ? miniUnplayedColorPreview.value
      : miniColorPreview.value,
);
const miniCoverColorOption = computed(() => ({
  label: '跟随封面',
  value: '__cover__',
  color: miniCoverColor.value || miniColorPreview.value,
}));
const openMiniColor = (field: MiniColorField) => {
  activeColorField.value = field;
};
const applyMiniColor = (color: string) => {
  if (!activeColorField.value) return;
  if (activeColorField.value === 'unplayed') {
    settingStore.miniLyricUnplayedFollowCoverColor = color === '__cover__';
    if (color !== '__cover__') settingStore.miniLyricUnplayedColor = color;
  } else {
    settingStore.miniLyricFollowCoverColor = color === '__cover__';
    if (color !== '__cover__') settingStore.miniLyricPlayedColor = color;
  }
  activeColorField.value = null;
};
const resetMiniColor = () => {
  settingStore.miniLyricFollowCoverColor = false;
  settingStore.miniLyricPlayedColor = '';
  settingStore.miniLyricUnplayedFollowCoverColor = false;
  settingStore.miniLyricUnplayedColor = '';
};
const miniStyle = computed(() =>
  normalizeMiniLyricStyle({
    fontSize: settingStore.miniLyricFontSize,
    secondaryFontSize: settingStore.miniLyricSecondaryFontSize,
    fontWeight: settingStore.miniLyricFontWeight,
    alignment: settingStore.miniLyricAlignment,
    lineGap: settingStore.miniLyricLineGap,
    backgroundBlur: settingStore.miniLyricBackgroundBlur,
  }),
);
const numericControls = [
  { field: 'fontSize', label: '歌词字号', description: '主歌词文字大小', min: 12, max: 22 },
  {
    field: 'secondaryFontSize',
    label: '翻译与音译字号',
    description: '独立显示的翻译和音译文字大小',
    min: 10,
    max: 18,
  },
  { field: 'lineGap', label: '歌词行间距', description: '相邻歌词之间的额外间距', min: 0, max: 12 },
] as const;
const numericSettingKeys = {
  fontSize: 'miniLyricFontSize',
  secondaryFontSize: 'miniLyricSecondaryFontSize',
  lineGap: 'miniLyricLineGap',
} as const;
const updateMiniNumber = (field: keyof typeof numericSettingKeys, value: string) => {
  const next = normalizeMiniLyricStyle({
    ...miniStyle.value,
    [field]: value.trim() ? Number(value) : undefined,
  });
  settingStore[numericSettingKeys[field]] = next[field];
};
const fontWeightOptions = [
  { label: '常规', value: 400 },
  { label: '中等', value: 600 },
  { label: '加粗', value: 780 },
];
const alignmentOptions = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
];
const resetMiniStyle = () => {
  settingStore.miniLyricFontSize = DEFAULT_MINI_LYRIC_STYLE.fontSize;
  settingStore.miniLyricSecondaryFontSize = DEFAULT_MINI_LYRIC_STYLE.secondaryFontSize;
  settingStore.miniLyricFontWeight = DEFAULT_MINI_LYRIC_STYLE.fontWeight;
  settingStore.miniLyricAlignment = DEFAULT_MINI_LYRIC_STYLE.alignment;
  settingStore.miniLyricLineGap = DEFAULT_MINI_LYRIC_STYLE.lineGap;
  settingStore.miniLyricBackgroundBlur = DEFAULT_MINI_LYRIC_STYLE.backgroundBlur;
};
</script>

<template>
  <SettingsSectionShell id="miniLyric" :title="sectionTitles.miniLyric.label">
    <template #icon>
      <Icon :icon="sectionTitles.miniLyric.icon" width="20" height="20" class="text-primary-text" />
    </template>
    <div class="settings-item items-start">
      <div class="space-y-1">
        <h3 class="font-semibold">文字颜色</h3>
        <p class="text-sm text-text-secondary">已播和未播字色均可独立选色或跟随封面取色</p>
      </div>
      <div class="settings-color-stack">
        <div class="settings-color-grid">
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">已播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: miniColorPreview }"
              :aria-label="
                settingStore.miniLyricFollowCoverColor ? '已播字色：跟随封面' : '选择已播字色'
              "
              @click="openMiniColor('played')"
            ></button>
          </div>
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">未播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: miniUnplayedColorPreview }"
              :aria-label="
                settingStore.miniLyricUnplayedFollowCoverColor
                  ? '未播字色：跟随封面'
                  : '选择未播字色'
              "
              @click="openMiniColor('unplayed')"
            ></button>
          </div>
        </div>
        <div class="settings-color-actions">
          <button
            type="button"
            class="settings-action"
            :class="{
              invisible:
                !settingStore.miniLyricFollowCoverColor &&
                !settingStore.miniLyricPlayedColor &&
                !settingStore.miniLyricUnplayedFollowCoverColor &&
                !settingStore.miniLyricUnplayedColor,
            }"
            @click="resetMiniColor"
          >
            重置
          </button>
        </div>
      </div>
    </div>
    <template v-for="control in numericControls" :key="control.field">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">{{ control.label }}</h3>
          <p class="text-sm text-text-secondary">{{ control.description }}</p>
        </div>
        <InputNumber
          class="w-45 shrink-0"
          :model-value="miniStyle[control.field]"
          :min="control.min"
          :max="control.max"
          :step="1"
          suffix="px"
          @update:model-value="updateMiniNumber(control.field, $event)"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字字重</h3>
        <p class="text-sm text-text-secondary">主歌词、翻译和音译的文字粗细</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="miniStyle.fontWeight"
        :options="fontWeightOptions"
        @update:model-value="
          settingStore.miniLyricFontWeight = normalizeMiniLyricStyle({
            fontWeight: Number($event),
          }).fontWeight
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">文字对齐</h3>
        <p class="text-sm text-text-secondary">歌词在 Mini 窗口中的对齐方式</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="miniStyle.alignment"
        :options="alignmentOptions"
        @update:model-value="
          settingStore.miniLyricAlignment = normalizeMiniLyricStyle({
            alignment: $event as typeof miniStyle.alignment,
          }).alignment
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">封面模糊背景</h3>
        <p class="text-sm text-text-secondary">关闭后使用主题背景</p>
      </div>
      <Switch v-model="settingStore.miniLyricBackgroundBlur" />
    </div>
    <div class="settings-color-actions">
      <button type="button" class="settings-action" @click="resetMiniStyle">重置排版与背景</button>
    </div>
    <ColorPickerDialog
      :open="activeColorField !== null"
      :title="activeColorField === 'unplayed' ? '选择 Mini 未播字色' : '选择 Mini 已播字色'"
      :value="activeColorValue"
      :presets="desktopLyricColorPresets"
      :dynamic-option="miniCoverColorOption"
      @update:open="(open) => !open && (activeColorField = null)"
      @confirm="applyMiniColor"
    />
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
