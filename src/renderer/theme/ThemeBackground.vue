<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useThemeStore } from '@/stores/theme';
import { useToastStore } from '@/stores/toast';
import ThemeContent from './ThemeContent.vue';
import ThemeImage from './ThemeImage.vue';
import { CUSTOM_THEME_KEY } from './model';
import { extractAverageColor } from '@/utils/color';
const theme = useThemeStore(),
  toast = useToastStore();
const imageUrl = ref('');
const isCustom = computed(() => theme.effectiveThemeKey === CUSTOM_THEME_KEY);
let revision = 0;
let sampling: AbortController | undefined;
const source = computed(() => theme.backgroundImage);
watch(
  [source, isCustom],
  async ([value, custom]) => {
    const current = ++revision;
    sampling?.abort();
    const controller = new AbortController();
    sampling = controller;
    imageUrl.value = '';
    if (!value) return;
    try {
      const result = /^[a-f0-9]{64}\.png$/.test(value)
        ? await window.electron.ipcRenderer.invoke('appearance:read-image', value)
        : { url: value };
      if (current !== revision) return;
      imageUrl.value = result.url;
      if (custom) {
        const color = await extractAverageColor(result.url, { signal: controller.signal });
        if (current === revision) theme.setCustomBackgroundSample(value, color);
      }
    } catch {
      if (current === revision) toast.warning('背景图片不可用，已显示主题默认底色');
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  revision++;
  sampling?.abort();
});
const style = computed(() => {
  const bg = theme.override.background,
    definition = theme.appearance.background;
  return {
    backgroundImage: imageUrl.value
      ? `url(${JSON.stringify(imageUrl.value)})`
      : definition?.gradient,
    backgroundPosition: isCustom.value
      ? `${bg.positionX}% ${bg.positionY}%`
      : (definition?.position ?? 'center'),
    backgroundSize: isCustom.value ? bg.fit : (definition?.fit ?? 'cover'),
  };
});
</script>
<template>
  <div class="theme-background" aria-hidden="true">
    <div
      class="theme-background-base"
      :style="{
        backgroundColor: theme.appearance.background?.color ?? theme.appearance.tokens.shell,
      }"
    />
    <ThemeImage
      v-if="imageUrl && isCustom"
      class="theme-background-image"
      :image="imageUrl"
      :background="theme.override.background"
    />
    <div v-else class="theme-background-image" :style="style" />
    <div
      v-if="imageUrl && isCustom && theme.override.background.shade"
      class="theme-background-shade"
      :style="{
        backgroundColor: theme.appearance.tokens.shell,
        opacity: theme.override.background.shade / 100,
      }"
    />
    <ThemeContent :key="theme.currentTheme.revision + theme.effectiveThemeKey" layer="background" />
  </div>
</template>
<style scoped>
.theme-background {
  z-index: -2;
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.theme-background-base,
.theme-background-image,
.theme-background-shade {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
}
.theme-background-image {
  transition: background-color 0.2s;
}
.theme-background:deep(
  > *:not(.theme-background-base):not(.theme-background-image):not(.theme-background-shade)
) {
  position: absolute;
  inset: 0;
}
</style>
