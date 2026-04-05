<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useVirtualList } from '@vueuse/core';
import type { Song } from '@/models/song';
import { formatDuration } from '@/utils/format';
import SongCard from './SongCard.vue';
import { iconPlay, iconPause } from '@/icons';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { buildSongListGridTemplate } from './songListLayout';
import { isPlayableSong } from '@/utils/song';
import { queueAndPlaySong } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';

interface Props {
  songs: Song[];
  showIndex?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  showDuration?: boolean;
  rowPaddingClass?: string;
  activeId?: string | number;
  searchQuery?: string;
  parentPlaylistId?: string | number;
  enableRemoveFromPlaylist?: boolean;
  onSongDoubleTapPlay?: (song: Song) => void | Promise<void>;
  enableDefaultDoubleTapPlay?: boolean;
  itemKeyField?: 'id' | 'historyKey';
}

const props = withDefaults(defineProps<Props>(), {
  showIndex: true,
  showCover: true,
  showAlbum: true,
  showDuration: true,
  rowPaddingClass: '',
  searchQuery: '',
  parentPlaylistId: '',
  enableRemoveFromPlaylist: false,
  enableDefaultDoubleTapPlay: false,
  itemKeyField: 'id',
});

const emit = defineEmits<{
  (e: 'more', song: Song): void;
}>();

const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const router = useRouter();
const route = useRoute();

// 搜索过滤
const filteredSongs = computed(() => {
  if (!props.searchQuery.trim()) return props.songs;
  const q = props.searchQuery.toLowerCase();
  return props.songs.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.album?.toLowerCase().includes(q),
  );
});

const itemHeight = 60;
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(filteredSongs, {
  itemHeight,
});

const rowGridTemplate = computed(() => buildSongListGridTemplate({
  showIndex: props.showIndex,
  showAlbum: props.showAlbum,
  showDuration: props.showDuration,
}));

const originalIndexMap = computed(() => {
  const map = new Map<string | number, number>();
  props.songs.forEach((song, index) => {
    map.set(props.itemKeyField === 'historyKey' ? (song.historyKey ?? song.id) : song.id, index);
  });
  return map;
});

const isSongPlayable = (song: Song) => isPlayableSong(song);

const rowOpacity = (song: Song) => (isSongPlayable(song) ? 1 : 0.45);

const readString = (value: unknown, fallback = ''): string => {
  if (value === undefined || value === null) return fallback;
  return String(value);
};

const activeIdText = computed(() => readString(props.activeId));
const isActiveSong = (song: Song) => readString(song.id) === activeIdText.value;

const resolveNumericId = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
};

const isSameRoute = (name: string, targetId: string | number) => {
  const routeId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id;
  return route.name === name && String(routeId) === String(targetId);
};

const isAlbumClickable = (song: Song) => {
  const albumId = resolveNumericId(song.albumId);
  if (!albumId || !(song.album ?? '').trim()) return false;
  return !isSameRoute('album-detail', albumId);
};

const openAlbumDetail = (song: Song) => {
  const albumId = resolveNumericId(song.albumId);
  if (!albumId || !isAlbumClickable(song)) return;
  router.push({
    name: 'album-detail',
    params: { id: String(albumId) },
  });
};

const handleTogglePlay = async (song: Song) => {
  if (isActiveSong(song)) {
    playerStore.togglePlay();
    return;
  }

  const target = props.songs.find((item) => String(item.id) === String(song.id)) ?? song;
  await queueAndPlaySong(playlistStore, playerStore, target);
};

const getScrollContainer = (): HTMLElement | null =>
  document.querySelector('.view-port') as HTMLElement | null;

const getStickyOffset = (scrollContainer: HTMLElement): number => {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  const stickyNodes = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>('.sliver-header-root, .song-list-sticky'),
  );
  if (stickyNodes.length === 0) return 0;
  const bottoms = stickyNodes
    .map((node) => node.getBoundingClientRect().bottom - containerTop)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (bottoms.length === 0) return 0;
  return Math.max(...bottoms);
};

