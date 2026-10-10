import { computed, watch, type Ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { coverFallbackRevision } from '@/plugins/coverFallback';
import { resolveCoverColorUrls } from '@/utils/cover';
import type { AppLifetime } from './lifetime';
import type { AppPlayer } from './useAppRuntime';

export function useAppAppearance(
  player: Readonly<Ref<AppPlayer | null>>,
  isMiniPlayerRoute: Readonly<Ref<boolean>>,
  lifetime: AppLifetime,
) {
  const settings = useSettingStore();
  const themeStore = useThemeStore();
  const currentCoverColorUrls = computed(() =>
    resolveCoverColorUrls(player.value?.currentTrackSnapshot?.coverUrl, 300, { scope: 'theme' }),
  );
  const updateTheme = () => themeStore.onThemeChange();

  const applyGlobalFont = () => {
    document.documentElement.style.fontFamily = settings.buildGlobalFontFamily();
  };

  watch(
    () => [
      themeStore.activePreferences,
      themeStore.currentTheme,
      themeStore.cssTokens,
      themeStore.surfaceVariables,
    ],
    () => {
      if (!isMiniPlayerRoute.value) themeStore.applyCurrent();
    },
    { deep: true },
  );
  watch(
    () => settings.floatingSurfaceFrosted,
    (enabled) => {
      if (!isMiniPlayerRoute.value)
        document.documentElement.classList.toggle('floating-surfaces-frosted', enabled === true);
    },
    { immediate: true },
  );
  watch(
    () => settings.globalFont,
    () => {
      if (!isMiniPlayerRoute.value) applyGlobalFont();
    },
  );
  // 切歌时，cover 模式下自动提取封面主色
  watch(
    () => [player.value?.currentTrackSnapshot?.coverUrl, coverFallbackRevision.value],
    () => {
      if (isMiniPlayerRoute.value) return;
      const coverColorUrls = currentCoverColorUrls.value;
      if (themeStore.accentMode === 'cover') {
        void themeStore.refreshFromCover(coverColorUrls);
        return;
      }
      void themeStore.refreshCoverColor(coverColorUrls);
    },
    { immediate: true },
  );

  // 切换到 cover 模式时，立即用当前封面重新提取主色
  watch(
    () => themeStore.accentMode,
    (mode) => {
      if (isMiniPlayerRoute.value) return;
      if (mode !== 'cover') return;
      void themeStore.refreshFromCover(currentCoverColorUrls.value);
    },
  );
  const onWindowBackgroundChanged = () => {
    void settings.initWindowBackground();
  };
  return {
    start() {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', updateTheme);
      lifetime.add(() => query.removeEventListener('change', updateTheme));
    },
    apply() {
      updateTheme();
      applyGlobalFont();
      themeStore.applyCurrent();
    },
    async initWindowBackground() {
      window.electron.ipcRenderer.on('window-background:changed', onWindowBackgroundChanged);
      lifetime.add(() =>
        window.electron.ipcRenderer.off('window-background:changed', onWindowBackgroundChanged),
      );
      await settings.initWindowBackground();
    },
  };
}
