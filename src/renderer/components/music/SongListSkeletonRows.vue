<script setup lang="ts">
import { computed } from 'vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { buildSongListGridTemplate } from './songListLayout';

interface Props {
  rowCount?: number;
  showIndex?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  showDuration?: boolean;
  lyricColumn?: boolean;
  rowPaddingClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  rowCount: 8,
  showIndex: true,
  showCover: true,
  showAlbum: true,
  showDuration: true,
  lyricColumn: false,
  rowPaddingClass: '',
});

const rows = computed(() =>
  Array.from({ length: Math.max(1, props.rowCount) }, (_, index) => index),
);

const rowGridTemplate = computed(() =>
  buildSongListGridTemplate({
    showIndex: props.showIndex,
    showAlbum: props.showAlbum,
    showDuration: props.showDuration,
    lyricColumn: props.lyricColumn,
  }),
);
</script>

<template>
  <div class="song-list-skeleton" aria-busy="true">
    <div
      v-for="row in rows"
      :key="row"
      class="song-list-skeleton-row"
      :class="rowPaddingClass"
      :style="{ gridTemplateColumns: rowGridTemplate }"
    >
      <div v-if="showIndex" class="song-list-skeleton-index">
        <Skeleton variant="text" width="18px" height="12px" />
      </div>

      <div class="song-list-skeleton-main">
        <Skeleton
          v-if="showCover"
          width="40px"
          height="40px"
          :radius="8"
          class="song-list-skeleton-cover"
        />
        <div class="song-list-skeleton-title-group">
          <Skeleton variant="text" width="64%" height="13px" />
          <Skeleton variant="text" width="38%" height="11px" />
        </div>
      </div>

      <div v-if="showAlbum" class="song-list-skeleton-album">
        <Skeleton variant="text" width="72%" height="12px" />
      </div>

      <div v-if="showDuration" class="song-list-skeleton-duration">
        <Skeleton variant="text" width="34px" height="12px" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.song-list-skeleton {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 4px 0 16px;
  contain: layout style;
}

.song-list-skeleton-row {
  display: grid;
  align-items: center;
  width: 100%;
  min-height: 60px;
  border-radius: 10px;
  box-sizing: border-box;
}

.song-list-skeleton-index {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  opacity: 0.76;
}

.song-list-skeleton-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 12px;
}

.song-list-skeleton-cover {
  box-shadow: var(--shadow-cover);
}

.song-list-skeleton-title-group {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.song-list-skeleton-album {
  display: none;
  min-width: 0;
  padding-right: 12px;
}

.song-list-skeleton-duration {
  display: flex;
  justify-content: flex-start;
  min-width: 0;
  padding-left: 8px;
}

@media (min-width: 768px) {
  .song-list-skeleton-album {
    display: block;
  }
}
</style>
