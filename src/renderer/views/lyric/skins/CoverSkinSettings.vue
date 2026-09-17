<script setup lang="ts">
import { computed } from 'vue';
import Switch from '@/components/ui/Switch.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import { HOST_SKIN_KEYS, LYRIC_SKIN_COVER_DEFAULTS } from './config';
import LyricTextStyleSettings from './LyricTextStyleSettings.vue';

const { settings, patch } = useLyricSkin(HOST_SKIN_KEYS.cover, LYRIC_SKIN_COVER_DEFAULTS);

const dynamicAlbumCover = computed({
  get: () => Boolean(settings.value.dynamicAlbumCover),
  set: (value: boolean) => {
    patch({ dynamicAlbumCover: value });
  },
});
</script>

<template>
  <div class="skin-settings">
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">专辑动态封面</span>
        <span class="setting-hint">无资源时显示静态封面</span>
      </div>
      <Switch v-model="dynamicAlbumCover" />
    </div>
  </div>

  <div class="skin-settings">
    <div class="setting-row setting-row-compact">
      <div class="setting-text">
        <span class="setting-label">歌词样式</span>
        <span class="setting-hint">封面模式下歌词的字号、字重与颜色</span>
      </div>
    </div>
    <LyricTextStyleSettings :skin-key="HOST_SKIN_KEYS.cover" />
  </div>
</template>

<style scoped src="./skinSettings.css"></style>
