<script setup lang="ts">
/**
 * 歌词页设置 Drawer
 * 强制深色毛玻璃风格，与歌词页沉浸式环境协调
 */
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useLyricStore } from '@/stores/lyric';
import { useLyricColorPicker } from '@/composables/useLyricColorPicker';
import Drawer from '@/components/ui/Drawer.vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Switch from '@/components/ui/Switch.vue';
import Button from '@/components/ui/Button.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { iconX } from '@/icons';

type LyricViewMode = 'cover' | 'portrait' | 'lyric';

interface Props {
  open: boolean;
}

defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const settingStore = useSettingStore();
const lyricStore = useLyricStore();
const lyricColorPicker = useLyricColorPicker();

const currentMode = computed({
  get: () => settingStore.lyricViewMode,
  set: (v: LyricViewMode) => {
    settingStore.lyricViewMode = v;
  },
});

const fontSizeLabel = computed(() => `${Math.round(lyricStore.fontScale * 100)}%`);
const fontWeightLabel = computed(() => `W${lyricStore.fontWeightValue}`);
const backdropOpacityLabel = computed(() => `${settingStore.lyricBackdropOpacity}%`);
const carouselIntervalLabel = computed(() => `${settingStore.lyricCarouselInterval}s`);
const hasCustomLyricColors = computed(() =>
  Boolean(lyricStore.playedColor || lyricStore.unplayedColor),
);

const effectivePlayedColor = computed(() => lyricStore.effectivePlayedColor);
const effectiveUnplayedColor = computed(() => lyricStore.effectiveUnplayedColor);

const handleTranslationToggle = (enabled: boolean) => {
  lyricStore.wantTranslation = enabled;
};

const handleRomanizationToggle = (enabled: boolean) => {
  lyricStore.wantRomanization = enabled;
};

const modeOptions: { value: LyricViewMode; label: string }[] = [
  { value: 'cover', label: '封面' },
  { value: 'portrait', label: '写真' },
  { value: 'lyric', label: '歌词' },
];

const close = () => {
  emit('update:open', false);
};
</script>

