import { computed, type ComputedRef } from 'vue';
import { useSettingStore, resolveLyricPageIsDark } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';

/** 歌词页是否深色（响应式）：由外观模式设置与主程序主题共同决定。 */
export function useLyricPageIsDark(): ComputedRef<boolean> {
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();
  return computed(() =>
    resolveLyricPageIsDark(settingStore.lyricPageAppearanceMode, themeStore.isDark),
  );
}
