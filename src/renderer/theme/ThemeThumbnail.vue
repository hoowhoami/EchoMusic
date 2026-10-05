<script setup lang="ts">
import { DEFAULT_THEME_ACCENT } from '../../shared/themePalette';
import { computed, ref, watch } from 'vue';
import { neutralTokens, PANEL_MATERIAL, type AppThemeAppearance } from './model';
const props = defineProps<{ appearance: AppThemeAppearance; image?: string; dark?: boolean }>();
const previewFailed = ref(false);
watch(
  () => props.image,
  () => {
    previewFailed.value = false;
  },
);
const style = computed(() => {
  const t = { ...neutralTokens(props.dark === true), ...props.appearance.tokens };
  return {
    '--preview-shell': props.appearance.background?.color ?? t.shell,
    '--preview-main': `color-mix(in srgb, ${t.main} ${PANEL_MATERIAL.opacity}%, transparent)`,
    '--preview-player': `color-mix(in srgb, ${t.player} ${PANEL_MATERIAL.opacity}%, transparent)`,
    '--preview-text': t.text,
    '--preview-secondary': t.secondary,
    '--preview-accent': props.appearance.accent ?? DEFAULT_THEME_ACCENT,
    backgroundImage: props.appearance.background?.image
      ? `url(${JSON.stringify(props.appearance.background.image)})`
      : props.appearance.background?.gradient,
  };
});
</script>
<template>
  <div class="theme-thumbnail" :style="style" aria-hidden="true">
    <img
      v-if="image && !previewFailed"
      class="preview-artwork"
      :src="image"
      alt=""
      @error="previewFailed = true"
    />
    <template v-else>
      <div class="preview-sidebar">
        <span class="preview-avatar" />
        <div class="preview-shortcuts"><b /><b /><b /><b /></div>
        <i /><i /><i />
      </div>
      <div class="preview-main">
        <div class="preview-search" />
        <div class="preview-caption" />
        <div class="preview-albums"><b /><b /><b /></div>
        <div class="preview-tracks"><i /><i /></div>
      </div>
      <div class="preview-player">
        <b /><i /><span class="preview-play">▶</span><span class="preview-progress" />
      </div>
    </template>
  </div>
</template>
<style scoped>
.theme-thumbnail {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: 23% 1fr;
  grid-template-rows: 1fr 22%;
  gap: 6px;
  padding: 12px;
  aspect-ratio: 1.6;
  border-radius: 10px;
  overflow: hidden;
  background-color: var(--preview-shell);
  background-size: cover;
  background-position: center;
}
.preview-artwork {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-sidebar {
  grid-row: 1/-1;
  padding: 7px 4px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.preview-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--preview-secondary) 17%, transparent);
}
.preview-shortcuts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.preview-shortcuts b {
  aspect-ratio: 1.6;
  border-radius: 3px;
  background: color-mix(in srgb, var(--preview-secondary) 13%, transparent);
}
.preview-sidebar i {
  width: 80%;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--preview-text) 22%, transparent);
}
.preview-main {
  background: var(--preview-main);
  border-radius: 6px;
  padding: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 0;
  overflow: hidden;
}
.preview-search {
  height: 7px;
  width: 60%;
  border-radius: 4px;
  background: color-mix(in srgb, var(--preview-secondary) 13%, transparent);
}
.preview-caption {
  width: 35%;
  height: 4px;
  margin-top: 2px;
  background: color-mix(in srgb, var(--preview-text) 72%, transparent);
  border-radius: 2px;
}
.preview-albums {
  display: flex;
  gap: 5px;
}
.preview-albums b {
  flex: 1;
  aspect-ratio: 1;
  border-radius: 4px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--preview-accent) 35%, var(--preview-main)),
    color-mix(in srgb, var(--preview-accent) 85%, var(--preview-main))
  );
}
.preview-albums b:nth-child(2) {
  background: linear-gradient(145deg, #d4baa6, #807d77);
}
.preview-albums b:nth-child(3) {
  background: linear-gradient(145deg, #b4c7c0, #57766b);
}
.preview-tracks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.preview-tracks i {
  height: 2px;
  width: 80%;
  background: color-mix(in srgb, var(--preview-secondary) 18%, transparent);
}
.preview-tracks i:last-child {
  width: 55%;
}
.preview-player {
  background: var(--preview-player);
  border-radius: 6px;
  display: flex;
  align-items: center;
  padding: 5px 8px;
  gap: 7px;
  min-width: 0;
}
.preview-player b {
  height: 12px;
  width: 12px;
  border-radius: 3px;
  background: var(--preview-accent);
  opacity: 0.5;
}
.preview-player i {
  height: 3px;
  width: 20%;
  background: color-mix(in srgb, var(--preview-text) 35%, transparent);
  border-radius: 2px;
}
.preview-play {
  margin-left: auto;
  background: var(--preview-accent);
  color: white;
  font-size: 5px;
  width: 13px;
  height: 10px;
  border-radius: 6px;
  display: grid;
  place-items: center;
}
.preview-progress {
  width: 18%;
  height: 2px;
  background: color-mix(in srgb, var(--preview-secondary) 30%, transparent);
}
</style>
