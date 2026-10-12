<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import SkinSettingSection from './SkinSettingSection.vue';
import SkinSettingSlider from './SkinSettingSlider.vue';
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
    settings.value.highRefreshRate !== LYRIC_SKIN_AMLL_DEFAULTS.highRefreshRate ||
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
    <SkinSettingSection title="歌词显示">
      <SkinSettingSlider
        label="歌词位置"
        hint="当前歌词在页面高度上的停留位置"
        :model-value="settings.alignPosition"
        :value-label="alignPositionLabel"
        :min="0"
        :max="1"
        :step="0.05"
        @update:model-value="patches.alignPosition"
      />
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">隐藏已播放</span
          ><span class="setting-hint">只显示当前与后续歌词</span>
        </div>
        <Switch
          :model-value="settings.hidePassedLines"
          aria-label="隐藏已播放"
          @update:model-value="(v: boolean) => patch({ hidePassedLines: v })"
        />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">歌词颜色</span
          ><span class="setting-hint">主文字与逐字高亮的基础颜色</span>
        </div>
        <button
          type="button"
          class="color-option color-option-inline soft-neutral-action app-focus-ring-soft"
          aria-label="歌词颜色"
          @click="openTextColor"
        >
          <span>更改</span
          ><span class="color-swatch" :style="{ backgroundColor: effectiveTextColor }" />
        </button>
      </div>
    </SkinSettingSection>
    <SkinSettingSection title="歌词动画">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">高刷新率动画</span>
          <span class="setting-hint">跟随屏幕刷新率，可能增加性能开销；关闭时上限 60fps</span>
        </div>
        <Switch
          :model-value="settings.highRefreshRate"
          aria-label="高刷新率动画"
          @update:model-value="(v: boolean) => patch({ highRefreshRate: v })"
        />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">弹簧动画</span
          ><span class="setting-hint">使用物理弹簧驱动歌词位移</span>
        </div>
        <Switch
          :model-value="settings.enableSpring"
          aria-label="弹簧动画"
          @update:model-value="(v: boolean) => patch({ enableSpring: v })"
        />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">模糊律动</span
          ><span class="setting-hint">歌词切换时柔和过渡</span>
        </div>
        <Switch
          :model-value="settings.enableBlur"
          aria-label="模糊律动"
          @update:model-value="(v: boolean) => patch({ enableBlur: v })"
        />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">缩放律动</span
          ><span class="setting-hint">突出当前播放的歌词行</span>
        </div>
        <Switch
          :model-value="settings.enableScale"
          aria-label="缩放律动"
          @update:model-value="(v: boolean) => patch({ enableScale: v })"
        />
      </div>
      <SkinSettingSlider
        label="渐变宽度"
        hint="逐字高亮的过渡范围，以字号为单位"
        :model-value="settings.wordFadeWidth"
        :value-label="wordFadeWidthLabel"
        :min="0.05"
        :max="1"
        :step="0.05"
        @update:model-value="patches.wordFadeWidth"
      />
    </SkinSettingSection>
    <SkinSettingSection title="封面显示">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">动态专辑封面</span
          ><span class="setting-hint">封面随播放律动呼吸</span>
        </div>
        <Switch
          :model-value="settings.dynamicAlbumCover"
          aria-label="动态专辑封面"
          @update:model-value="(v: boolean) => patch({ dynamicAlbumCover: v })"
        />
      </div>
    </SkinSettingSection>
    <div class="skin-settings-footer">
      <Button variant="secondary" size="xs" :disabled="!hasCustomSettings" @click="restoreDefaults"
        >恢复全部默认</Button
      >
    </div>
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
