<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import type { CloseBehavior, ThemeMode } from '../../../../shared/app';
import type { AccentMode } from '@/stores/theme';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { ACCENT_PRESETS } from '@/utils/color';
import { iconPalette } from '@/icons';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { accentModeOptions, closeBehaviorOptions, sectionTitles, themeOptions } from '../constants';

const settingStore = useSettingStore();
const themeStore = useThemeStore();
const showAccentPicker = ref(false);
const accentPresetValues = ACCENT_PRESETS.map((item) => item.color);
const title = sectionTitles.appearance;
const accentPresets = ACCENT_PRESETS;
const resolvedTitle = computed(() => title.label);
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
        <p class="text-sm text-text-secondary">切歌自动跟随封面，或固定为预设 / 自定义颜色</p>
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
        <h3 class="font-semibold">全局主题色</h3>
        <p class="text-sm text-text-secondary">关闭后仅播放栏跟随主题色</p>
      </div>
      <Switch
        :model-value="themeStore.globalAccent"
        @update:model-value="themeStore.setGlobalAccent(Boolean($event))"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">记住窗口大小</h3>
        <p class="text-sm text-text-secondary">在下次启动时自动恢复窗口大小和位置</p>
      </div>
      <Switch v-model="settingStore.rememberWindowSize" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音质音效徽标</h3>
        <p class="text-sm text-text-secondary">在播放器音质按钮上显示当前实际音质或音效标识</p>
      </div>
      <Switch v-model="settingStore.showAudioQualityBadge" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放列表计数</h3>
        <p class="text-sm text-text-secondary">在播放器播放列表图标上显示计数</p>
      </div>
      <Switch v-model="settingStore.showPlaylistCount" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">搜索框默认推荐词</h3>
        <p class="text-sm text-text-secondary">在搜索框显示默认推荐词，可能有广告</p>
      </div>
      <Switch v-model="settingStore.searchDefaultEnabled" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">侧边栏折叠</h3>
        <p class="text-sm text-text-secondary">启用后可通过快捷键或标题栏按钮折叠侧边栏</p>
      </div>
      <Switch v-model="settingStore.sidebarCollapseEnabled" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">关闭行为</h3>
        <p class="text-sm text-text-secondary">点击窗口关闭按钮时的应用行为</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.closeBehavior"
        :options="closeBehaviorOptions"
        @update:model-value="
          settingStore.closeBehavior = $event as CloseBehavior;
          settingStore.syncCloseBehavior();
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">开机自启动</h3>
        <p class="text-sm text-text-secondary">登录系统时自动启动应用</p>
      </div>
      <Switch
        v-model="settingStore.autoLaunch"
        @update:model-value="settingStore.syncAutoLaunch()"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启动时最小化到托盘</h3>
        <p class="text-sm text-text-secondary">启动后不显示主窗口，直接最小化到系统托盘</p>
      </div>
      <Switch
        v-model="settingStore.startMinimized"
        @update:model-value="settingStore.syncStartMinimized()"
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
