<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { DEFAULT_LYRIC_FILTER_PATTERN, useLyricStore } from '@/stores/lyric';
import { useLyricColorPicker } from '@/composables/useLyricColorPicker';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import PageLyricIcon from '@/components/ui/PageLyricIcon.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const lyricStore = useLyricStore();
const lyricColorPicker = useLyricColorPicker();

const lyricFontSizeLabel = computed(() => `${Math.round(lyricStore.fontScale * 100)}%`);
const lyricFontWeightLabel = computed(() => `W${lyricStore.fontWeightValue}`);
const hasCustomLyricColors = computed(() =>
  Boolean(lyricStore.playedColor || lyricStore.unplayedColor),
);
</script>

<template>
  <SettingsSectionShell id="pageLyric" :title="sectionTitles.pageLyric.label">
    <template #icon>
      <PageLyricIcon :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示翻译</h3>
        <p class="text-sm text-text-secondary">有翻译时在歌词页面中显示翻译行</p>
      </div>
      <Switch v-model="lyricStore.wantTranslation" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示音译</h3>
        <p class="text-sm text-text-secondary">有音译时在歌词页面中显示音译行</p>
      </div>
      <Switch v-model="lyricStore.wantRomanization" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">字体大小</h3>
        <p class="text-sm text-text-secondary">调整歌词页面的文字大小</p>
      </div>
      <Slider
        class="w-48"
        :model-value="lyricStore.fontScale"
        :min="0.7"
        :max="1.4"
        :step="0.1"
        show-value
        :format-value="() => lyricFontSizeLabel"
        @update:model-value="lyricStore.updateFontScale($event)"
        @value-commit="lyricStore.updateFontScale($event)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">字体字重</h3>
        <p class="text-sm text-text-secondary">调整歌词页面的文字粗细</p>
      </div>
      <Slider
        class="w-48"
        :model-value="lyricStore.fontWeightIndex"
        :min="0"
        :max="8"
        :step="1"
        show-value
        :format-value="() => lyricFontWeightLabel"
        @update:model-value="lyricStore.updateFontWeight($event)"
        @value-commit="lyricStore.updateFontWeight($event)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item items-start">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词颜色</h3>
        <p class="text-sm text-text-secondary">设置逐字歌词的已播颜色与未播颜色</p>
      </div>
      <div class="settings-color-stack">
        <div class="settings-color-grid">
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">已播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: lyricStore.effectivePlayedColor }"
              @click="lyricColorPicker.open('playedColor')"
            ></button>
          </div>
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">未播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: lyricStore.effectiveUnplayedColor }"
              @click="lyricColorPicker.open('unplayedColor')"
            ></button>
          </div>
        </div>
        <div class="settings-color-actions">
          <button
            type="button"
            class="settings-color-reset"
            :class="{ invisible: !hasCustomLyricColors }"
            @click="lyricColorPicker.reset"
          >
            重置
          </button>
        </div>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">封面模糊背景</h3>
        <p class="text-sm text-text-secondary">
          将封面图片模糊化作为歌词页背景，关闭时使用主题色纯色背景
        </p>
      </div>
      <Switch v-model="settingStore.lyricPageBackgroundBlur" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词过滤</h3>
        <p class="text-sm text-text-secondary">过滤非歌词内容（如制作人信息、版权声明等）</p>
      </div>
      <Switch v-model="settingStore.lyricFilterEnabled" />
    </div>
    <template v-if="settingStore.lyricFilterEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item items-start">
        <div class="space-y-1">
          <h3 class="font-semibold">过滤表达式</h3>
          <p class="text-sm text-text-secondary">正则表达式，匹配的行将被隐藏</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="settingStore.lyricFilterPattern"
            type="button"
            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
            @click="settingStore.lyricFilterPattern = ''"
          >
            恢复默认
          </button>
          <input
            v-model="settingStore.lyricFilterPattern"
            type="text"
            class="settings-input w-64"
            :placeholder="DEFAULT_LYRIC_FILTER_PATTERN"
          />
        </div>
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌手写真背景</h3>
        <p class="text-sm text-text-secondary">
          优先使用歌手写真作为背景，获取失败时回退到专辑封面
        </p>
      </div>
      <Switch v-model="settingStore.lyricArtistBackdrop" />
    </div>
    <template v-if="settingStore.lyricArtistBackdrop">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">写真背景透明度</h3>
          <p class="text-sm text-text-secondary">调节歌词页写真模式下的背景透明度</p>
        </div>
        <Slider
          class="w-48"
          :model-value="settingStore.lyricBackdropOpacity"
          :min="10"
          :max="100"
          :step="5"
          show-value
          :value-suffix="'%'"
          @update:model-value="settingStore.lyricBackdropOpacity = $event"
          @value-commit="settingStore.lyricBackdropOpacity = $event"
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">写真自动轮播</h3>
          <p class="text-sm text-text-secondary">多张写真时自动切换</p>
        </div>
        <Switch v-model="settingStore.lyricCarouselEnabled" />
      </div>
      <template v-if="settingStore.lyricCarouselEnabled">
        <div class="settings-divider"></div>
        <div class="settings-item">
          <div class="space-y-1">
            <h3 class="font-semibold">轮播间隔</h3>
            <p class="text-sm text-text-secondary">每张写真的展示时间</p>
          </div>
          <Slider
            class="w-48"
            :model-value="settingStore.lyricCarouselInterval"
            :min="5"
            :max="60"
            :step="5"
            show-value
            :value-suffix="'s'"
            @update:model-value="settingStore.lyricCarouselInterval = $event"
            @value-commit="settingStore.lyricCarouselInterval = $event"
          />
        </div>
      </template>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">歌词自动收起</h3>
          <p class="text-sm text-text-secondary">写真模式下无操作后歌词自动收起到底部两行</p>
        </div>
        <Switch v-model="settingStore.lyricAutoCollapseEnabled" />
      </div>
      <template v-if="settingStore.lyricAutoCollapseEnabled">
        <div class="settings-divider"></div>
        <div class="settings-item">
          <div class="space-y-1">
            <h3 class="font-semibold">收起延迟</h3>
            <p class="text-sm text-text-secondary">无操作后等待多久自动收起</p>
          </div>
          <Slider
            class="w-48"
            :model-value="settingStore.lyricAutoCollapseDelay"
            :min="5"
            :max="60"
            :step="1"
            show-value
            :value-suffix="'s'"
            @update:model-value="settingStore.lyricAutoCollapseDelay = $event"
            @value-commit="settingStore.lyricAutoCollapseDelay = $event"
          />
        </div>
        <div class="settings-divider"></div>
        <div class="settings-item">
          <div class="space-y-1">
            <h3 class="font-semibold">收起时隐藏底部控件</h3>
            <p class="text-sm text-text-secondary">歌词收起时隐藏底部控制按钮</p>
          </div>
          <Switch v-model="settingStore.lyricCollapseHideControls" />
        </div>
      </template>
    </template>

    <ColorPickerDialog
      :open="lyricColorPicker.isOpen.value"
      :title="lyricColorPicker.activeTitle.value"
      :value="lyricColorPicker.activeValue.value"
      :presets="lyricColorPicker.presets"
      :dynamic-option="lyricColorPicker.dynamicOption.value"
      @update:open="(open) => !open && lyricColorPicker.close()"
      @confirm="lyricColorPicker.apply"
    />
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
