<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import SkinSettingSection from './SkinSettingSection.vue';
import SkinSettingSlider from './SkinSettingSlider.vue';
import { computed, ref } from 'vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import {
  LYRIC_TEXT_STYLE_DEFAULTS,
  LYRIC_FONT_WEIGHTS,
  resolveLyricSkinColor,
  type LyricTextStyleConfig,
} from './config';
import { LYRIC_COLOR_PRESETS, getLyricCoverDynamicOption } from '@/composables/useLyricColorPicker';
import { useLyricStore } from '@/stores/lyric';

/**
 * 单个皮肤内置的歌词文本样式设置（字号 / 字重 / 已播未播颜色）。
 * 每个内置皮肤各持一份独立配置，通过 skinKey 读写互不干扰。
 */
const props = defineProps<{ skinKey: string }>();

const { settings, patch } = useLyricSkin<LyricTextStyleConfig>(
  props.skinKey,
  LYRIC_TEXT_STYLE_DEFAULTS,
);
const lyricStore = useLyricStore();

const fontScaleLabel = computed(() => `${Math.round(settings.value.fontScale * 100)}%`);
const fontWeightLabel = computed(() => `W${LYRIC_FONT_WEIGHTS[settings.value.fontWeightIndex]}`);
const effectivePlayedColor = computed(() =>
  resolveLyricSkinColor(settings.value.playedColor, lyricStore.effectivePlayedColor),
);
const effectiveUnplayedColor = computed(() =>
  resolveLyricSkinColor(settings.value.unplayedColor, lyricStore.effectiveUnplayedColor),
);

type ColorField = 'playedColor' | 'unplayedColor';
const activeField = ref<ColorField | null>(null);
const activeValue = computed(() => {
  const field = activeField.value || 'playedColor';
  return (
    settings.value[field] ||
    (field === 'unplayedColor'
      ? lyricStore.effectiveUnplayedColor
      : lyricStore.effectivePlayedColor)
  );
});
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
  <SkinSettingSection title="歌词样式">
    <SkinSettingSlider
      label="字号"
      :model-value="settings.fontScale"
      :value-label="fontScaleLabel"
      :min="0.7"
      :max="1.4"
      :step="0.1"
      @update:model-value="(value) => patch({ fontScale: value })"
    />
    <SkinSettingSlider
      label="字重"
      :model-value="settings.fontWeightIndex"
      :value-label="fontWeightLabel"
      :min="0"
      :max="8"
      :step="1"
      @update:model-value="(value) => patch({ fontWeightIndex: value })"
    />
    <div class="setting-colors">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">歌词颜色</span>
          <span class="setting-hint">分别设置已播放与未播放的文字颜色</span>
        </div>
      </div>
      <div class="settings-color-grid">
        <button
          type="button"
          class="color-option soft-neutral-action app-focus-ring-soft"
          aria-label="已播字色"
          @click="openPicker('playedColor')"
        >
          <span>已播</span
          ><span class="color-swatch" :style="{ backgroundColor: effectivePlayedColor }" />
        </button>
        <button
          type="button"
          class="color-option soft-neutral-action app-focus-ring-soft"
          aria-label="未播字色"
          @click="openPicker('unplayedColor')"
        >
          <span>未播</span
          ><span class="color-swatch" :style="{ backgroundColor: effectiveUnplayedColor }" />
        </button>
      </div>
    </div>
    <template #footer>
      <Button variant="secondary" size="xs" :disabled="!hasCustomTextStyle" @click="restoreDefaults"
        >恢复歌词默认</Button
      >
    </template>
  </SkinSettingSection>
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
