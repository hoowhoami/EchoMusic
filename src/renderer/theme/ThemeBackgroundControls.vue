<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';
import type { AppearancePreference } from './model';
import Select from '@/components/ui/Select.vue';
import Slider from '@/components/ui/Slider.vue';
import Switch from '@/components/ui/Switch.vue';
import WindowEffects from './WindowEffects.vue';
const theme = useThemeStore();
const prefs = computed(() => theme.activePreferences);
const atmosphereOptions = [
  { label: '歌曲封面渐变', value: 'cover' },
  { label: '关闭', value: 'off' },
];
const updateAtmosphere = (patch: Partial<AppearancePreference['atmosphere']>) =>
  theme.updateGeneralPreferences({ atmosphere: { ...prefs.value.atmosphere, ...patch } });
</script>
<template>
  <section class="editor-section">
    <header class="editor-heading">
      <h2>背景氛围</h2>
    </header>
    <div class="editor-field">
      <Select
        :model-value="prefs.atmosphere.source"
        :options="atmosphereOptions"
        aria-label="背景氛围"
        @update:model-value="
          updateAtmosphere({ source: $event as AppearancePreference['atmosphere']['source'] })
        "
      />
    </div>
    <div v-if="prefs.atmosphere.source === 'cover'" class="atmosphere-controls">
      <div class="editor-field">
        <label class="editor-range-heading"
          >渐变范围<output>{{ prefs.atmosphere.height }}%</output></label
        ><Slider
          :model-value="prefs.atmosphere.height"
          :min="20"
          :max="100"
          :step="5"
          aria-label="氛围范围"
          @update:model-value="updateAtmosphere({ height: $event })"
        />
      </div>
      <div class="editor-field">
        <label class="editor-range-heading"
          >渐变强度<output>{{ prefs.atmosphere.strength }}%</output></label
        ><Slider
          :model-value="prefs.atmosphere.strength"
          :min="20"
          :max="200"
          :step="5"
          aria-label="氛围强度"
          @update:model-value="updateAtmosphere({ strength: $event })"
        />
      </div>
    </div>
  </section>
  <section class="editor-section">
    <header class="editor-heading"><h2>右侧面板遮罩</h2></header>
    <div class="editor-field">
      <label class="editor-range-heading"
        >遮罩强度<output>{{ Math.round(theme.panelOpacity) }}%</output></label
      >
      <Slider
        :model-value="theme.panelOpacity"
        :min="0"
        :max="100"
        :step="1"
        aria-label="右侧面板遮罩"
        @update:model-value="theme.setPanelOpacity($event)"
      />
      <span class="editor-help">右侧内容区与底部播放器</span>
    </div>
  </section>
  <section class="editor-section">
    <header class="editor-heading"><h2>皮肤透明度</h2></header>
    <div class="editor-field">
      <label class="editor-range-heading"
        >透明度<output>{{ theme.windowTransparency }}%</output></label
      >
      <Slider
        :model-value="theme.windowTransparency"
        :min="0"
        :max="100"
        :step="1"
        aria-label="皮肤透明度"
        @update:model-value="theme.updateGeneralPreferences({ transparency: $event })"
      />
    </div>
    <WindowEffects />
  </section>
  <section class="editor-section">
    <div class="editor-heading floating-effect-heading">
      <label for="floating-surface-frosted">弹出层毛玻璃</label>
      <Switch
        id="floating-surface-frosted"
        :model-value="theme.floatingSurfaceFrosted"
        aria-label="弹出层毛玻璃"
        @update:model-value="theme.updateGeneralPreferences({ floatingSurfaceFrosted: $event })"
      />
    </div>
    <span class="editor-help">菜单、弹窗与抽屉</span>
  </section>
</template>
<style scoped src="./themeEditor.css"></style>
<style scoped>
.atmosphere-controls {
  display: grid;
  gap: 8px;
  padding: 10px 0 0;
}
.floating-effect-heading {
  align-items: center;
  font-size: 14px;
  font-weight: 600;
}
</style>
