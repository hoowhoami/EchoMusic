<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';

import { iconChevronUpDown, iconSortDown, iconSortUp } from '@/icons';
import { computed } from 'vue';
import type { SongListSortField, SongListSortOrder } from '@/utils/songList';
import { buildSongListGridTemplate, SONG_LIST_TITLE_OFFSET_WITH_COVER } from './songListLayout';

export type SortField = SongListSortField;
export type SortOrder = SongListSortOrder;

interface Props {
  showIndex?: boolean;
  showAlbum?: boolean;
  showCover?: boolean;
  sortField?: SortField | null;
  sortOrder?: SortOrder;
  paddingClass?: string;
  albumLabel?: string;
  lyricColumn?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showIndex: true,
  showAlbum: true,
  showCover: true,
  sortField: null,
  sortOrder: null,
  paddingClass: '',
  albumLabel: '专辑',
  lyricColumn: false,
});

const emit = defineEmits<{
  (e: 'sort', field: SortField): void;
}>();

const handleSort = (field: SortField) => {
  emit('sort', field);
};

const gridTemplate = computed(() =>
  buildSongListGridTemplate({
    showIndex: props.showIndex,
    showAlbum: props.showAlbum,
    showDuration: true,
    lyricColumn: props.lyricColumn,
  }),
);
</script>

<template>
  <div :class="props.paddingClass">
    <div
      class="grid items-center h-11 text-[12px] text-text-main/80 font-bold border-b border-[var(--border-subtle)]"
      :style="{ gridTemplateColumns: gridTemplate }"
    >
      <div
        v-if="showIndex"
        class="pl-2 cursor-pointer hover:opacity-100 transition-opacity flex items-center gap-1"
        @click="handleSort('index')"
      >
        <span>#</span>
        <Icon
          v-if="sortField === 'index'"
          class="sort-icon"
          :icon="
            sortOrder === 'asc'
              ? iconSortUp
              : sortOrder === 'desc'
                ? iconSortDown
                : iconChevronUpDown
          "
        />
        <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
      </div>

      <div class="min-w-0 flex items-center">
        <div
          v-if="props.showCover"
          class="shrink-0"
          :style="{ width: `${SONG_LIST_TITLE_OFFSET_WITH_COVER}px` }"
        ></div>
        <div class="min-w-0 flex items-center gap-1.5">
          <Tooltip content="按歌曲名排序">
            <template #trigger>
              <button
                type="button"
                class="song-sort-choice"
                :class="{ 'is-active': sortField === 'title' }"
                :aria-pressed="sortField === 'title'"
                aria-label="按歌曲名排序"
                @click="handleSort('title')"
              >
                <span>歌曲</span>
                <Icon
                  v-if="sortField === 'title'"
                  class="sort-icon"
                  :icon="sortOrder === 'desc' ? iconSortDown : iconSortUp"
                />
                <Icon v-else class="sort-icon sort-icon-idle" :icon="iconChevronUpDown" />
              </button>
            </template>
          </Tooltip>
          <span class="song-sort-separator" aria-hidden="true">/</span>
          <Tooltip content="按歌手排序">
            <template #trigger>
              <button
                type="button"
                class="song-sort-choice"
                :class="{ 'is-active': sortField === 'artist' }"
                :aria-pressed="sortField === 'artist'"
                aria-label="按歌手排序"
                @click="handleSort('artist')"
              >
                <span>歌手</span>
                <Icon
                  v-if="sortField === 'artist'"
                  class="sort-icon"
                  :icon="sortOrder === 'desc' ? iconSortDown : iconSortUp"
                />
                <Icon v-else class="sort-icon sort-icon-idle" :icon="iconChevronUpDown" />
              </button>
            </template>
          </Tooltip>
        </div>
      </div>

      <div
        v-if="showAlbum"
        class="min-w-0 hidden md:flex pr-3 cursor-pointer hover:opacity-100 transition-opacity items-center gap-1 whitespace-nowrap"
        @click="handleSort('album')"
      >
        <span>{{ albumLabel }}</span>
        <Icon
          v-if="sortField === 'album'"
          class="sort-icon"
          :icon="
            sortOrder === 'asc'
              ? iconSortUp
              : sortOrder === 'desc'
                ? iconSortDown
                : iconChevronUpDown
          "
        />
        <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
      </div>

      <div
        class="pl-2 cursor-pointer hover:opacity-100 transition-opacity flex items-center justify-start gap-1 whitespace-nowrap"
        @click="handleSort('duration')"
      >
        <span>时长</span>
        <Icon
          v-if="sortField === 'duration'"
          class="sort-icon"
          :icon="
            sortOrder === 'asc'
              ? iconSortUp
              : sortOrder === 'desc'
                ? iconSortDown
                : iconChevronUpDown
          "
        />
        <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.sort-icon {
  width: 14px;
  height: 14px;
}

.song-sort-choice {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  padding: 4px 0;
  color: inherit;
  cursor: pointer;
  transition: color 0.15s ease;
}

.song-sort-choice:hover,
.song-sort-choice.is-active {
  color: var(--color-primary-text);
}

.sort-icon-idle {
  opacity: 0.58;
}

.song-sort-choice:hover .sort-icon-idle {
  opacity: 1;
}

.song-sort-separator {
  color: color-mix(in srgb, var(--color-text-main) 28%, transparent);
  font-weight: 500;
}
</style>
