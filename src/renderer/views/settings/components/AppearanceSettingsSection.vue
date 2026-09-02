<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import type { ThemeMode } from '../../../../shared/app';
import type { AccentMode } from '@/stores/theme';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { ACCENT_PRESETS } from '@/utils/color';
import { iconPalette } from '@/icons';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { accentModeOptions, sectionTitles, themeOptions } from '../constants';

const settingStore = useSettingStore();
const themeStore = useThemeStore();
const showAccentPicker = ref(false);
const accentPresetValues = ACCENT_PRESETS.map((item) => item.color);
const title = sectionTitles.appearance;
const accentPresets = ACCENT_PRESETS;
const resolvedTitle = computed(() => title.label);
const isAccentGradientDefault = computed(
  () => themeStore.accentGradientHeight === 70 && themeStore.accentGradientStrength === 100,
);
</script>

<template>
  <SettingsSectionShell id="appearance" :title="resolvedTitle">
    <template #icon>
      <Icon :icon="iconPalette" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">主题模式</h3>
        <p class="text-sm text-text-secondary">选择您喜欢的主题外观</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.theme"
        :options="themeOptions"
        @update:model-value="settingStore.setTheme($event as ThemeMode)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">主题色来源</h3>
        <p class="text-sm text-text-secondary">关闭动态主题色，或固定为封面 / 预设 / 自定义颜色</p>
      </div>
      <Select
        class="w-45"
        :model-value="themeStore.accentMode"
        :options="accentModeOptions"
        @update:model-value="themeStore.setMode($event as AccentMode)"
      />
    </div>
    <template v-if="themeStore.accentMode === 'preset'">
      <div class="settings-divider"></div>
      <div class="settings-item items-start">
        <div class="space-y-1">
          <h3 class="font-semibold">预设主题色</h3>
          <p class="text-sm text-text-secondary">挑一个贴合心情的配色</p>
        </div>
        <div class="flex gap-2 flex-nowrap">
          <button
            v-for="preset in accentPresets"
            :key="preset.id"
            type="button"
            class="accent-preset-swatch"
            :class="{ 'is-active': themeStore.presetId === preset.id }"
            :style="{ backgroundColor: preset.color }"
            :title="preset.name"
            @click="themeStore.setPreset(preset.id)"
          ></button>
        </div>
      </div>
    </template>
    <template v-if="themeStore.accentMode === 'custom'">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">自定义主题色</h3>
          <p class="text-sm text-text-secondary">从色盘中选一种颜色固定为主题色</p>
        </div>
        <button
          type="button"
          class="settings-color-swatch"
          :style="{ backgroundColor: themeStore.customColor }"
          @click="showAccentPicker = true"
        ></button>
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">顶部渐变色</h3>
        <p class="text-sm text-text-secondary">在界面顶部显示跟随主题色的渐变氛围层</p>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="settings-color-reset disabled:opacity-40 disabled:cursor-default"
          :disabled="isAccentGradientDefault"
          @click="themeStore.resetAccentGradientAppearance()"
        >
          恢复默认
        </button>
        <Switch
          :model-value="themeStore.accentGradient"
          @update:model-value="themeStore.setAccentGradient(Boolean($event))"
        />
      </div>
    </div>
    <template v-if="themeStore.accentGradient">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">渐变范围</h3>
          <p class="text-sm text-text-secondary">控制顶部颜色向下延伸的距离</p>
        </div>
        <Slider
          class="w-48"
          :model-value="themeStore.accentGradientHeight"
          :min="35"
          :max="100"
          :step="5"
          show-value
          value-suffix="%"
          aria-label="渐变范围"
          @update:model-value="themeStore.setAccentGradientHeight($event)"
          @value-commit="themeStore.setAccentGradientHeight($event)"
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">渐变强度</h3>
          <p class="text-sm text-text-secondary">控制主题色氛围的浓淡</p>
        </div>
        <Slider
          class="w-48"
          :model-value="themeStore.accentGradientStrength"
          :min="20"
          :max="100"
          :step="5"
          show-value
          value-suffix="%"
          aria-label="渐变强度"
          @update:model-value="themeStore.setAccentGradientStrength($event)"
          @value-commit="themeStore.setAccentGradientStrength($event)"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局主题色</h3>
        <p class="text-sm text-text-secondary">关闭后仅播放栏跟随主题色</p>
      </div>
      <Switch
        :model-value="themeStore.globalAccent"
        @update:model-value="themeStore.setGlobalAccent(Boolean($event))"
      />
    </div>

    <ColorPickerDialog
      :open="showAccentPicker"
      title="选择主题色"
      :value="themeStore.customColor"
      :presets="accentPresetValues"
      @update:open="(open) => (showAccentPicker = open)"
      @confirm="(color: string) => themeStore.setCustomColor(color)"
    />
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
