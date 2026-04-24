<script setup lang="ts">
defineOptions({ name: 'explore' });
import { computed, onMounted, reactive, ref, watch } from 'vue';
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
  mapArtistMeta,
} from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { RankMeta } from '@/models/rank';
import type { Song } from '@/models/song';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import Badge from '@/components/ui/Badge.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import CustomSelector from '@/components/ui/CustomSelector.vue';
import CustomPicker, { type PickerOption } from '@/components/ui/CustomPicker.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import { getAlbumTop } from '@/api/music';
import { getArtistList } from '@/api/artist';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconCurrentLocation, iconSearch, iconSparkles } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useToastStore } from '@/stores/toast';

interface ExplorePlaylistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  creator?: string;
  songCount?: number;
}

interface ExploreAlbumCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  artist?: string;
  publishTime?: string;
}

interface ExploreArtistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  songCount?: number;
  albumCount?: number;
  fansCount?: number;
}

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const recommendedPlaylists = ref<PlaylistMeta[]>([]);
const newSongs = ref<Song[]>([]);
const loadingPlaylists = ref(true);
const loadingNewSongs = ref(false);
const activeTabIndex = ref(0);
const showPlaylistPicker = ref(false);
const showRankPicker = ref(false);
const showAlbumPicker = ref(false);

interface ArtistGroup {
  title: string;
  artists: ExploreArtistCardProps[];
}

const artistResults = ref<ArtistMeta[]>([]);
const artistGroups = ref<ArtistGroup[]>([]);
const artistLetters = ref<string[]>([]);
const activeArtistLetter = ref('');
const loadingArtists = ref(false);
const showArtistSexPicker = ref(false);
const showArtistTypePicker = ref(false);
const artistSexTypes = ref<PickerOption[]>([]);
const artistTypes = ref<PickerOption[]>([]);
const artistSexId = ref('0');
const artistSexLabel = ref('全部');
const artistTypeId = ref('0:0');
const artistTypeLabel = ref('全部');

const playlistCategories = ref<PickerOption[]>([]);
const playlistCategoryLabel = ref('全部');
const playlistCategoryId = ref('0');

const ranks = ref<RankMeta[]>([]);
const rankLabel = ref('排行榜');
const rankId = ref<number | null>(null);
const rankSongs = ref<Song[]>([]);
const loadingRankSongs = ref(false);
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
const loadingAlbums = ref(false);
const tabLoaded = reactive({ rank: false, album: false, newSong: false, artist: false });
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

