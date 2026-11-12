<script setup lang="ts">
/**
 * 听歌统计榜单区：歌手榜「偏爱的声音」+ Top 歌曲网格「你的私人重播册」。
 * 移植自 EchoMusicNext HistoryStatsRankings.qml（SongTile 内联组件）。
 */
import { computed, ref } from 'vue';
import Cover from '@/components/ui/Cover.vue';
import { iconPlay } from '@/icons';
import type { HistoryStats } from '../../../../shared/historyStats';
import HistoryStatsPanel from './HistoryStatsPanel.vue';
import { useContainerWidth } from './useContainerWidth';
import './statsShared.css';

const props = withDefaults(
  defineProps<{
    stats: HistoryStats;
    interactive?: boolean;
    animate?: boolean;
  }>(),
  { interactive: true, animate: true },
);

const emit = defineEmits<{ play: [id: string] }>();

const rootRef = ref<HTMLElement | null>(null);
const rootWidth = useContainerWidth(rootRef);
/** 双面板并排的最小宽度（对齐 Next stacked: 700） */
const stacked = computed(() => rootWidth.value < 700);

const galleryRef = ref<HTMLElement | null>(null);
const galleryWidth = useContainerWidth(galleryRef);
/** 歌曲网格列数：≥330 三列，否则两列（对齐 Next gallery） */
const galleryColumns = computed(() => (galleryWidth.value >= 330 ? 3 : 2));

const enterStyle = (order: number) =>
  props.animate ? { animationDelay: `${Math.min(order * 32, 96)}ms` } : undefined;

const artistIndex = (index: number) => String(index + 1).padStart(2, '0');
const songIndex = (index: number) => String(index + 1).padStart(2, '0');
const artistFirstLine = (artist: { songs: number; plays: number }) =>
  `${artist.songs} 首歌，陪你听了 ${artist.plays} 次`;
const songPlays = (song: { plays: number }) => `${song.plays} 次播放`;

const tilePlayable = (song: { id: string }) =>
  props.interactive && Boolean(song.id && song.id !== '0');

const handlePlay = (song: { id: string; title: string }) => {
  if (!tilePlayable(song)) return;
  emit('play', song.id);
};
</script>

<template>
  <div ref="rootRef" class="stats-rankings" :class="{ stacked }">
    <HistoryStatsPanel
      heading="偏爱的声音"
      description="从歌手的声音，读懂你的偏好"
      :animate="animate"
      :order="2"
      class="artist-panel"
    >
      <div
        v-for="(artist, index) in stats.topArtists"
        :key="artist.name"
        class="artist-row"
        :class="{ 'stats-enter': animate }"
        :style="enterStyle(2)"
      >
        <div class="artist-row-main">
          <span class="artist-index" :class="{ 'is-first': index === 0 }">
            {{ artistIndex(index) }}
          </span>
          <div class="artist-info">
            <div class="artist-name" :class="index === 0 ? 'is-first' : 'is-rest'">
              {{ artist.name }}
            </div>
            <div v-if="index === 0" class="artist-first-line">
              {{ artistFirstLine(artist) }}
            </div>
          </div>
          <span v-if="index !== 0" class="artist-count">{{ artist.plays }} 次</span>
        </div>
        <div class="artist-divider"></div>
      </div>
    </HistoryStatsPanel>

    <HistoryStatsPanel
      heading="你的私人重播册"
      description="那些一次次回到耳边的歌"
      :animate="animate"
      :order="3"
      class="songs-panel"
    >
      <div
        ref="galleryRef"
        class="song-gallery"
        :style="{ gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))` }"
      >
        <button
          v-for="(song, index) in stats.topSongs"
          :key="song.key"
          type="button"
          class="song-tile"
          :class="{ 'stats-enter': animate }"
          :style="enterStyle(3)"
          :disabled="!tilePlayable(song)"
          :aria-label="`播放 ${song.title || '未知歌曲'}`"
          @click="handlePlay(song)"
        >
          <div class="tile-cover">
            <Cover
              class="tile-cover-image"
              :url="song.cover"
              :size="300"
              width="100%"
              height="100%"
              border-radius="var(--radius-media)"
              :alt="song.title || '未知歌曲'"
            />
            <span class="tile-rank">{{ songIndex(index) }}</span>
            <span class="tile-hover-play">
              <Icon :icon="iconPlay" width="16" height="16" />
            </span>
          </div>
          <div class="tile-title">{{ song.title || '未知歌曲' }}</div>
          <div class="tile-artist">{{ song.artist || '未知歌手' }}</div>
          <div class="tile-plays">{{ songPlays(song) }}</div>
        </button>
      </div>
    </HistoryStatsPanel>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.stats-rankings {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.7fr);
  gap: 32px 40px;
  min-width: 0;
}

.stats-rankings.stacked {
  grid-template-columns: minmax(0, 1fr);
}

.artist-panel {
  align-self: start;
}

/* ── 歌手榜 ─────────────────────────────── */
.artist-row {
  min-width: 0;
}

.artist-row-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.artist-index {
  flex: 0 0 22px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

.artist-index.is-first {
  color: var(--color-primary-text);
}

.artist-info {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.artist-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.artist-name.is-first {
  color: var(--color-primary-text);
  font-size: 24px;
  font-weight: 700;
}

.artist-name.is-rest {
  color: var(--color-text-main);
  font-size: 15px;
  font-weight: 500;
}

.artist-first-line {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 400;
}

.artist-count {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
}

.artist-divider {
  height: 1px;
  margin-top: 10px;
  background: var(--border-subtle);
}

/* ── Top 歌曲 ───────────────────────────── */
.songs-panel {
  align-self: start;
}

.song-gallery {
  display: grid;
  gap: 20px 16px;
}

.song-tile {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding: 10px;
  border: none;
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--text-main) 3%, transparent);
  cursor: pointer;
  text-align: left;
  transition: background 120ms ease;
}

.song-tile:hover:not(:disabled),
.song-tile:focus-visible:not(:disabled) {
  background: color-mix(in srgb, var(--content-tone) 5%, transparent);
}

.song-tile:disabled {
  cursor: default;
}

.tile-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
}

.tile-cover-image {
  width: 100%;
  height: 100%;
}

.tile-rank {
  position: absolute;
  top: 6px;
  left: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 22px;
  padding: 0 6px;
  border-radius: 4px;
  background: #bb17191d;
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
}

.tile-hover-play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background: #bb17191d;
  color: #ffffff;
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity 120ms ease;
}

.song-tile:hover:not(:disabled) .tile-hover-play,
.song-tile:focus-visible:not(:disabled) .tile-hover-play {
  opacity: 1;
}

.tile-title {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-artist {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-plays {
  color: var(--color-primary-text);
  font-size: 10px;
  font-weight: 500;
}
</style>
