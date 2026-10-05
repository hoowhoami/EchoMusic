<script setup lang="ts">
import { useThemeStore } from '@/stores/theme';
import { useSettingStore } from '@/stores/setting';
import Switch from '@/components/ui/Switch.vue';
import { useWindowAppearance } from './useWindowAppearance';
const setting = useSettingStore();
const theme = useThemeStore();
const { frosted, frostedKeepOnBlur, error, setFrosted, setFrostedKeepOnBlur } =
  useWindowAppearance();
const isWindows = window.electron?.platform === 'win32';
</script>
<template>
  <section class="window-effects">
    <div class="effects-row">
      <label for="window-frosted">窗口毛玻璃</label>
      <Switch
        id="window-frosted"
        :model-value="frosted"
        :disabled="!setting.supportsWindowFrost"
        aria-label="窗口毛玻璃"
        @update:model-value="setFrosted"
      />
    </div>
    <template v-if="isWindows && frosted">
      <div class="effects-row">
        <label for="window-frosted-keep">失焦时保持毛玻璃效果</label>
        <Switch
          id="window-frosted-keep"
          :model-value="frostedKeepOnBlur"
          aria-label="失焦时保持毛玻璃效果"
          @update:model-value="setFrostedKeepOnBlur"
        />
      </div>
      <p class="effects-status">实验性选项，开启后在移动窗口时会暂时丢失模糊，切换立即生效</p>
    </template>
    <p
      v-if="error || setting.windowBackgroundUnavailableReason"
      role="status"
      class="effects-status"
    >
      {{ error || setting.windowBackgroundUnavailableReason }}
    </p>
    <p v-if="frosted && theme.windowTransparency === 0" class="effects-status">
      提高透明度可看到窗口后方的模糊效果。
    </p>
    <p v-if="!setting.supportsWindowFrost" class="effects-status">当前桌面不提供窗口毛玻璃。</p>
  </section>
</template>
<style scoped>
.window-effects {
  display: grid;
  gap: 8px;
}
.effects-status {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.effects-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  font-size: 13px;
}
</style>