const adjustActiveIntoView = (smooth = false) => {
  const scrollContainer = getScrollContainer();
  if (!scrollContainer || !activeIdText.value) return;
  const row = scrollContainer.querySelector<HTMLElement>(
    `[data-song-row][data-song-id="${activeIdText.value}"]`,
  );
  if (!row) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const stickyOffset = getStickyOffset(scrollContainer);
  const topLimit = containerRect.top + stickyOffset + 8;
  const bottomLimit = containerRect.bottom - 12;
  if (rowRect.top < topLimit) {
    const target = scrollContainer.scrollTop - (topLimit - rowRect.top);
    scrollContainer.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  if (rowRect.bottom > bottomLimit) {
    const target = scrollContainer.scrollTop + (rowRect.bottom - bottomLimit);
    scrollContainer.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  }
};

const isActiveVisible = (): boolean => {
  const scrollContainer = getScrollContainer();
  if (!scrollContainer || !activeIdText.value) return false;
  const row = scrollContainer.querySelector<HTMLElement>(
    `[data-song-row][data-song-id="${activeIdText.value}"]`,
  );
  if (!row) return false;
  const containerRect = scrollContainer.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const stickyOffset = getStickyOffset(scrollContainer);
  const topLimit = containerRect.top + stickyOffset + 8;
  const bottomLimit = containerRect.bottom - 12;
  return rowRect.top >= topLimit && rowRect.bottom <= bottomLimit;
};

const scrollToActive = async () => {
  if (!activeIdText.value) return;
  if (isActiveVisible()) return;
  const index = filteredSongs.value.findIndex((s) => readString(s.id) === activeIdText.value);
  if (index === -1) return;
  scrollTo(index);
  await nextTick();
  const scrollContainer = getScrollContainer();
  const scrollerEl = containerProps.ref.value;
  if (scrollContainer && scrollerEl) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const scrollerRect = scrollerEl.getBoundingClientRect();
    const scrollerOffset = scrollerRect.top - containerRect.top;
    const stickyOffset = getStickyOffset(scrollContainer);
    const targetTop =
      index * itemHeight + scrollContainer.scrollTop + scrollerOffset - stickyOffset - 8;
    scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    requestAnimationFrame(() => adjustActiveIntoView(true));
    return;
  }
  requestAnimationFrame(() => adjustActiveIntoView(true));
};

defineExpose({ scrollToActive, filteredCount: computed(() => filteredSongs.value.length) });
</script>

