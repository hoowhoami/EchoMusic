<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { extractAlbumGroups, extractList } from '@/utils/extractors';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { getNewSongs } from '@/api/music';
import Button from '@/components/ui/Button.vue';
import {
  getPlaylistByCategory,
  getPlaylistTags,
  getRanks,
  getRankTop,
  getRankSongs,
} from '@/api/playlist';
import {
  mapPlaylistMeta,
  mapTopSong,
  mapAlbumMeta,
  mapRankMeta,
  mapRankSong,
} from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { AlbumMeta } from '@/models/album';
import type { RankMeta } from '@/models/rank';
import type { Song } from '@/models/song';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import CustomSelector from '@/components/ui/CustomSelector.vue';
import CustomPicker, { type PickerOption } from '@/components/ui/CustomPicker.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import { getAlbumTop } from '@/api/music';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconCurrentLocation, iconSearch, iconSparkles } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useToastStore } from '@/stores/toast';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const recommendedPlaylists = ref<PlaylistMeta[]>([]);
const newSongs = ref<Song[]>([]);
const loadingPlaylists = ref(true);
const loadingNewSongs = ref(true);
const activeTabIndex = ref(0);
const showPlaylistPicker = ref(false);
const showRankPicker = ref(false);
const showAlbumPicker = ref(false);

const playlistCategories = ref<PickerOption[]>([]);
const playlistCategoryLabel = ref('全部');
const playlistCategoryId = ref('0');

const ranks = ref<RankMeta[]>([]);
const rankLabel = ref('排行榜');
const rankId = ref<number | null>(null);
const rankSongs = ref<Song[]>([]);
const loadingRankSongs = ref(true);
const rankSearchQuery = ref('');
const rankSongListRef = ref<{ scrollToActive?: () => void } | null>(null);
const showRankBatchDrawer = ref(false);

const rankSortField = ref<SortField | null>(null);
const rankSortOrder = ref<SortOrder>(null);

const albumTypes = ref<PickerOption[]>([
  { id: 'all', name: '全部' },
  { id: 'chn', name: '华语' },
  { id: 'eur', name: '欧美' },
  { id: 'jpn', name: '日本' },
  { id: 'kor', name: '韩国' },
]);
const albumTypeId = ref('all');
const albumTypeLabel = ref('全部');
const albumPayload = ref<Record<string, unknown>>({});
const albumFallbackList = ref<unknown[]>([]);
const loadingAlbums = ref(true);
const exploreHeaderHeight = 102;
const rankToolbarOffset = exploreHeaderHeight + 46;
const newSongToolbarOffset = exploreHeaderHeight + 46;

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
const sortedRankSongs = computed(() => {
  const base = rankSongs.value.slice();
  if (!rankSortField.value || !rankSortOrder.value) return base;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  const indexMap = new Map<string, number>();
  rankSongs.value.forEach((song, index) => {
    indexMap.set(song.id, index);
  });
  const direction = rankSortOrder.value === 'asc' ? 1 : -1;

  return base.sort((a, b) => {
    switch (rankSortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.album ?? '', b.album ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)) * direction;
      default:
        return 0;
    }
  });
});

const newSongSearchQuery = ref('');
const newSongListRef = ref<{ scrollToActive?: () => void } | null>(null);
const newSongSortField = ref<SortField | null>(null);
const newSongSortOrder = ref<SortOrder>(null);
const showNewSongBatchDrawer = ref(false);
const sortedNewSongs = computed(() => {
  const base = newSongs.value.slice();
  if (!newSongSortField.value || !newSongSortOrder.value) return base;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  const indexMap = new Map<string, number>();
  newSongs.value.forEach((song, index) => {
    indexMap.set(song.id, index);
  });
  const direction = newSongSortOrder.value === 'asc' ? 1 : -1;

  return base.sort((a, b) => {
    switch (newSongSortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.album ?? '', b.album ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)) * direction;
      default:
        return 0;
    }
  });
});

