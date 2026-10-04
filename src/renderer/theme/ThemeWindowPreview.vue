<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';
import { PANEL_MATERIAL } from './model';
defineProps<{ image?: string }>();
const theme = useThemeStore();
const tokens = computed(() => theme.appearance.tokens);
const style = computed(() => ({
  background: theme.appearance.background?.color ?? tokens.value.shell,

  color: tokens.value.text,
}));
const surface = (color?: string) => ({
  background: `color-mix(in srgb, ${color} ${PANEL_MATERIAL.opacity}%, transparent)`,
});
</script>
<template>
  <div class="theme-window-preview" :style="style" aria-label="当前外观预览">
    <div
      class="preview-wallpaper"
      :style="{
        backgroundImage: image
          ? `url(${JSON.stringify(image)})`
          : theme.override.background.source === 'theme'
            ? theme.appearance.background?.gradient
            : undefined,
        backgroundSize:
          theme.override.background.source === 'image'
            ? theme.override.background.fit
            : theme.appearance.background?.fit,
        backgroundPosition:
          theme.override.background.source === 'image'
            ? `${theme.override.background.positionX}% ${theme.override.background.positionY}%`
            : theme.appearance.background?.position,
      }"
    />
    <div
      v-if="image"
      class="preview-shade"
      :style="{
        background: tokens.shell,
        opacity:
          theme.override.background.source === 'image' ? theme.override.background.shade / 100 : 0,
      }"
    />
    <aside>
      <span>EchoMusic</span>
      <div class="preview-shortcuts"><b /><b /><b /><b /></div>
      <span>我最喜爱</span><span>播放历史</span>
    </aside>
    <main :style="surface(tokens.main)">
      <span class="preview-search">搜索音乐</span>
      <h3>为您推荐</h3>
      <div class="preview-covers"><b /><b /><b /></div>
    </main>
    <footer :style="surface(tokens.player)">
      <span>正在播放</span><span :style="{ color: theme.accentColor }">◀　▶　▶</span>
    </footer>
  </div>
</template>
<style scoped>
.theme-window-preview {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: 26% 1fr;
  grid-template-rows: 1fr 42px;
  gap: 8px;
  padding: 12px;
  min-height: 225px;
  border-radius: 16px;
  background-repeat: no-repeat;
  overflow: hidden;
}
.preview-wallpaper,
.preview-shade {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-repeat: no-repeat;
  pointer-events: none;
}
.theme-window-preview aside {
  grid-row: 1/-1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  font-size: 11px;
}
.theme-window-preview main {
  padding: 14px;
  border-radius: 10px;
  min-width: 0;
}
.theme-window-preview footer {
  padding: 10px;
  display: flex;
  justify-content: space-between;
  border-radius: 10px;
  font-size: 11px;
}
.preview-shortcuts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.preview-shortcuts b {
  height: 25px;
  border-radius: 6px;
  background: var(--control-muted-bg);
}
.preview-search {
  display: block;
  padding: 7px 10px;
  background: var(--control-muted-bg);
  border-radius: 8px;
  font-size: 11px;
}
.theme-window-preview h3 {
  font-size: 16px;
  margin: 12px 0;
}
.preview-covers {
  display: flex;
  gap: 8px;
}
.preview-covers b {
  flex: 1;
  aspect-ratio: 1;
  border-radius: 7px;
  background: var(--control-muted-bg);
}
</style>
