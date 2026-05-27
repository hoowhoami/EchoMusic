<script setup lang="ts">
import { computed } from 'vue';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useLyricStore } from '@/stores/lyric';
import LyricScroller from './LyricScroller.vue';

const { currentTrack } = usePlayerControls();
const lyricStore = useLyricStore();
</script>

<template>
  <div class="lyric-mode">
    <!-- 顶部歌曲信息 -->
    <div class="song-header">
      <h1 class="song-title">{{ currentTrack?.title || '未在播放' }}</h1>
      <p class="song-artist">{{ currentTrack?.artist || '' }}</p>
      <p v-if="lyricStore.lyricSyncWarning" class="sync-warning">
        播放时长与原曲存在差异，歌词可能不同步
      </p>
    </div>

    <!-- 全屏歌词 -->
    <div class="lyric-area">
      <LyricScroller />
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

.song-header {
  text-align: center;
  padding: 16px 0 8px;
  flex-shrink: 0;
}

.song-title {
  font-size: 24px;
  font-weight: 700;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-artist {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
}

.sync-warning {
  margin-top: 8px;
  font-size: 11px;
  color: rgba(255, 200, 50, 0.85);
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(255, 200, 50, 0.1);
  display: inline-block;
}

.lyric-area {
  flex: 1;
  min-height: 0;
}
</style>