const albums = computed<AlbumMeta[]>(() => {
  const map = albumPayload.value;
  const readList = (value: unknown) => (Array.isArray(value) ? value : []);
  const typeKeys = ['chn', 'eur', 'jpn', 'kor'];
  let rawList: unknown[] = [];
  if (albumTypeId.value === 'all') {
    rawList = typeKeys.flatMap((key) => readList(map[key]));
    if (rawList.length === 0) rawList = albumFallbackList.value;
  } else {
    rawList = readList(map[albumTypeId.value]);
    if (rawList.length === 0) rawList = albumFallbackList.value;
  }
  return rawList.map((item) => mapAlbumMeta(item));
});

const hasAlbums = computed(() => albums.value.length > 0);

const rankFilteredCount = computed(() => {
  const query = rankSearchQuery.value.trim().toLowerCase();
  if (!query) return sortedRankSongs.value.length;
  return sortedRankSongs.value.filter((song) => {
    return (
      song.title.toLowerCase().includes(query) ||
      song.artist.toLowerCase().includes(query) ||
      song.album?.toLowerCase().includes(query)
    );
  }).length;
});

const rankSongCountLabel = computed(() => {
  const total = rankSongs.value.length;
  if (!rankSearchQuery.value.trim()) return `${total}`;
  return `${rankFilteredCount.value} / ${total}`;
});

const newSongFilteredCount = computed(() => {
  const query = newSongSearchQuery.value.trim().toLowerCase();
  if (!query) return sortedNewSongs.value.length;
  return sortedNewSongs.value.filter((song) => {
    return (
      song.title.toLowerCase().includes(query) ||
      song.artist.toLowerCase().includes(query) ||
      song.album?.toLowerCase().includes(query)
    );
  }).length;
});

const newSongCountLabel = computed(() => {
  const total = newSongs.value.length;
  if (!newSongSearchQuery.value.trim()) return `${total}`;
  return `${newSongFilteredCount.value} / ${total}`;
});

// shared extractors moved to utils/extractors.ts

const loadPlaylistCategories = async () => {
  try {
    const res = await getPlaylistTags();
    const list = extractList(res).filter(
      (item) => typeof item === 'object' && item !== null,
    ) as Record<string, unknown>[];
    const options: PickerOption[] = [];
    list.forEach((cat) => {
      const groupName = String(cat.tag_name ?? cat.name ?? '');
      const sons = (cat.son as Record<string, unknown>[] | undefined) ?? [];
      if (sons.length === 0) return;
      sons.forEach((son) => {
        options.push({
          id: String(son.tag_id ?? son.id ?? ''),
          name: String(son.tag_name ?? son.name ?? ''),
          group: groupName,
        });
      });
    });
    playlistCategories.value = options;
    if (options.length > 0 && playlistCategoryId.value === '0') {
      const first = options[0];
      playlistCategoryId.value = first.id;
      playlistCategoryLabel.value = first.group ? `${first.group} - ${first.name}` : first.name;
    }
  } catch {
    playlistCategories.value = [];
    toastStore.loadFailed('歌单分类');
  }
};

const loadRecommendedPlaylists = async () => {
  loadingPlaylists.value = true;
  try {
    const res = await getPlaylistByCategory(playlistCategoryId.value || '0', 0, 1);
    const list = extractList(res).map((item) => mapPlaylistMeta(item));
    recommendedPlaylists.value = list;
  } catch {
    recommendedPlaylists.value = [];
  } finally {
    loadingPlaylists.value = false;
  }
};

const loadNewSongs = async () => {
  loadingNewSongs.value = true;
  try {
    const res = await getNewSongs();
    const list = extractList(res);
    newSongs.value = list.map((item) => mapTopSong(item));
  } catch {
    newSongs.value = [];
  } finally {
    loadingNewSongs.value = false;
  }
};

