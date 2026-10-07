<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import SkinSettingSection from './SkinSettingSection.vue';
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
    <SkinSettingSection title="封面显示">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">动态专辑封面</span>
          <span class="setting-hint">没有动态资源时显示静态封面</span>
        </div>
        <Switch v-model="dynamicAlbumCover" aria-label="动态专辑封面" />
      </div>
      <template #footer>
        <Button
          variant="secondary"
          size="xs"
          :disabled="!dynamicAlbumCover"
          @click="dynamicAlbumCover = false"
          >恢复封面默认</Button
        >
      </template>
    </SkinSettingSection>
    <LyricTextStyleSettings :skin-key="HOST_SKIN_KEYS.cover" />
  </div>
</template>

<style scoped src="./skinSettings.css"></style>
