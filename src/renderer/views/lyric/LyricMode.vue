<script setup lang="ts">
import LyricScroller from './LyricScroller.vue';
</script>

<template>
  <div class="lyric-mode">
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
  align-self: center;
  text-align: center;
  flex-shrink: 0;
}

.lyric-area {
  flex: 1;
  min-height: 0;
}
</style>
