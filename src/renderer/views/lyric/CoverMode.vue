<script setup lang="ts">
import { usePlayerControls } from '@/composables/usePlayerControls';
import Cover from '@/components/ui/Cover.vue';
import LyricScroller from './LyricScroller.vue';

const { currentTrack } = usePlayerControls();
</script>

<template>
  <div class="cover-mode">
    <!-- 左侧：封面 + 歌曲信息 -->
    <section class="cover-side">
      <div class="cover-wrapper">
        <Cover :url="currentTrack?.coverUrl" :size="800" :borderRadius="24" class="cover-img" />
      </div>
      <div class="song-info">
        <h1 class="song-title">{{ currentTrack?.name || '未在播放' }}</h1>
        <p class="song-artist">{{ currentTrack?.artist || '' }}</p>
      </div>
    </section>

    <!-- 右侧：歌词 -->
    <section class="lyric-side">
      <LyricScroller />
    </section>
  </div>
</template>

<style scoped>
.cover-mode {
  display: flex;
  gap: 32px;
  height: 100%;
  padding: 0 32px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
}

.cover-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: clamp(280px, 35%, 420px);
  padding: 24px 0;
}

.cover-wrapper {
  width: clamp(220px, 80%, 380px);
  aspect-ratio: 1;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
}

.cover-img {
  width: 100%;
  height: 100%;
}

.song-info {
  margin-top: 24px;
  text-align: center;
  width: 100%;
  max-width: 380px;
  padding: 0 16px;
}

.song-title {
  font-size: 22px;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.lyric-side {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .cover-mode {
    flex-direction: column;
    gap: 16px;
  }

  .cover-side {
    width: 100%;
    flex: 0 0 auto;
    padding: 16px 0 0;
  }

  .cover-wrapper {
    width: 160px;
  }

  .lyric-side {
    flex: 1;
  }
}
</style>