const loadRanks = async () => {
  try {
    const res = await getRanks();
    const list = extractList(res).map((item) => mapRankMeta(item));
    ranks.value = list;
    if (list.length > 0) {
      rankId.value = list[0].id;
      rankLabel.value = list[0].name;
      await loadRankSongs(list[0].id);
    }
  } catch {
    try {
      const fallback = await getRankTop();
      const list = extractList(fallback).map((item) => mapRankMeta(item));
      ranks.value = list;
      if (list.length > 0) {
        rankId.value = list[0].id;
        rankLabel.value = list[0].name;
        await loadRankSongs(list[0].id);
      }
    } catch {
      ranks.value = [];
    }
  }
};

const loadRankSongs = async (targetId: number) => {
  loadingRankSongs.value = true;
  try {
    const res = await getRankSongs(targetId, 1, 100);
    const list = extractList(res).map((item) => mapRankSong(item));
    rankSongs.value = list;
    rankSortField.value = null;
    rankSortOrder.value = null;
    rankSearchQuery.value = '';
  } catch {
    rankSongs.value = [];
  } finally {
    loadingRankSongs.value = false;
  }
};

const loadAlbums = async () => {
  loadingAlbums.value = true;
  try {
    const res = await getAlbumTop();
    albumPayload.value = extractAlbumGroups(res);
    albumFallbackList.value = extractList(res);
  } catch {
    albumPayload.value = {};
    albumFallbackList.value = [];
  } finally {
    loadingAlbums.value = false;
  }
};

const playRankSongs = async () => {
  if (rankSongs.value.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, rankSongs.value, 0, undefined, {
    queueId: `queue:explore:rank:${rankId.value ?? 'default'}`,
    title: rankLabel.value || '排行榜',
    subtitle: '榜单歌曲',
    type: 'ranking',
  });
};

const handleRankSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, rankSongs.value, 0, song, {
    queueId: `queue:explore:rank:${rankId.value ?? 'default'}`,
    title: rankLabel.value || '排行榜',
    subtitle: '榜单歌曲',
    type: 'ranking',
  });
};

const openRankBatchDrawer = () => {
  if (rankSongs.value.length === 0) return;
  showRankBatchDrawer.value = true;
};

const playNewSongs = async () => {
  if (newSongs.value.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, newSongs.value, 0, undefined, {
    queueId: 'queue:explore:new-songs',
    title: '新歌速递',
    subtitle: '发现新鲜声音',
    type: 'ranking',
  });
};

const handleNewSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, newSongs.value, 0, song, {
    queueId: 'queue:explore:new-songs',
    title: '新歌速递',
    subtitle: '发现新鲜声音',
    type: 'ranking',
  });
};

const openNewSongBatchDrawer = () => {
  if (newSongs.value.length === 0) return;
  showNewSongBatchDrawer.value = true;
};

const handleRankLocate = () => rankSongListRef.value?.scrollToActive?.();

const handleNewSongLocate = () => newSongListRef.value?.scrollToActive?.();

const handleRankSort = (field: SortField) => {
  if (rankSortField.value === field) {
    if (rankSortOrder.value === 'asc') {
      rankSortOrder.value = 'desc';
    } else if (rankSortOrder.value === 'desc') {
      rankSortField.value = null;
      rankSortOrder.value = null;
    }
  } else {
    rankSortField.value = field;
    rankSortOrder.value = 'asc';
  }
};

const handleNewSongSort = (field: SortField) => {
  if (newSongSortField.value === field) {
    if (newSongSortOrder.value === 'asc') {
      newSongSortOrder.value = 'desc';
    } else if (newSongSortOrder.value === 'desc') {
      newSongSortField.value = null;
      newSongSortOrder.value = null;
    }
  } else {
    newSongSortField.value = field;
    newSongSortOrder.value = 'asc';
  }
};

