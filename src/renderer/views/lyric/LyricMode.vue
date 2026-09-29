<script setup lang="ts">
import { useLyricStore } from '@/stores/lyric';
import LyricScroller from './LyricScroller.vue';
import { useLyricSkin } from './composables/useLyricSkin';
import { HOST_SKIN_KEYS, LYRIC_SKIN_LYRIC_DEFAULTS, resolveLyricSkinColor } from './skins/config';

const lyricStore = useLyricStore();
const { settings } = useLyricSkin(HOST_SKIN_KEYS.lyric, LYRIC_SKIN_LYRIC_DEFAULTS);
</script>

<template>
  <div class="lyric-mode">
    <!-- 全屏歌词 -->
    <div class="lyric-area">
      <LyricScroller
        :font-scale="settings.fontScale"
        :font-weight-index="settings.fontWeightIndex"
        :played-color="resolveLyricSkinColor(settings.playedColor, lyricStore.effectivePlayedColor)"
        :unplayed-color="
          resolveLyricSkinColor(settings.unplayedColor, lyricStore.effectiveUnplayedColor)
        "
      />
    </div>
  </div>
</template>

<style scoped>
.lyric-mode {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
  padding: 0 32px;
}

.lyric-area {
  flex: 1;
  min-height: 0;
}
</style>
