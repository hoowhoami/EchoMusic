<script setup lang="ts">
import { iconChevronUpDown, iconSortDown, iconSortUp } from '@/icons';
import { computed } from 'vue';
import {
  buildSongListGridTemplate,
  SONG_LIST_TITLE_OFFSET_WITH_COVER,
} from './songListLayout';

export type SortField = 'index' | 'title' | 'album' | 'duration';
export type SortOrder = 'asc' | 'desc' | null;

interface Props {
  showIndex?: boolean;
  showAlbum?: boolean;
  showCover?: boolean;
  sortField?: SortField | null;
  sortOrder?: SortOrder;
  paddingClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  showIndex: true,
  showAlbum: true,
  showCover: true,
  sortField: null,
  sortOrder: null,
  paddingClass: '',
});

const emit = defineEmits<{
  (e: 'sort', field: SortField): void;
}>();

const handleSort = (field: SortField) => {
  emit('sort', field);
};

const gridTemplate = computed(() => buildSongListGridTemplate({
  showIndex: props.showIndex,
  showAlbum: props.showAlbum,
  showDuration: true,
}));
</script>

<template>
  <div
    class="grid items-center h-11 text-[12px] text-text-main/80 font-bold border-b border-border-light/30"
    :class="props.paddingClass"
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
        :icon="sortOrder === 'asc' ? iconSortUp : sortOrder === 'desc' ? iconSortDown : iconChevronUpDown"
      />
      <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
    </div>

    <div
      class="min-w-0 cursor-pointer hover:opacity-100 transition-opacity flex items-center"
      @click="handleSort('title')"
    >
      <div v-if="props.showCover" class="shrink-0" :style="{ width: `${SONG_LIST_TITLE_OFFSET_WITH_COVER}px` }"></div>
      <div class="min-w-0 flex items-center gap-1">
        <span>歌曲</span>
        <Icon
          v-if="sortField === 'title'"
          class="sort-icon"
          :icon="sortOrder === 'asc' ? iconSortUp : sortOrder === 'desc' ? iconSortDown : iconChevronUpDown"
        />
        <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
      </div>
    </div>

    <div
      v-if="showAlbum"
      class="min-w-0 hidden md:flex pr-3 cursor-pointer hover:opacity-100 transition-opacity items-center gap-1 whitespace-nowrap"
      @click="handleSort('album')"
    >
      <span>专辑</span>
      <Icon
        v-if="sortField === 'album'"
        class="sort-icon"
        :icon="sortOrder === 'asc' ? iconSortUp : sortOrder === 'desc' ? iconSortDown : iconChevronUpDown"
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
        :icon="sortOrder === 'asc' ? iconSortUp : sortOrder === 'desc' ? iconSortDown : iconChevronUpDown"
      />
      <Icon v-else class="sort-icon" :icon="iconChevronUpDown" />
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.sort-icon {
  width: 14px;
  height: 14px;
}
</style>
