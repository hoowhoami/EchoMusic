<script setup lang="ts">
import { computed, ref } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Switch from '@/components/ui/Switch.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import {
  AMLL_TEXT_COLOR_FALLBACK,
  HOST_SKIN_KEYS,
  LYRIC_SKIN_AMLL_DEFAULTS,
  resolveLyricSkinColor,
  type LyricSkinConfigAmll,
} from './config';
import { LYRIC_COLOR_PRESETS, getLyricCoverDynamicOption } from '@/composables/useLyricColorPicker';

const { settings, patch } = useLyricSkin<LyricSkinConfigAmll>(
  HOST_SKIN_KEYS.amll,
  LYRIC_SKIN_AMLL_DEFAULTS,
);

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const alignPositionLabel = computed(() =>
  settings.value.alignPosition === 0.5
    ? '垂直居中'
    : `${Math.round(settings.value.alignPosition * 100)}%`,
);
const wordFadeWidthLabel = computed(() => settings.value.wordFadeWidth.toFixed(2));

const patches = {
  alignPosition: (value: number) => patch({ alignPosition: clamp(value, 0, 1) }),
  wordFadeWidth: (value: number) => patch({ wordFadeWidth: clamp(value, 0.05, 1) }),
};

const effectiveTextColor = computed(() =>
  resolveLyricSkinColor(settings.value.textColor, AMLL_TEXT_COLOR_FALLBACK),
);
const isTextColorOpen = ref(false);
const openTextColor = () => {
  isTextColorOpen.value = true;
};
const applyTextColor = (value: string) => {
  patch({ textColor: value });
  isTextColorOpen.value = false;
};

const hasCustomSettings = computed(
  () =>
    settings.value.alignPosition !== LYRIC_SKIN_AMLL_DEFAULTS.alignPosition ||
    settings.value.enableSpring !== LYRIC_SKIN_AMLL_DEFAULTS.enableSpring ||
    settings.value.enableBlur !== LYRIC_SKIN_AMLL_DEFAULTS.enableBlur ||
    settings.value.enableScale !== LYRIC_SKIN_AMLL_DEFAULTS.enableScale ||
    settings.value.hidePassedLines !== LYRIC_SKIN_AMLL_DEFAULTS.hidePassedLines ||
    settings.value.wordFadeWidth !== LYRIC_SKIN_AMLL_DEFAULTS.wordFadeWidth ||
    settings.value.dynamicAlbumCover !== LYRIC_SKIN_AMLL_DEFAULTS.dynamicAlbumCover ||
    Boolean(settings.value.textColor),
);

const restoreDefaults = () => patch({ ...LYRIC_SKIN_AMLL_DEFAULTS });
</script>

<template>
  <div class="skin-settings">
    <div class="setting-row setting-row-compact">
      <div class="setting-text">
        <span class="setting-label">歌词位置</span>
        <span class="setting-hint">活跃歌词行在页面高度上的居停位置</span>
      </div>
      <span class="setting-value">{{ alignPositionLabel }}</span>
    </div>
    <SliderRoot
      :model-value="[settings.alignPosition]"
      :min="0"
      :max="1"
      :step="0.05"
      class="settings-slider-root"
      @update:model-value="(v) => v?.length && patches.alignPosition(Number(v[0]))"
    >
      <SliderTrack class="settings-slider-track">
        <SliderRange class="settings-slider-range" />
      </SliderTrack>
      <SliderThumb class="settings-slider-thumb" />
    </SliderRoot>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">弹簧动画</span>
        <span class="setting-hint">物理弹簧驱动歌词位移，性能较弱的设备可关闭</span>
      </div>
      <Switch
        :model-value="settings.enableSpring"
        @update:model-value="(v: boolean) => patch({ enableSpring: v })"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">模糊律动</span>
        <span class="setting-hint">歌词行切换时的模糊过渡效果</span>
      </div>
      <Switch
        :model-value="settings.enableBlur"
        @update:model-value="(v: boolean) => patch({ enableBlur: v })"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">缩放律动</span>
        <span class="setting-hint">活跃歌词行的缩放动画</span>
      </div>
      <Switch
        :model-value="settings.enableScale"
        @update:model-value="(v: boolean) => patch({ enableScale: v })"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">隐藏已播放</span>
        <span class="setting-hint">隐藏已经播放过的歌词行</span>
      </div>
      <Switch
        :model-value="settings.hidePassedLines"
        @update:model-value="(v: boolean) => patch({ hidePassedLines: v })"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">动态专辑封面</span>
        <span class="setting-hint">封面随播放律动呼吸，性能较弱的设备可关闭</span>
      </div>
      <Switch
        :model-value="settings.dynamicAlbumCover"
        @update:model-value="(v: boolean) => patch({ dynamicAlbumCover: v })"
      />
    </div>

    <div class="setting-row setting-row-compact">
      <div class="setting-text">
        <span class="setting-label">渐变宽度</span>
        <span class="setting-hint">逐字高亮渐变的宽度（倍于字号）</span>
      </div>
      <span class="setting-value">{{ wordFadeWidthLabel }}</span>
    </div>
    <SliderRoot
      :model-value="[settings.wordFadeWidth]"
      :min="0.05"
      :max="1"
      :step="0.05"
      class="settings-slider-root"
      @update:model-value="(v) => v?.length && patches.wordFadeWidth(Number(v[0]))"
    >
      <SliderTrack class="settings-slider-track">
        <SliderRange class="settings-slider-range" />
      </SliderTrack>
      <SliderThumb class="settings-slider-thumb" />
    </SliderRoot>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">歌词颜色</span>
        <span class="setting-hint">Apple Music 歌词主文字颜色</span>
      </div>
      <button
        class="color-swatch"
        :style="{ backgroundColor: effectiveTextColor }"
        aria-label="歌词颜色"
        @click="openTextColor"
      ></button>
    </div>

    <button
      class="reset-btn"
      type="button"
      :class="{ invisible: !hasCustomSettings }"
      @click="restoreDefaults"
    >
      恢复默认
    </button>
  </div>

  <ColorPickerDialog
    :open="isTextColorOpen"
    title="选择歌词颜色"
    :value="settings.textColor || AMLL_TEXT_COLOR_FALLBACK"
    :presets="LYRIC_COLOR_PRESETS"
    :dynamic-option="getLyricCoverDynamicOption()"
    @update:open="(open: boolean) => !open && (isTextColorOpen = false)"
    @confirm="applyTextColor"
  />
</template>

<style scoped src="./skinSettings.css"></style>
