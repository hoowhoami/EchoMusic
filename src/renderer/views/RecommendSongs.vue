<script setup lang="ts">
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
defineOptions({ name: 'recommend-songs' });
import { computed, onMounted, ref } from 'vue';
import { getEverydayRecommend } from '@/api/music';
import { extractList, extractObject } from '@/utils/extractors';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { createThemedDateCoverUrl } from '@/utils/themedCover';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import DetailPageSkeleton from '@/components/music/DetailPageSkeleton.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { mapTopSong } from '@/utils/mappers';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconPlay, iconList, iconCurrentLocation } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const themeStore = useThemeStore();

const loading = ref(true);
const songs = ref<Song[]>([]);
const recommendDate = ref('');
const recommendSubtitle = ref('');
const showBatchDrawer = ref(false);
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const recommendCoverUrl = computed(() =>
  createThemedDateCoverUrl(
    themeStore.sourceColor,
    recommendDate.value ? Number(recommendDate.value.slice(-2)) : new Date().getDate(),
  ),
);

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const sortedSongs = computed(() => {
  return sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  });
});
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:daily-recommend',
    title: '每日推荐',
    subtitle: '',
    type: 'daily-recommend',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: 'queue:daily-recommend',
    title: '每日推荐',
    subtitle: '',
    type: 'daily-recommend',
    dynamic: false,
  });
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

const fetchRecommendSongs = async () => {
  loading.value = true;
  try {
    const res = await getEverydayRecommend();
    songs.value = extractList(res).map((item) => mapTopSong(item));
    const data = extractObject(res);
    const date = String(data?.creation_date ?? '');
    recommendDate.value = /^\d{8}$/.test(date)
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : '';
    recommendSubtitle.value = typeof data?.sub_title === 'string' ? data.sub_title.trim() : '';
  } catch {
    songs.value = [];
    recommendDate.value = '';
    recommendSubtitle.value = '';
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void fetchRecommendSongs();
});
</script>

<template>
  <PageScrollContainer class="recommend-songs-container">
    <div class="recommend-songs-view bg-bg-main min-h-full">
      <DetailPageSkeleton v-if="loading" typeLabel="RECOMMEND" :expandedHeight="176" />

      <template v-else>
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="RECOMMEND"
          title="每日推荐"
          :coverUrl="recommendCoverUrl"
          :hasDetails="true"
          distribute-details
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="contents">
              <div class="text-[13px] font-semibold text-text-secondary">
                {{ recommendSubtitle || '为你量身定制的每日歌单' }}
              </div>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary"
              >
                <span v-if="!loading" class="inline-flex items-center gap-1.5">
                  <Icon :icon="iconPlay" width="12" height="12" />
                  {{ songs.length }} 首歌曲
                </span>
                <span v-if="recommendDate">{{ recommendDate }} 推荐</span>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow @play="handlePlayAll" @batch="openBatchDrawer" />
          </template>

          <template #collapsed-actions>
            <Button
              variant="unstyled"
              size="none"
              @click="handlePlayAll"
              class="action-icon p-2 hover:bg-[var(--control-hover-bg)] text-primary-text"
            >
              <Icon :icon="iconPlay" width="20" height="20" />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              @click="openBatchDrawer"
              class="action-icon p-2 hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconList" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="recommend" />

        <Tabs model-value="songs" class="w-full" :style="{ minHeight: tabsMinHeight }">
          <PageStickyHeader
            class="song-list-sticky sticky z-110 bg-bg-main"
            :style="{ top: `${tabsTop}px` }"
          >
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList class="bg-transparent border-none gap-8">
                    <TabsTrigger value="songs">
                      <span class="badge-label">歌曲 <Badge :count="songs.length" /></span>
                    </TabsTrigger>
                  </TabsList>

                  <div class="flex items-center gap-2">
                    <SongSearchInput v-model="searchQuery" />
                    <Button
                      variant="unstyled"
                      size="none"
                      @click="handleLocate"
                      class="action-icon song-locate-btn p-2"
                      tooltip="定位当前播放"
                    >
                      <Icon :icon="iconCurrentLocation" width="16" height="16" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <SongListHeader
              :sortField="sortField"
              :sortOrder="sortOrder"
              :showCover="true"
              paddingClass="px-6"
              @sort="handleSort"
            />
          </PageStickyHeader>

          <div class="px-6 pb-12">
            <SongList
              ref="songListRef"
              :loading="loading"
              :songs="displayedSongs"
              :contextSongs="sortedSongs"
              :searchQuery="searchQuery"
              :disableInternalFilter="true"
              :activeId="activeSongId"
              :showCover="true"
              :queueOptions="{
                queueId: 'queue:daily-recommend',
                title: '每日推荐',
                subtitle: '',
                type: 'daily-recommend',
                dynamic: false,
              }"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
              "
            />
          </div>
        </Tabs>
      </template>
    </div>
  </PageScrollContainer>
</template>