<template>
  <Drawer
    :open="open"
    side="right"
    overlay-class="lyric-settings-overlay"
    panel-class="lyric-settings-panel"
    @update:open="emit('update:open', $event)"
  >
    <div class="settings-drawer">
      <!-- 头部 -->
      <div class="settings-header">
        <div class="settings-title-group">
          <h2 class="settings-title">歌词页设置</h2>
          <p class="settings-subtitle">调整当前歌词页的显示、颜色与写真行为</p>
        </div>
        <Button variant="unstyled" size="none" class="settings-close-btn" @click="close">
          <Icon :icon="iconX" width="18" height="18" />
        </Button>
      </div>

      <!-- 内容 -->
      <div class="settings-body">
        <!-- 模式切换 -->
        <div class="settings-section">
          <div class="section-title">显示模式</div>
          <div class="mode-switcher">
            <button
              v-for="opt in modeOptions"
              :key="opt.value"
              class="mode-option"
              :class="{ active: currentMode === opt.value }"
              @click="currentMode = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <!-- 字体设置 -->
        <div class="settings-section settings-card">
          <div class="section-title">文字</div>
          <div class="setting-row setting-row-compact">
            <span class="setting-label">大小</span>
            <span class="setting-value">{{ fontSizeLabel }}</span>
          </div>
          <SliderRoot
            :model-value="[lyricStore.fontScale]"
            :min="0.7"
            :max="1.4"
            :step="0.1"
            class="settings-slider-root"
            @update:model-value="(v) => v?.length && lyricStore.updateFontScale(v[0])"
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
            :model-value="[lyricStore.fontWeightIndex]"
            :min="0"
            :max="8"
            :step="1"
            class="settings-slider-root"
            @update:model-value="(v) => v?.length && lyricStore.updateFontWeight(v[0])"
          >
            <SliderTrack class="settings-slider-track">
              <SliderRange class="settings-slider-range" />
            </SliderTrack>
            <SliderThumb class="settings-slider-thumb" />
          </SliderRoot>
        </div>

        <!-- 歌词颜色 -->
        <div class="settings-section settings-card">
          <div class="section-title">歌词颜色</div>
          <div class="color-row">
            <div class="color-item">
              <div class="color-text">
                <span class="color-label">已播字色</span>
                <span class="color-hint">设置当前歌词已播颜色</span>
              </div>
              <button
                class="color-swatch"
                :style="{ backgroundColor: effectivePlayedColor }"
                @click="lyricColorPicker.open('playedColor')"
              ></button>
            </div>
            <div class="color-item">
              <div class="color-text">
                <span class="color-label">未播字色</span>
                <span class="color-hint">设置当前歌词未播颜色</span>
              </div>
              <button
                class="color-swatch"
                :style="{ backgroundColor: effectiveUnplayedColor }"
                @click="lyricColorPicker.open('unplayedColor')"
              ></button>
            </div>
          </div>
          <div class="color-actions">
            <button
              class="reset-btn"
              :class="{ invisible: !hasCustomLyricColors }"
              @click="lyricColorPicker.reset"
            >
              重置
            </button>
          </div>
        </div>

        <!-- 翻译/音译 -->
        <div class="settings-section settings-card">
          <div class="section-title">翻译</div>
          <div class="setting-row">
            <div class="setting-text">
              <span class="setting-label">翻译</span>
              <span class="setting-hint">有翻译时显示翻译</span>
            </div>
            <Switch
              :model-value="lyricStore.wantTranslation"
              :disabled="!lyricStore.hasTranslation"
              @update:model-value="handleTranslationToggle"
            />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <span class="setting-label">音译</span>
              <span class="setting-hint">有音译时显示音译</span>
            </div>
            <Switch
              :model-value="lyricStore.wantRomanization"
              :disabled="!lyricStore.hasRomanization"
              @update:model-value="handleRomanizationToggle"
            />
          </div>
        </div>

        <!-- 背景 -->
        <div class="settings-section settings-card">
          <div class="section-title">显示</div>
          <div class="setting-row">
            <div class="setting-text">
              <span class="setting-label">封面模糊背景</span>
              <span class="setting-hint">使用封面作为沉浸式背景</span>
            </div>
            <Switch v-model="settingStore.lyricPageBackgroundBlur" />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <span class="setting-label">歌词过滤</span>
              <span class="setting-hint">隐藏制作信息与版权声明</span>
            </div>
            <Switch v-model="settingStore.lyricFilterEnabled" />
          </div>
        </div>

        <!-- 写真模式专属设置 -->
        <template v-if="currentMode === 'portrait'">
          <div class="settings-section settings-card portrait-card">
            <div class="section-title">写真设置</div>
            <div class="setting-row setting-row-compact">
              <span class="setting-label">背景透明度</span>
              <span class="setting-value">{{ backdropOpacityLabel }}</span>
            </div>
            <SliderRoot
              :model-value="[settingStore.lyricBackdropOpacity]"
              :min="10"
              :max="100"
              :step="5"
              class="settings-slider-root"
              @update:model-value="(v) => v?.length && (settingStore.lyricBackdropOpacity = v[0])"
            >
              <SliderTrack class="settings-slider-track">
                <SliderRange class="settings-slider-range" />
              </SliderTrack>
              <SliderThumb class="settings-slider-thumb" />
            </SliderRoot>
            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-label">自动轮播</span>
                <span class="setting-hint">多张写真时自动切换</span>
              </div>
              <Switch v-model="settingStore.lyricCarouselEnabled" />
            </div>
            <template v-if="settingStore.lyricCarouselEnabled">
              <div class="setting-row setting-row-compact">
                <span class="setting-label">轮播间隔</span>
                <span class="setting-value">{{ carouselIntervalLabel }}</span>
              </div>
              <SliderRoot
                :model-value="[settingStore.lyricCarouselInterval]"
                :min="5"
                :max="60"
                :step="5"
                class="settings-slider-root"
                @update:model-value="
                  (v) => v?.length && (settingStore.lyricCarouselInterval = v[0])
                "
              >
                <SliderTrack class="settings-slider-track">
                  <SliderRange class="settings-slider-range" />
                </SliderTrack>
                <SliderThumb class="settings-slider-thumb" />
              </SliderRoot>
            </template>
            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-label">歌词自动收起</span>
                <span class="setting-hint">无操作后收起到底部两行</span>
              </div>
              <Switch v-model="settingStore.lyricAutoCollapseEnabled" />
            </div>
            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-label">收起时隐藏控制栏</span>
                <span class="setting-hint">让写真画面更干净</span>
              </div>
              <Switch v-model="settingStore.lyricCollapseHideControls" />
            </div>
          </div>
        </template>
      </div>
    </div>
  </Drawer>

  <!-- 颜色选择器对话框 -->
  <ColorPickerDialog
    :open="lyricColorPicker.isOpen.value"
    :title="lyricColorPicker.activeTitle.value"
    :value="lyricColorPicker.activeValue.value"
    :presets="lyricColorPicker.presets"
    :dynamic-option="lyricColorPicker.dynamicOption.value"
    @update:open="(open: boolean) => !open && lyricColorPicker.close()"
    @confirm="lyricColorPicker.apply"
  />
