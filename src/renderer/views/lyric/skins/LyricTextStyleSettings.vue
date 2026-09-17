<script setup lang="ts">
import { computed, ref } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import {
  LYRIC_TEXT_STYLE_DEFAULTS,
  LYRIC_FONT_WEIGHTS,
  resolveLyricSkinColor,
  type LyricTextStyleConfig,
} from './config';
import { LYRIC_COLOR_PRESETS, getLyricCoverDynamicOption } from '@/composables/useLyricColorPicker';
import { DEFAULT_LYRIC_PLAYED_COLOR, DEFAULT_LYRIC_UNPLAYED_COLOR } from '@/stores/lyric';

/**
 * 单个皮肤内置的歌词文本样式设置（字号 / 字重 / 已播未播颜色）。
 * 每个内置皮肤各持一份独立配置，通过 skinKey 读写互不干扰。
 */
const props = defineProps<{ skinKey: string }>();

const { settings, patch } = useLyricSkin<LyricTextStyleConfig>(
  props.skinKey,
  LYRIC_TEXT_STYLE_DEFAULTS,
);

const fontScaleLabel = computed(() => `${Math.round(settings.value.fontScale * 100)}%`);
const fontWeightLabel = computed(() => `W${LYRIC_FONT_WEIGHTS[settings.value.fontWeightIndex]}`);
const effectivePlayedColor = computed(() =>
  resolveLyricSkinColor(settings.value.playedColor, DEFAULT_LYRIC_PLAYED_COLOR),
);
const effectiveUnplayedColor = computed(() =>
  resolveLyricSkinColor(settings.value.unplayedColor, DEFAULT_LYRIC_UNPLAYED_COLOR),
);

type ColorField = 'playedColor' | 'unplayedColor';
const activeField = ref<ColorField | null>(null);
const activeValue = computed(
  () => settings.value[activeField.value || 'playedColor'] || DEFAULT_LYRIC_PLAYED_COLOR,
);
const activeTitle = computed(() =>
  activeField.value === 'unplayedColor' ? '选择未播字色' : '选择已播字色',
);
const pickerOpen = computed(() => activeField.value !== null);

const openPicker = (field: ColorField) => {
  activeField.value = field;
};
const closePicker = () => {
  activeField.value = null;
};
const applyColor = (value: string) => {
  if (!activeField.value) return;
  patch({ [activeField.value]: value });
  closePicker();
};

const hasCustomTextStyle = computed(
  () =>
    settings.value.fontScale !== LYRIC_TEXT_STYLE_DEFAULTS.fontScale ||
    settings.value.fontWeightIndex !== LYRIC_TEXT_STYLE_DEFAULTS.fontWeightIndex ||
    Boolean(settings.value.playedColor || settings.value.unplayedColor),
);

// 只还原本组歌词文本样式，不影响同皮肤的其他设置（如封面动态封面、写真轮播等）。
const restoreDefaults = () =>
  patch({
    fontScale: LYRIC_TEXT_STYLE_DEFAULTS.fontScale,
    fontWeightIndex: LYRIC_TEXT_STYLE_DEFAULTS.fontWeightIndex,
    playedColor: '',
    unplayedColor: '',
  });
</script>

<template>
  <div class="skin-settings">
    <div class="setting-row setting-row-compact">
      <span class="setting-label">字号</span>
      <span class="setting-value">{{ fontScaleLabel }}</span>
    </div>
    <SliderRoot
      :model-value="[settings.fontScale]"
      :min="0.7"
      :max="1.4"
      :step="0.1"
      class="settings-slider-root"
      @update:model-value="(v) => v?.length && patch({ fontScale: Number(v[0]) })"
    >
      <SliderTrack class="settings-slider-track">
        <SliderRange class="settings-slider-range" />
      </SliderTrack>
      <SliderThumb class="settings-slider-thumb" />
    </SliderRoot>

    <div class="setting-row setting-row-compact">
      <span class="setting-label">字重</span>
      <span class="setting-value">{{ fontWeightLabel }}</span>
    </div>
    <SliderRoot
      :model-value="[settings.fontWeightIndex]"
      :min="0"
      :max="8"
      :step="1"
      class="settings-slider-root"
      @update:model-value="(v) => v?.length && patch({ fontWeightIndex: Number(v[0]) })"
    >
      <SliderTrack class="settings-slider-track">
        <SliderRange class="settings-slider-range" />
      </SliderTrack>
      <SliderThumb class="settings-slider-thumb" />
    </SliderRoot>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">歌词颜色</span>
        <span class="setting-hint">设置逐字歌词的已播颜色与未播颜色</span>
      </div>
      <div class="settings-color-grid">
        <button
          class="color-swatch"
          :style="{ backgroundColor: effectivePlayedColor }"
          aria-label="已播字色"
          @click="openPicker('playedColor')"
        ></button>
        <button
          class="color-swatch"
          :style="{ backgroundColor: effectiveUnplayedColor }"
          aria-label="未播字色"
          @click="openPicker('unplayedColor')"
        ></button>
      </div>
    </div>
    <button
      class="reset-btn"
      type="button"
      :class="{ invisible: !hasCustomTextStyle }"
      @click="restoreDefaults"
    >
      恢复默认
    </button>
  </div>

  <ColorPickerDialog
    :open="pickerOpen"
    :title="activeTitle"
    :value="activeValue"
    :presets="LYRIC_COLOR_PRESETS"
    :dynamic-option="getLyricCoverDynamicOption()"
    @update:open="(open: boolean) => !open && closePicker()"
    @confirm="applyColor"
  />
</template>

<style scoped src="./skinSettings.css"></style>

<style scoped>
.settings-color-grid {
  display: flex;
  gap: 8px;
}
</style>