onMounted(() => {
  void loadPlaylistCategories();
  void loadRecommendedPlaylists();
  void loadNewSongs();
  void loadRanks();
  void loadAlbums();
});

watch(
  () => playlistCategoryId.value,
  () => {
    void loadRecommendedPlaylists();
  },
);

watch(
  () => albumTypeId.value,
  () => {
    if (activeTabIndex.value !== 2) return;
    void loadAlbums();
  },
);

watch(
  () => activeTabIndex.value,
  (tab) => {
    if (tab === 2 && !loadingAlbums.value && albums.value.length === 0) {
      void loadAlbums();
    }
  },
);

const handleSelectRank = (option: PickerOption) => {
  const id = Number.parseInt(option.id, 10);
  if (Number.isNaN(id)) return;
  rankId.value = id;
  rankLabel.value = option.name;
  showRankPicker.value = false;
  void loadRankSongs(id);
};

const handleSelectPlaylistCategory = (option: PickerOption) => {
  playlistCategoryId.value = option.id;
  playlistCategoryLabel.value = option.group ? `${option.group} - ${option.name}` : option.name;
  showPlaylistPicker.value = false;
};

const handleSelectAlbumType = (option: PickerOption) => {
  albumTypeId.value = option.id;
  albumTypeLabel.value = option.name;
  showAlbumPicker.value = false;
};
</script>

