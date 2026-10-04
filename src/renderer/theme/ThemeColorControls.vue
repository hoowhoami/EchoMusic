<script setup lang="ts">
import { computed, ref } from 'vue';
import { useThemeStore } from '@/stores/theme';
import type { AccentSource } from './model';
import Select from '@/components/ui/Select.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { ACCENT_PRESETS } from '@/utils/color';
const theme = useThemeStore();
const prefs = computed(() => theme.activePreferences);
const showAccent = ref(false);
const colours = ACCENT_PRESETS.map((p) => p.color);
const accentOptions = [
  { label: '跟随主题', value: 'theme' },
  { label: '歌曲封面取色', value: 'cover' },
  { label: '自选颜色', value: 'custom' },
];
</script>
<template>
  <section class="editor-section">
    <header class="editor-heading">
      <h2>强调色</h2>
      <span>按钮与进度条</span>
    </header>
    <Select
      :model-value="prefs.accent.source"
      :options="accentOptions"
      aria-label="界面强调色来源"
      @update:model-value="theme.setMode($event as AccentSource)"
    />
    <div v-if="prefs.accent.source === 'custom'" class="accent-swatches" aria-label="强调色色板">
      <button
        v-for="color in colours.slice(0, 7)"
        :key="color"
        :style="{ background: color }"
        :aria-label="`强调色 ${color}`"
        :aria-pressed="prefs.accent.color.toLowerCase() === color.toLowerCase()"
        @click="theme.setCustomColor(color)"
      />
      <button
        class="custom-accent"
        :style="{ background: prefs.accent.color }"
        aria-label="自定义强调色"
        @click="showAccent = true"
      >
        ＋
      </button>
    </div>
  </section>
  <ColorPickerDialog
    :open="showAccent"
    title="强调色"
    :value="prefs.accent.color"
    :presets="colours"
    @update:open="showAccent = $event"
    @confirm="theme.setCustomColor($event)"
  />
</template>
<style scoped src="./themeEditor.css"></style>
<style scoped>
.accent-swatches {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
  padding: 3px;
}
.accent-swatches button {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  border: 1px solid var(--border-subtle);
}
.accent-swatches button[aria-pressed='true'] {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}
.custom-accent {
  color: var(--text-main);
}
</style>
