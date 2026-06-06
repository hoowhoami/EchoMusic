<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import type { Song } from '@/models/song';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader, {
  type SortField,
  type SortOrder,
} from '@/components/music/SongListHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { iconCurrentLocation, iconSearch, iconSparkles } from '@/icons';

const props = defineProps<{
  activeSongId?: string;
  currentSearchKeyword: string;
  currentSearchSubtitle: string;
  enableLocate?: boolean;
  enableSearchQuery?: boolean;
  queueIdPrefix: string;
  rowTitle: string;
  searchQuery?: string;
  showLyricColumn?: boolean;
  songs: Song[];
  sortField: SortField | null;
  sortOrder: SortOrder;
  sortedSongs: Song[];
  stickyTop: number;
  subtitleLabel?: string;
}>();

const emit = defineEmits<{
  locate: [];
  play: [];
  'song-search-change': [value: string];
  sort: [field: SortField];
}>();

const drawerOpen = ref(false);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);

const queueOptions = computed(() => ({
  queueId: `${props.queueIdPrefix}:${props.currentSearchKeyword.trim() || 'default'}`,
  title: props.rowTitle,
  subtitle: props.currentSearchSubtitle,
  type: 'search' as const,
  dynamic: false,
}));

const openBatchDrawer = () => {
  if (props.songs.length === 0) return;
  drawerOpen.value = true;
};

const scrollToActive = () => {
  songListRef.value?.scrollToActive?.();
};

defineExpose({ scrollToActive });
</script>

<template>
  <div>
    <div class="search-song-toolbar sticky z-120 bg-bg-main" :style="{ top: `${stickyTop}px` }">
      <div class="search-song-toolbar-inner">
        <div class="search-song-title-wrap">
          <div class="search-song-badge-icon">
            <Icon :icon="iconSparkles" width="16" height="16" />
          </div>
          <div class="text-[15px] font-semibold text-text-main leading-none">{{ rowTitle }}</div>
        </div>
        <div class="search-song-toolbar-actions">
          <div class="overflow-x-auto">
            <ActionRow @play="emit('play')" @batch="openBatchDrawer" />
          </div>
        </div>
      </div>
    </div>

    <BatchActionDrawer v-model:open="drawerOpen" :songs="songs" :source-id="queueIdPrefix" />

    <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${stickyTop + 52}px` }">
      <div v-if="enableSearchQuery" class="border-b border-[var(--border-subtle)]">
        <div class="flex items-center justify-between h-14">
          <div class="rank-song-tab">
            <span class="rank-song-label relative">歌曲 <Badge :count="subtitleLabel" /></span>
          </div>
          <div class="flex items-center gap-2">
            <div class="relative">
              <input
                :value="searchQuery"
                type="text"
                placeholder="搜索歌曲..."
                class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                @input="emit('song-search-change', ($event.target as HTMLInputElement).value)"
              />
              <Icon
                class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                :icon="iconSearch"
                width="14"
                height="14"
              />
            </div>
            <Button
              v-if="enableLocate"
              variant="unstyled"
              size="none"
              class="song-locate-btn p-2 rounded-lg"
              title="定位当前播放"
              @click="emit('locate')"
            >
              <Icon :icon="iconCurrentLocation" width="16" height="16" />
            </Button>
          </div>
        </div>
      </div>

      <SongListHeader
        :sortField="sortField"
        :sortOrder="sortOrder"
        :showCover="true"
        :lyricColumn="showLyricColumn"
        albumLabel="歌词"
        paddingClass="px-0"
        @sort="emit('sort', $event)"
      />
    </div>

    <div class="pb-12">
      <SongList
        ref="songListRef"
        class="search-song-list"
        :songs="songs"
        :contextSongs="sortedSongs"
        :searchQuery="searchQuery"
        :disableInternalFilter="Boolean(enableSearchQuery)"
        :activeId="activeSongId"
        :showCover="true"
        :showLyricColumn="showLyricColumn"
        :queueOptions="queueOptions"
        :enableDefaultDoubleTapPlay="true"
        rowPaddingClass="px-0"
      />
    </div>
  </div>
</template>

<style scoped src="../searchView.css"></style>