<template>
  <div v-bind="containerProps" class="song-list-container scroll-smooth">
    <div v-bind="wrapperProps" class="song-list-inner">
      <div
        v-for="entry in list"
        :key="props.itemKeyField === 'historyKey' ? (entry.data.historyKey ?? entry.data.id) : entry.data.id"
        class="song-list-row group rounded-lg transition-all duration-200 cursor-default"
        :style="{ height: `${itemHeight}px`, opacity: rowOpacity(entry.data) }"
        :class="{ 'is-active': isActiveSong(entry.data) }"
        :data-song-row="true"
        :data-song-id="readString(entry.data.id)"
      >
        <div
          class="song-list-row-inner grid items-center w-full h-full"
          :class="props.rowPaddingClass"
          :style="{ gridTemplateColumns: rowGridTemplate }"
        >
          <div v-if="showIndex" class="flex items-center justify-start pl-2">
            <div class="relative w-4 h-4">
              <template v-if="isActiveSong(entry.data)">
                <div
                  v-if="playerStore.isPlaying"
                  class="absolute inset-0 flex items-center justify-center text-primary cursor-pointer"
                  @click.stop="handleTogglePlay(entry.data)"
                >
                  <Icon :icon="iconPause" width="14" height="14" />
                </div>
                <div
                  v-else
                  class="absolute inset-0 flex items-center justify-center text-primary cursor-pointer"
                  @click.stop="handleTogglePlay(entry.data)"
                >
                  <Icon :icon="iconPlay" width="14" height="14" />
                </div>
              </template>
              <template v-else>
                <span
                  class="absolute inset-0 flex items-center justify-center text-[12px] opacity-60 transition-opacity group-hover:opacity-0"
                >
                  {{ (originalIndexMap.get(props.itemKeyField === 'historyKey' ? (entry.data.historyKey ?? entry.data.id) : entry.data.id) ?? 0) + 1 }}
                </span>
                <Icon
                  class="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 text-text-main cursor-pointer"
                  :icon="iconPlay"
                  width="14"
                  height="14"
                  @click.stop="handleTogglePlay(entry.data)"
                />
              </template>
            </div>
          </div>

          <div class="min-w-0">
            <SongCard
              :id="entry.data.id"
              :hash="entry.data.hash"
              :title="entry.data.title"
              :artist="entry.data.artist"
              :artists="entry.data.artists"
              :album="entry.data.album"
              :albumId="entry.data.albumId"
              :coverUrl="entry.data.coverUrl"
              :duration="entry.data.duration"
              :audioUrl="entry.data.audioUrl"
              :source="entry.data.source"
              :mixSongId="entry.data.mixSongId"
              :fileId="entry.data.fileId"
              :privilege="entry.data.privilege"
              :payType="entry.data.payType"
              :oldCpy="entry.data.oldCpy"
              :relateGoods="entry.data.relateGoods"
              :parentPlaylistId="props.parentPlaylistId"
              :enableRemoveFromPlaylist="props.enableRemoveFromPlaylist"
              :showCover="showCover"
              :showAlbum="false"
              :showDuration="false"
              :showMore="true"
              :active="isActiveSong(entry.data)"
              :queueContext="props.songs"
              :onDoubleTapPlay="props.onSongDoubleTapPlay"
              :enableDefaultDoubleTapPlay="props.enableDefaultDoubleTapPlay"
              variant="list"
            />
          </div>

          <Button variant="unstyled" size="none"
            v-if="showAlbum"
            type="button"
            class="min-w-0 hidden md:block pr-3 text-[13px] text-left text-text-main/70 truncate"
            :class="isAlbumClickable(entry.data) ? 'song-list-meta-link' : ''"
            :disabled="!isAlbumClickable(entry.data)"
            @click.stop="openAlbumDetail(entry.data)"
          >
            {{ entry.data.album || '未知专辑' }}
          </Button>

          <div v-if="showDuration" class="pl-2 text-[12px] opacity-60 text-left whitespace-nowrap">
            {{ formatDuration(entry.data.duration) }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="filteredSongs?.length === 0" class="py-20 text-center opacity-50 text-[14px] italic">
      {{ props.searchQuery ? '未找到相关歌曲' : '暂无歌曲' }}
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.song-list-container {
  user-select: none;
  width: 100%;
}

.song-list-row {
  width: 100%;
}

.song-list-row-inner {
  box-sizing: border-box;
}

.song-list-row:hover {
  background: var(--color-bg-card);
}

.dark .song-list-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.song-list-row.is-active {
  background: var(--color-bg-card);
}

.dark .song-list-row.is-active {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}
.song-list-meta-link {
  cursor: pointer;
}

.song-list-meta-link:hover {
  color: var(--color-primary);
}
</style>

<style scoped>
@reference "@/style.css";

.song-list-container {
  user-select: none;
  width: 100%;
}

.song-list-row {
  width: 100%;
}

.song-list-row-inner {
  box-sizing: border-box;
}

.song-list-row:hover {
  background: var(--color-bg-card);
}

.dark .song-list-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.song-list-row.is-active {
  background: var(--color-bg-card);
}

.dark .song-list-row.is-active {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}
.song-list-meta-link {
  cursor: pointer;
}

.song-list-meta-link:hover {
  color: var(--color-primary);
}
</style>
