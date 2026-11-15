<script setup lang="ts">
import { computed } from 'vue';
import { useLyricStore } from '@/stores/lyric';
import LyricScroller from './LyricScroller.vue';
import { useLyricSkin } from './composables/useLyricSkin';
import { HOST_SKIN_KEYS, LYRIC_SKIN_LYRIC_DEFAULTS, resolveLyricSkinColor } from './skins/config';
import { resolvePlayedColor, resolveUnplayedColor } from './skins/colorOverride';

const lyricStore = useLyricStore();
const { settings } = useLyricSkin(HOST_SKIN_KEYS.lyric, LYRIC_SKIN_LYRIC_DEFAULTS);

const props = defineProps<{
  /** 动态壁纸配色自带的歌词颜色；空值表示跟随皮肤设置。 */
  colorOverride?: string;
}>();

// 壁纸配色命中时覆盖已播/未播字色，未播字用同色半透明保留层次。
const playedColor = computed(() =>
  resolvePlayedColor(
    props.colorOverride,
    resolveLyricSkinColor(settings.value.playedColor, lyricStore.effectivePlayedColor),
  ),
);
const unplayedColor = computed(() =>
  resolveUnplayedColor(
    props.colorOverride,
    resolveLyricSkinColor(settings.value.unplayedColor, lyricStore.effectiveUnplayedColor),
  ),
);
</script>

<template>
  <div class="lyric-mode">
    <!-- 全屏歌词 -->
    <div class="lyric-area">
      <LyricScroller
        :font-scale="settings.fontScale"
        :font-weight-index="settings.fontWeightIndex"
        :played-color="playedColor"
        :unplayed-color="unplayedColor"
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