</template>

<style>
/* Drawer 面板样式：跟随主题 */
.lyric-settings-panel {
  top: 0 !important;
  bottom: 0 !important;
  width: min(360px, 90vw) !important;
  background: var(--color-bg-card) !important;
  border-color: rgba(0, 0, 0, 0.08) !important;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.12) !important;
}

.dark .lyric-settings-panel {
  border-color: rgba(255, 255, 255, 0.08) !important;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.4) !important;
}

.lyric-settings-overlay {
  background: rgba(0, 0, 0, 0.3) !important;
}
</style>

<style scoped>
.settings-drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  color: var(--color-text-main);
  user-select: none;
  -webkit-user-select: none;
}

.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--color-border-light);
  flex-shrink: 0;
  gap: 16px;
}

.settings-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.settings-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--color-text-main);
}

.settings-subtitle {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary);
}

.settings-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--color-text-main);
  opacity: 0.5;
  transition: all 0.2s;
}

.settings-close-btn:hover {
  opacity: 1;
  background: var(--color-border-light);
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-width: none;
}

.settings-body::-webkit-scrollbar {
  display: none;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-card {
  padding: 14px 14px 12px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--color-text-main) 5%, var(--color-bg-card) 95%);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
  gap: 14px;
}

.setting-row-compact {
  min-height: 24px;
}

.setting-row .setting-text {
  flex: 1;
}

.setting-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-main);
}

.setting-hint {
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-secondary);
}

.setting-value {
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
  color: var(--color-text-secondary);
}

.settings-card .settings-slider-root {
  margin: 2px 0 4px;
}

.setting-slider {
  width: 100%;
}

.settings-slider-root {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 24px;
  touch-action: none;
  user-select: none;
  cursor: pointer;
}

.settings-slider-track {
  position: relative;
  flex-grow: 1;
  height: 4px;
  border-radius: 9999px;
  background-color: #d1d5db;
}

:global(.dark) .settings-slider-track {
  background-color: #6b7280;
}

.settings-slider-range {
  position: absolute;
  height: 100%;
  border-radius: 9999px;
  background-color: var(--color-primary);
}

.settings-slider-thumb {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background-color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  outline: none;
}

.mode-switcher {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: color-mix(in srgb, var(--color-text-main) 8%, var(--color-bg-card) 92%);
  border-radius: 12px;
}

.mode-option {
  flex: 1;
  padding: 8px 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-option:hover {
  color: var(--color-text-main);
}

.mode-option.active {
  color: var(--color-text-main);
  background: var(--color-bg-card);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.color-row {
  display: grid;
  gap: 12px;
}

.color-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-text-main) 5%, var(--color-bg-card) 95%);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.color-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.color-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.color-hint {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.color-swatch {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--color-border-light);
  cursor: pointer;
  transition: transform 0.15s ease;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}

.color-swatch:hover {
  transform: scale(1.08);
}

.color-actions {
  display: flex;
  justify-content: flex-end;
  min-height: 18px;
  padding-top: 2px;
}

.reset-btn {
  min-height: 18px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  transition: color 0.2s;
}

.reset-btn:hover {
  color: var(--color-primary);
}
</style>