<template>
  <div
    class="explore-view px-10 pt-5 pb-10"
    :style="{ '--explore-header-height': `${exploreHeaderHeight}px` }"
  >
    <div class="explore-header">
      <div class="text-[24px] font-semibold text-text-main tracking-tight">发现音乐</div>
      <div class="mt-4">
        <CustomTabBar v-model="activeTabIndex" :tabs="['歌单', '排行榜', '新碟上架', '新歌速递']" />
      </div>
    </div>

    <div v-if="activeTabIndex === 0" class="mt-0">
      <div class="explore-toolbar">
        <CustomSelector :label="playlistCategoryLabel" @click="showPlaylistPicker = true" />
      </div>
      <div
        v-if="loadingPlaylists"
        class="h-[220px] flex items-center justify-center text-[12px] text-text-secondary/70"
      >
        加载中...
      </div>
      <div v-else class="playlist-grid mt-1">
        <div
          v-for="entry in recommendedPlaylists"
          :key="String(entry.id)"
          class="playlist-grid-item"
        >
          <PlaylistCard
            :id="
              entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id
            "
            :name="entry.name"
            :coverUrl="entry.pic"
            :creator="entry.nickname"
            :songCount="entry.count"
            :coverRadius="14"
            :showShadow="true"
            layout="grid"
          />
        </div>
      </div>
    </div>

    <div v-else-if="activeTabIndex === 1" class="mt-0">
      <div class="rank-toolbar sticky z-[120] bg-bg-main">
        <div class="rank-toolbar-inner">
          <CustomSelector :label="rankLabel" @click="showRankPicker = true" />
          <div class="rank-toolbar-actions">
            <div class="rank-action-scroll no-scrollbar">
              <ActionRow @play="playRankSongs" @batch="openRankBatchDrawer" />
            </div>
          </div>
        </div>
      </div>

      <BatchActionDrawer v-model:open="showRankBatchDrawer" :songs="rankSongs" source-id="rank" />

      <div
        class="song-list-sticky sticky z-[110] bg-bg-main"
        :style="{ top: `${rankToolbarOffset}px` }"
      >
        <div class="border-b border-border-light/10">
          <div class="flex items-center justify-between h-14">
            <div class="rank-song-tab">
              <span class="rank-song-label">歌曲</span>
              <span class="rank-song-badge">{{ rankSongCountLabel }}</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="relative">
                <input
                  v-model="rankSearchQuery"
                  type="text"
                  placeholder="搜索歌曲..."
                  class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg bg-white border border-black/30 shadow-sm text-text-main placeholder:text-text-main/50 dark:bg-white/[0.08] dark:border-white/10 dark:shadow-none outline-none text-[12px] transition-all"
                />
                <Icon
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                  :icon="iconSearch"
                  width="14"
                  height="14"
                />
              </div>
              <Button
                variant="unstyled"
                size="none"
                @click="handleRankLocate"
                class="song-locate-btn p-2 rounded-lg"
                title="定位当前播放"
              >
                <Icon :icon="iconCurrentLocation" width="16" height="16" />
              </Button>
            </div>
          </div>
        </div>

        <SongListHeader
          :sortField="rankSortField"
          :sortOrder="rankSortOrder"
          :showCover="true"
          paddingClass="px-0"
          @sort="handleRankSort"
        />
      </div>

      <div class="pb-12">
        <div v-if="loadingRankSongs" class="flex items-center justify-center py-20">
          <div
            class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
          ></div>
        </div>
        <SongList
          v-else
          ref="rankSongListRef"
          :songs="sortedRankSongs"
          :searchQuery="rankSearchQuery"
          :activeId="activeSongId"
          :showCover="true"
          :enableDefaultDoubleTapPlay="true"
          :onSongDoubleTapPlay="
            settingStore.replacePlaylist ? handleRankSongDoubleTapPlay : undefined
          "
          rowPaddingClass="px-0"
        />
      </div>
    </div>

    <div v-else-if="activeTabIndex === 2" class="mt-0">
      <div class="explore-toolbar">
        <CustomSelector :label="albumTypeLabel" @click="showAlbumPicker = true" />
      </div>
      <div
        v-if="loadingAlbums"
        class="h-[230px] flex items-center justify-center text-[12px] text-text-secondary/70"
      >
        加载中...
      </div>
      <div
        v-else-if="!hasAlbums"
        class="h-[230px] flex items-center justify-center text-[12px] text-text-secondary/70"
      >
        暂无专辑
      </div>
      <div v-else class="album-grid">
        <AlbumCard
          v-for="album in albums"
          :key="String(album.id)"
          :id="album.id"
          :name="album.name"
          :coverUrl="album.pic"
          :artist="album.singerName"
          :publishTime="album.publishTime"
        />
      </div>
    </div>

    <div v-else class="mt-0">
      <div class="new-song-toolbar sticky z-[120] bg-bg-main">
        <div class="new-song-toolbar-inner">
          <div class="new-song-title-wrap">
            <div class="new-song-badge-icon">
              <Icon :icon="iconSparkles" width="16" height="16" />
            </div>
            <div class="min-w-0">
              <div class="text-[15px] font-semibold text-text-main leading-none">新歌速递</div>
            </div>
          </div>
          <div class="new-song-toolbar-actions">
            <div class="rank-action-scroll no-scrollbar">
              <ActionRow @play="playNewSongs" @batch="openNewSongBatchDrawer" />
            </div>
          </div>
        </div>
      </div>

      <BatchActionDrawer
        v-model:open="showNewSongBatchDrawer"
        :songs="newSongs"
        source-id="new-song"
      />

      <div
        class="song-list-sticky sticky z-[110] bg-bg-main"
        :style="{ top: `${newSongToolbarOffset}px` }"
      >
        <div class="border-b border-border-light/10">
          <div class="flex items-center justify-between h-14">
            <div class="rank-song-tab">
              <span class="rank-song-label">歌曲</span>
              <span class="rank-song-badge">{{ newSongCountLabel }}</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="relative">
                <input
                  v-model="newSongSearchQuery"
                  type="text"
                  placeholder="搜索歌曲..."
                  class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg bg-white border border-black/30 shadow-sm text-text-main placeholder:text-text-main/50 dark:bg-white/[0.08] dark:border-white/10 dark:shadow-none outline-none text-[12px] transition-all"
                />
                <Icon
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                  :icon="iconSearch"
                  width="14"
                  height="14"
                />
              </div>
              <Button
                variant="unstyled"
                size="none"
                @click="handleNewSongLocate"
                class="song-locate-btn p-2 rounded-lg"
                title="定位当前播放"
              >
                <Icon :icon="iconCurrentLocation" width="16" height="16" />
              </Button>
            </div>
          </div>
        </div>

        <SongListHeader
          :sortField="newSongSortField"
          :sortOrder="newSongSortOrder"
          :showCover="true"
          paddingClass="px-0"
          @sort="handleNewSongSort"
        />
      </div>

      <div class="pb-12">
        <div v-if="loadingNewSongs" class="flex items-center justify-center py-20">
          <div
            class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
          ></div>
        </div>
        <SongList
          v-else
          ref="newSongListRef"
          :songs="sortedNewSongs"
          :searchQuery="newSongSearchQuery"
          :activeId="activeSongId"
          :showCover="true"
          :enableDefaultDoubleTapPlay="true"
          :onSongDoubleTapPlay="
            settingStore.replacePlaylist ? handleNewSongDoubleTapPlay : undefined
          "
          rowPaddingClass="px-0"
        />
      </div>
    </div>

    <CustomPicker
      v-model:open="showPlaylistPicker"
      title="歌单分类"
      :options="playlistCategories"
      :selectedId="playlistCategoryId"
      @select="handleSelectPlaylistCategory"
    />

    <CustomPicker
      v-model:open="showRankPicker"
      title="排行榜选择"
      :options="ranks.map((rank) => ({ id: String(rank.id), name: rank.name }))"
      :selectedId="rankId ? String(rankId) : ''"
      @select="handleSelectRank"
    />

    <CustomPicker
      v-model:open="showAlbumPicker"
      title="专辑类型"
      :options="albumTypes"
      :selectedId="albumTypeId"
      @select="handleSelectAlbumType"
      :maxWidth="360"
    />
  </div>
