<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import SongListSkeletonRows from '@/components/music/SongListSkeletonRows.vue';

interface Props {
  mode?: 'song' | 'grid' | 'video';
  rowCount?: number;
  cardCount?: number;
  showIndex?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  showDuration?: boolean;
  lyricColumn?: boolean;
  rowPaddingClass?: string;
}

withDefaults(defineProps<Props>(), {
  mode: 'song',
  rowCount: 10,
  cardCount: 8,
  showIndex: true,
  showCover: true,
  showAlbum: true,
  showDuration: true,
  lyricColumn: false,
  rowPaddingClass: '',
});
</script>

<template>
  <div class="search-results-skeleton" aria-busy="true">
    <template v-if="mode === 'song'">
      <div class="search-results-skeleton-toolbar">
        <div class="search-results-skeleton-title">
          <Skeleton variant="circle" width="32px" height="32px" />
          <Skeleton variant="text" width="92px" height="15px" />
        </div>
        <div class="search-results-skeleton-actions">
          <Skeleton variant="text" width="88px" height="34px" />
          <Skeleton variant="text" width="76px" height="34px" />
        </div>
      </div>

      <div class="search-results-skeleton-subbar">
        <Skeleton variant="text" width="96px" height="13px" />
        <Skeleton variant="text" width="164px" height="36px" />
      </div>

      <SongListSkeletonRows
        :row-count="rowCount"
        :show-index="showIndex"
        :show-cover="showCover"
        :show-album="showAlbum"
        :show-duration="showDuration"
        :lyric-column="lyricColumn"
        :row-padding-class="rowPaddingClass"
      />
    </template>

    <div v-else class="search-results-skeleton-grid">
      <div
        v-for="card in cardCount"
        :key="card"
        class="search-results-skeleton-card"
        :class="{ 'is-video': mode === 'video' }"
      >
        <div class="search-results-skeleton-cover" :class="{ 'is-video': mode === 'video' }">
          <Skeleton width="100%" height="100%" :radius="mode === 'video' ? 8 : 14" />
        </div>
        <div class="search-results-skeleton-card-text">
          <Skeleton variant="text" width="82%" height="13px" />
          <Skeleton variant="text" width="54%" height="11px" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-results-skeleton {
  width: 100%;
  padding: 0 40px 48px;
  contain: layout style;
}

.search-results-skeleton-toolbar {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0 6px;
}

.search-results-skeleton-title,
.search-results-skeleton-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-results-skeleton-subbar {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.search-results-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 20px;
  padding-top: 4px;
}

.search-results-skeleton-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-card);
}

.search-results-skeleton-card.is-video {
  border-radius: 16px;
}

.search-results-skeleton-cover {
  aspect-ratio: 1;
}

.search-results-skeleton-cover.is-video {
  aspect-ratio: 1.78;
}

.search-results-skeleton-card-text {
  display: flex;
  min-height: 36px;
  flex-direction: column;
  gap: 7px;
  justify-content: center;
  margin-top: 8px;
  padding: 0 2px;
}

@media (max-width: 767px) {
  .search-results-skeleton {
    padding-left: 24px;
    padding-right: 24px;
  }
}
</style>
