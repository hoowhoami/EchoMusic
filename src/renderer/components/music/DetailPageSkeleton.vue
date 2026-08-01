<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import SongListSkeletonRows from './SongListSkeletonRows.vue';

type CoverVariant = 'square' | 'round' | 'none';

interface Props {
  typeLabel?: string;
  expandedHeight?: number;
  rowCount?: number;
  cover?: CoverVariant;
  showList?: boolean;
  showIndex?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  showDuration?: boolean;
  lyricColumn?: boolean;
  rowPaddingClass?: string;
}

withDefaults(defineProps<Props>(), {
  typeLabel: '',
  expandedHeight: 196,
  rowCount: 8,
  cover: 'square',
  showList: true,
  showIndex: true,
  showCover: true,
  showAlbum: true,
  showDuration: true,
  lyricColumn: false,
  rowPaddingClass: '',
});
</script>

<template>
  <div
    class="detail-page-skeleton"
    :style="{ '--detail-skeleton-expanded-height': `${expandedHeight}px` }"
    aria-busy="true"
  >
    <div class="detail-page-skeleton-header">
      <Skeleton
        v-if="cover !== 'none'"
        width="150px"
        height="150px"
        :radius="cover === 'round' ? '50%' : 16"
        class="detail-page-skeleton-cover"
      />

      <div class="detail-page-skeleton-info" :class="{ 'is-coverless': cover === 'none' }">
        <div class="detail-page-skeleton-title-row">
          <Skeleton variant="text" width="min(420px, 72%)" height="28px" />
          <div v-if="typeLabel" class="detail-page-skeleton-badge">{{ typeLabel }}</div>
        </div>

        <div class="detail-page-skeleton-meta">
          <div class="detail-page-skeleton-inline">
            <Skeleton variant="circle" width="20px" height="20px" />
            <Skeleton variant="text" width="118px" height="13px" />
            <Skeleton variant="text" width="86px" height="11px" />
          </div>
          <div class="detail-page-skeleton-inline">
            <Skeleton variant="text" width="72px" height="11px" />
            <Skeleton variant="text" width="96px" height="11px" />
            <Skeleton variant="text" width="62px" height="11px" />
          </div>
          <Skeleton variant="text" width="min(520px, 86%)" height="12px" />
        </div>

        <div class="detail-page-skeleton-actions">
          <Skeleton variant="text" width="96px" height="34px" />
          <Skeleton variant="text" width="82px" height="34px" />
          <Skeleton variant="circle" width="34px" height="34px" />
        </div>
      </div>
    </div>

    <div class="detail-page-skeleton-tabs">
      <Skeleton variant="text" width="92px" height="30px" />
      <Skeleton variant="text" width="76px" height="30px" />
    </div>

    <SongListSkeletonRows
      v-if="showList"
      :row-count="rowCount"
      :show-index="showIndex"
      :show-cover="showCover"
      :show-album="showAlbum"
      :show-duration="showDuration"
      :lyric-column="lyricColumn"
      :row-padding-class="rowPaddingClass"
    />
  </div>
</template>

<style scoped>
.detail-page-skeleton {
  min-height: 100%;
  padding: 10px 24px 48px;
  background: var(--color-bg-main);
  contain: layout style;
}

.detail-page-skeleton-header {
  display: flex;
  min-height: calc(var(--detail-skeleton-expanded-height) - 56px);
  align-items: flex-start;
  gap: 20px;
  padding-top: 10px;
}

.detail-page-skeleton-cover {
  box-shadow: var(--shadow-cover);
}

.detail-page-skeleton-info {
  display: flex;
  min-width: 0;
  min-height: 150px;
  flex: 1;
  flex-direction: column;
}

.detail-page-skeleton-info.is-coverless {
  min-height: 120px;
}

.detail-page-skeleton-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-page-skeleton-badge {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 0.5px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1.2px;
}

.detail-page-skeleton-meta {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 8px 0;
}

.detail-page-skeleton-inline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-page-skeleton-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-page-skeleton-tabs {
  display: flex;
  gap: 8px;
  padding: 18px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
}

@media (max-width: 767px) {
  .detail-page-skeleton {
    padding-left: 18px;
    padding-right: 18px;
  }

  .detail-page-skeleton-header {
    flex-direction: column;
    gap: 16px;
  }
}
</style>