</template>

<style scoped>
@reference "@/style.css";

.explore-header {
  position: sticky;
  top: 0;
  z-index: 130;
  background: var(--color-bg-main);
  padding: 0 0 6px 0;
  min-height: var(--explore-header-height);
}

.explore-toolbar {
  display: flex;
  align-items: center;
  min-height: 46px;
  padding: 0 0 6px 0;
}

.playlist-grid {
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.playlist-grid-item :deep(.card-container) {
  height: 230px;
}

.playlist-grid-item :deep(.cover-wrapper) {
  height: 170px;
  aspect-ratio: auto;
}

.rank-toolbar {
  top: var(--explore-header-height);
}

.rank-toolbar-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 0 6px;
}

.new-song-toolbar {
  top: var(--explore-header-height);
}

.new-song-toolbar-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 0 6px;
}

.new-song-title-wrap {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.new-song-badge-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  border-radius: 8px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--color-primary) 92%, white),
    var(--color-secondary)
  );
}

.new-song-toolbar-actions {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: flex-end;
}

.rank-toolbar-actions {
  flex: 1;
  display: flex;
  justify-content: flex-end;
  min-width: 0;
}

.rank-action-scroll {
  overflow-x: auto;
}

.rank-action-scroll :deep(.action-row-wrap) {
  flex-wrap: nowrap;
}

.rank-song-tab {
  position: relative;
  display: inline-flex;
  align-items: flex-end;
  height: 36px;
}

.rank-song-label {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
  padding-bottom: 6px;
}

.rank-song-label::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 70%, transparent);
}

.rank-song-badge {
  margin-left: -4px;
  transform: translateY(-8px);
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: #ffffff;
  background: var(--color-primary);
  border: 1.5px solid var(--color-bg-main);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.album-grid {
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.album-grid :deep(.card-container) {
  height: 230px;
}

.album-grid :deep(.cover-wrapper) {
  height: 170px;
  aspect-ratio: auto;
}
</style>
