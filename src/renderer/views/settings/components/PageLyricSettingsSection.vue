<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import { useLyricStore } from '@/stores/lyric';
import { useLyricColorPicker } from '@/composables/useLyricColorPicker';
import Switch from '@/components/ui/Switch.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const lyricStore = useLyricStore();
const { activeValue, activeTitle, isOpen, dynamicOption, presets, open, close, apply, reset } =
  useLyricColorPicker();
</script>

<template>
  <SettingsSectionShell id="pageLyric" :title="sectionTitles.pageLyric.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.pageLyric.icon"
        :icon="sectionTitles.pageLyric.icon"
        width="20"
        height="20"
        class="text-primary-text"
      />
    </template>

    <div class="settings-item items-start">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词颜色</h3>
        <p class="text-sm text-text-secondary">播放页皮肤未单独设置颜色时使用的已播与未播字色</p>
      </div>
      <div class="settings-color-stack">
        <div class="settings-color-grid">
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">已播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: lyricStore.effectivePlayedColor }"
              @click="open('playedColor')"
            ></button>
          </div>
          <div class="settings-color-item">
            <span class="text-[13px] font-semibold text-text-secondary">未播字色</span>
            <button
              type="button"
              class="settings-color-swatch"
              :style="{ backgroundColor: lyricStore.effectiveUnplayedColor }"
              @click="open('unplayedColor')"
            ></button>
          </div>
        </div>
        <div class="settings-color-actions">
          <button
            class="settings-action"
            type="button"
            :class="{ invisible: !lyricStore.playedColor && !lyricStore.unplayedColor }"
            @click="reset"
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
          将封面图片模糊化作为播放页背景，关闭时使用主题色纯色背景
        </p>
      </div>
      <Switch v-model="settingStore.lyricPageBackgroundBlur" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">背景律动</h3>
        <p class="text-sm text-text-secondary">
          开启后，播放页封面模糊背景会变成无规律色块流动效果，此功能会增加性能消耗
        </p>
      </div>
      <Switch
        v-model="settingStore.lyricPageBackgroundRhythm"
        :disabled="!settingStore.lyricPageBackgroundBlur"
      />
    </div>

    <ColorPickerDialog
      :open="isOpen"
      :title="activeTitle"
      :value="activeValue"
      :presets="presets"
      :dynamic-option="dynamicOption"
      @update:open="(nextOpen) => !nextOpen && close()"
      @confirm="apply"
    />
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
