<script setup lang="ts">
import { computed, onErrorCaptured, provide, readonly } from 'vue';
import { useDocumentVisibility, usePreferredReducedMotion } from '@vueuse/core';
import { copyAppearance } from './model';
import { useThemeStore } from '@/stores/theme';
import { appThemeContextKey, failAppTheme } from './registry';
const props = defineProps<{ layer: 'background' | 'sidebar' | 'player' | 'settings' }>();
const theme = useThemeStore();
const entry = computed(() => theme.currentTheme);
const component = computed(() =>
  props.layer === 'settings'
    ? entry.value.settings?.component
    : entry.value.decorations?.[props.layer],
);
const owner = entry.value;
const visibility = useDocumentVisibility(),
  reducedMotion = usePreferredReducedMotion();
provide(appThemeContextKey, {
  key: owner.key,
  isDark: computed(() => theme.isDark),
  settings: computed(() => readonly(copyAppearance(theme.themeSettings))),
  accentColor: computed(() => theme.accentColor),
  appearance: computed(() => readonly(copyAppearance(theme.appearance))),
  motionEnabled: computed(() => visibility.value === 'visible' && reducedMotion.value !== 'reduce'),
  imageBlur: computed(() => 0),
  updateSettings: (patch) => {
    if (theme.currentTheme !== owner) throw new Error('主题已失效');
    theme.updateThemeSettings(patch);
  },
  resetSettings: () => {
    if (theme.currentTheme !== owner) return;
    theme.resetThemeSettings();
  },
});
onErrorCaptured((error) => {
  failAppTheme(owner, error);
  return false;
});
</script>
<template><component :is="component" v-if="component" /></template>
