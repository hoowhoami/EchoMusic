<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { useToastStore } from '@/stores/toast';
import { suspendRendererMemoryDiagnosticsForRelaunch } from '@/utils/rendererMemoryDiagnostics';
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
const toastStore = useToastStore();
const restarting = ref(false);
const restartForBackground = async () => {
  if (restarting.value) return;
  restarting.value = true;
  try {
    // Wait for the current preference to reach the main process before quitting.
    await settingStore.setWindowBackground({});
    if (!settingStore.appIsPackaged) {
      toastStore.info('设置已保存，请重新启动开发服务以生效');
      restarting.value = false;
      return;
    }
    suspendRendererMemoryDiagnosticsForRelaunch();
    if (!(await window.electron?.appInfo?.relaunch())) throw new Error('Relaunch unavailable');
  } catch {
    restarting.value = false;
    toastStore.warning('未能自动重启，请手动退出并重新打开应用');
  }
};
const showAccentPicker = ref(false);
const showBackgroundPicker = ref(false);
const backgroundControlsDisabled = computed(
  () => !settingStore.windowBackground.enabled || !settingStore.windowBackgroundActiveEnabled,
);
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
      <Icon :icon="iconPalette" width="20" height="20" class="text-primary-text" />
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
        <h3 class="font-semibold">透明背景</h3>
        <p class="text-sm text-text-secondary">默认关闭；开启或关闭后，重启应用生效</p>
        <p
          v-if="settingStore.windowBackgroundRestartRequired"
          class="text-sm text-primary-text"
          role="status"
        >
          设置已更改，请重启应用以{{
            settingStore.windowBackground.enabled ? '启用透明背景' : '恢复普通窗口'
          }}
          <button
            type="button"
            class="ml-2 cursor-pointer underline underline-offset-4 disabled:cursor-wait disabled:opacity-50"
            :disabled="restarting"
            @click="restartForBackground"
          >
            {{ restarting ? '正在重启…' : '立即重启' }}
          </button>
        </p>
      </div>
      <Switch
        :model-value="settingStore.windowBackground.enabled"
        :disabled="restarting"
        @update:model-value="settingStore.setWindowBackground({ enabled: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">背景透明度</h3>
        <p class="text-sm text-text-secondary">
          0% 为不透明；应用于主界面及封面/纯歌词页，写真模式保持原样
        </p>
      </div>
      <Slider
        class="w-48"
        :model-value="settingStore.windowBackground.transparency"
        :min="0"
        :max="100"
        :step="5"
        show-value
        value-suffix="%"
        aria-label="背景透明度"
        :disabled="backgroundControlsDisabled || settingStore.windowBackground.frosted"
        @update:model-value="settingStore.setWindowBackground({ transparency: $event })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">毛玻璃</h3>
        <p class="text-sm text-text-secondary">
          {{
            settingStore.supportsWindowFrost
              ? '使用系统模糊效果，与底色及其透明度调节互斥；关闭后恢复原设置'
              : '当前系统不支持毛玻璃，可使用背景透明度'
          }}
        </p>
      </div>
      <Switch
        :model-value="settingStore.windowBackground.frosted"
        :disabled="backgroundControlsDisabled || !settingStore.supportsWindowFrost"
        @update:model-value="settingStore.setWindowBackground({ frosted: Boolean($event) })"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">背景底色</h3>
        <p class="text-sm text-text-secondary">
          {{ settingStore.windowBackground.color ? '自定义底色' : '跟随深浅色主题' }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <button
          class="settings-color-reset disabled:opacity-40"
          :disabled="
            backgroundControlsDisabled ||
            settingStore.windowBackground.frosted ||
            !settingStore.windowBackground.color
          "
          @click="settingStore.setWindowBackground({ color: '' })"
        >
          跟随主题
        </button>
        <button
          class="settings-color-swatch disabled:opacity-40"
          aria-label="选择背景底色"
          :disabled="backgroundControlsDisabled || settingStore.windowBackground.frosted"
          :style="{ background: settingStore.windowBackground.color || 'var(--surface-main-base)' }"
          @click="showBackgroundPicker = true"
        ></button>
      </div>
    </div>
    <ColorPickerDialog
      :open="showBackgroundPicker"
      title="选择背景底色"
      :value="settingStore.windowBackground.color || (themeStore.isDark ? '#26262a' : '#f5f5f7')"
      :presets="accentPresetValues"
      @update:open="showBackgroundPicker = $event"
      @confirm="(color: string) => settingStore.setWindowBackground({ color })"
    />
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
          <h3 class="font-semibold">渐变浓度</h3>
          <p class="text-sm text-text-secondary">100% 为默认浓度，向左调淡，向右加浓</p>
        </div>
        <Slider
          class="w-48"
          :model-value="themeStore.accentGradientStrength"
          :min="20"
          :max="200"
          :step="5"
          show-value
          value-suffix="%"
          aria-label="渐变浓度"
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