const loadArtists = async () => {
  loadingArtists.value = true;
  try {
    const res = await getArtistList({
      sextypes: Number(artistSexId.value),
      type: Number(artistTypeId.value.split(':')[0] ?? 0),
      musician: Number(artistTypeId.value.split(':')[1] ?? 0),
    });
    const record = res && typeof res === 'object' ? (res as Record<string, unknown>) : undefined;
    const data =
      record?.data && typeof record.data === 'object'
        ? (record.data as Record<string, unknown>)
        : record;

    // 解析歌手列表（保留分组结构）
    const infoList = Array.isArray(data?.info) ? data.info : [];
    const groups: ArtistGroup[] = [];
    const letters: string[] = [];
    const allArtists: ArtistMeta[] = [];

    for (const group of infoList) {
      const g = group as Record<string, unknown>;
      const title = String(g.title ?? '');
      const singers = Array.isArray(g.singer) ? g.singer : [];
      if (singers.length === 0) continue;
      const mapped = singers.map((item) => mapArtistMeta(item));
      allArtists.push(...mapped);
      letters.push(title);
      groups.push({
        title,
        artists: mapped.map((a) => getArtistCardProps(a)),
      });
    }

    artistResults.value = allArtists;
    artistGroups.value = groups;
    artistLetters.value = letters;
    // 默认选中热门分组（非字母的第一个分组）
    const hotGroup = letters.find((l) => !/^[A-Z#]$/.test(l));
    activeArtistLetter.value = hotGroup ?? letters[0] ?? '全部';

    // 首次加载时从 enu_list 构建筛选选项
    if (artistSexTypes.value.length === 0 || artistTypes.value.length === 0) {
      const enuList =
        data?.enu_list && typeof data.enu_list === 'object'
          ? (data.enu_list as Record<string, unknown>)
          : undefined;
      if (enuList) {
        const rawSex = Array.isArray(enuList.sextypes) ? enuList.sextypes : [];
        artistSexTypes.value = rawSex.map((item: unknown) => {
          const r = item as Record<string, unknown>;
          return { id: String(r.key ?? 0), name: String(r.value ?? '') };
        });
        const rawTypes = Array.isArray(enuList.types) ? enuList.types : [];
        artistTypes.value = rawTypes.map((item: unknown) => {
          const r = item as Record<string, unknown>;
          return {
            id: `${r.key ?? 0}:${r.musician ?? 0}`,
            name: String(r.value ?? ''),
          };
        });
      }
    }
  } catch {
    artistResults.value = [];
  } finally {
    loadingArtists.value = false;
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
    if (tab === 1 && !tabLoaded.rank) {
      tabLoaded.rank = true;
      void loadRanks();
    }
    if (tab === 2 && !tabLoaded.album) {
      tabLoaded.album = true;
      void loadAlbums();
    }
    if (tab === 3 && !tabLoaded.newSong) {
      tabLoaded.newSong = true;
      void loadNewSongs();
    }
    if (tab === 4 && !tabLoaded.artist) {
      tabLoaded.artist = true;
      void loadArtists();
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

const handleSelectArtistSex = (option: PickerOption) => {
  artistSexId.value = option.id;
  artistSexLabel.value = option.name;
  showArtistSexPicker.value = false;
  void loadArtists();
};

const handleSelectArtistType = (option: PickerOption) => {
  artistTypeId.value = option.id;
  artistTypeLabel.value = option.name;
  showArtistTypePicker.value = false;
  void loadArtists();
};

const getPlaylistCardProps = (entry: PlaylistMeta): ExplorePlaylistCardProps => {
  return {
    id: entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id,
    name: entry.name,
    coverUrl: entry.pic,
    creator: entry.nickname,
    songCount: entry.count,
  };
};

const getAlbumCardProps = (album: AlbumMeta): ExploreAlbumCardProps => {
  return {
    id: album.id,
    name: album.name,
    coverUrl: album.pic,
    artist: album.singerName,
    publishTime: album.publishTime,
  };
};

const recommendedPlaylistCards = computed(() =>
  recommendedPlaylists.value.map((entry) => getPlaylistCardProps(entry)),
);

const albumCards = computed(() => albums.value.map((entry) => getAlbumCardProps(entry)));

const getArtistCardProps = (artist: ArtistMeta): ExploreArtistCardProps => {
  return {
    id: artist.id,
    name: artist.name,
    coverUrl: artist.pic,
    songCount: artist.songCount,
    albumCount: artist.albumCount,
    fansCount: artist.fansCount,
  };
};

// const artistCards = computed(() => artistResults.value.map((entry) => getArtistCardProps(entry)));

const scrollToArtistGroup = (letter: string) => {
  activeArtistLetter.value = letter;
};

const filteredArtistCards = computed(() => {
  const isHotGroup = (title: string) => !/^[A-Z#]$/.test(title);
  if (activeArtistLetter.value === '全部') {
    // 全部模式：排除热门分组，只展示字母分组
    return artistGroups.value.filter((g) => !isHotGroup(g.title)).flatMap((g) => g.artists);
  }
  const group = artistGroups.value.find((g) => g.title === activeArtistLetter.value);
  return group ? group.artists : [];
});
</script>

<template>
  <div
    class="explore-view px-10 pt-4 pb-10"
    :style="{ '--explore-header-height': `${exploreHeaderHeight}px` }"
  >
    <div class="explore-header">
      <div class="text-[24px] font-semibold text-text-main tracking-tight">探索发现</div>
      <div class="mt-4">
        <CustomTabBar
          v-model="activeTabIndex"
          :tabs="['歌单', '排行榜', '新碟上架', '新歌速递', '歌手']"
        />
      </div>
    </div>

    <div v-if="activeTabIndex === 0" class="mt-0">
      <div class="explore-toolbar">
        <CustomSelector :label="playlistCategoryLabel" @click="showPlaylistPicker = true" />
      </div>
      <VirtualGrid
        class="mt-1"
        :items="recommendedPlaylistCards"
        :loading="loadingPlaylists"
        :active="activeTabIndex === 0"
        :itemMinWidth="180"
        :itemHeight="230"
        :gap="20"
        :overscan="3"
        :stateMinHeight="220"
        keyField="id"
      >
        <template #default="{ item }">
          <PlaylistCard v-bind="item" :coverRadius="14" :showShadow="true" layout="grid" />
        </template>
      </VirtualGrid>
    </div>

    <div v-else-if="activeTabIndex === 1" class="mt-0">
      <div class="rank-toolbar sticky z-[120] bg-bg-main">
        <div class="rank-toolbar-inner">
          <CustomSelector :label="rankLabel" @click="showRankPicker = true" />
          <div class="rank-toolbar-actions">
            <div class="rank-action-scroll">
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
              <span class="rank-song-label relative"
                >歌曲 <Badge :count="rankSongCountLabel"
              /></span>
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
          :queueOptions="{
            queueId: `queue:explore:rank:${rankId ?? 'default'}`,
            title: ranks.find((r: RankMeta) => r.id === rankId)?.name || '排行榜',
            subtitle: ranks.find((r: RankMeta) => r.id === rankId)?.rankTypeName || '实时热门趋势',
            type: 'ranking',
            dynamic: false,
          }"
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
      <VirtualGrid
        :items="albumCards"
        :loading="loadingAlbums"
        :active="activeTabIndex === 2"
        :itemMinWidth="180"
        :itemHeight="230"
        :gap="20"
        :overscan="3"
        :stateMinHeight="230"
        emptyText="暂无专辑"
        keyField="id"
      >
        <template #default="{ item }">
          <AlbumCard v-bind="item" />
        </template>
      </VirtualGrid>
    </div>

    <div v-else-if="activeTabIndex === 3" class="mt-0">
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
            <div class="rank-action-scroll">
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
              <span class="rank-song-label relative"
                >歌曲 <Badge :count="newSongCountLabel"
              /></span>
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
          :queueOptions="{
            queueId: 'queue:explore:new-songs',
            title: '新歌速递',
            subtitle: albumTypeLabel,
            type: 'default',
            dynamic: false,
          }"
          :enableDefaultDoubleTapPlay="true"
          :onSongDoubleTapPlay="
            settingStore.replacePlaylist ? handleNewSongDoubleTapPlay : undefined
          "
          rowPaddingClass="px-0"
        />
      </div>
    </div>

    <div v-else-if="activeTabIndex === 4" class="mt-0">
      <div class="explore-toolbar">
        <div class="flex items-center gap-2">
          <CustomSelector :label="`性别: ${artistSexLabel}`" @click="showArtistSexPicker = true" />
          <CustomSelector
            :label="`类型: ${artistTypeLabel}`"
            @click="showArtistTypePicker = true"
          />
        </div>
      </div>

      <div v-if="loadingArtists" class="flex items-center justify-center py-20">
        <div
          class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>

      <template v-else-if="filteredArtistCards.length > 0">
        <div class="artist-letter-bar">
          <span
            :class="['artist-letter-item', activeArtistLetter === '全部' ? 'is-active' : '']"
            @click="scrollToArtistGroup('全部')"
            >全部</span
          >
          <span
            v-for="letter in artistLetters"
            :key="letter"
            :class="['artist-letter-item', activeArtistLetter === letter ? 'is-active' : '']"
            @click="scrollToArtistGroup(letter)"
            >{{ letter }}</span
          >
        </div>

        <VirtualGrid
          :items="filteredArtistCards"
          :loading="false"
          :active="activeTabIndex === 4"
          :itemMinWidth="180"
          :itemHeight="230"
          :gap="20"
          :overscan="3"
          :stateMinHeight="220"
          keyField="id"
        >
          <template #default="{ item }">
            <ArtistCard v-bind="item" />
          </template>
        </VirtualGrid>
      </template>

      <div v-else class="py-20 text-center opacity-50 text-[14px] italic">暂无歌手</div>
    </div>

    <CustomPicker
      v-model:open="showArtistSexPicker"
      title="性别筛选"
      :options="artistSexTypes"
      :selectedId="artistSexId"
      @select="handleSelectArtistSex"
      :maxWidth="360"
    />

    <CustomPicker
      v-model:open="showArtistTypePicker"
      title="类型筛选"
      :options="artistTypes"
      :selectedId="artistTypeId"
      @select="handleSelectArtistType"
      :maxWidth="360"
    />

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

.artist-letter-bar {
  display: flex;
  flex-wrap: nowrap;
  gap: 2px;
  padding: 4px 0 10px;
  overflow-x: auto;
}

.artist-letter-item {
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  transition: all 0.15s ease;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
}

.artist-letter-item:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.artist-letter-item.is-active {
  color: #fff;
  background: var(--color-primary);
}
</style>
