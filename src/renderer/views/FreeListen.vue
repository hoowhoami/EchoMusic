<script setup lang="ts">
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import SongList from '@/components/music/SongList.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import DetailPageError from '@/components/music/DetailPageError.vue';
import Button from '@/components/ui/Button.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';

import { computed, onMounted, ref } from 'vue';
import { getFreeListenSongs } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import type { Song } from '@/models/song';
import { usePlaylistStore, type SetPlaybackQueueOptions } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useThemeStore } from '@/stores/theme';
import { useSettingStore } from '@/stores/setting';
import { createThemedIconCoverUrl } from '@/utils/cover';
import { filterSongsByQuery } from '@/utils/songList';
import { replaceQueueAndPlay } from '@/utils/playback';
import { iconCurrentLocation, iconMusicDiscount, iconPlay } from '@/icons';
import { stringifyForLog } from '../../shared/logging';
import logger from '@/utils/logger';

defineOptions({ name: 'free-listen' });

const FREE_LISTEN_QUEUE_ID = 'queue:free-listen';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const themeStore = useThemeStore();
const settingStore = useSettingStore();

const songs = ref<Song[]>([]);
const loading = ref(false);
const loadError = ref(false);
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const seenKeys = new Set<string>();

const coverUrl = computed(() =>
  createThemedIconCoverUrl(themeStore.sourceColor, iconMusicDiscount),
);

const displayedSongs = computed(() => filterSongsByQuery(songs.value, searchQuery.value));

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const queueOptions = computed<SetPlaybackQueueOptions>(() => ({
  queueId: FREE_LISTEN_QUEUE_ID,
  title: '免费听',
  subtitle: '',
  type: 'free-listen',
  dynamic: false,
}));

const songKey = (song: Song): string => String(song.mixSongId || song.hash || song.id || '');

const collectSongs = (payload: unknown): Song[] => {
  const raw = extractList(payload);
  if (raw.length === 0) {
    logger.warn('FreeListen', `返回空列表，原始响应: ${stringifyForLog(payload, 600)}`);
    return [];
  }

  const batch: Song[] = [];
  for (const item of raw) {
    const song = mapTopSong(item);
    const key = songKey(song);
    if (!key || !song.id || seenKeys.has(key)) continue;
    seenKeys.add(key);
    batch.push(song);
  }

  if (batch.length === 0) {
    logger.warn('FreeListen', `歌曲字段未命中，原始首条: ${stringifyForLog(raw[0], 800)}`);
  }

  return batch;
};

const loadSongs = async () => {
  loading.value = true;
  loadError.value = false;
  seenKeys.clear();
  try {
    songs.value = collectSongs(await getFreeListenSongs());
  } catch {
    songs.value = [];
    loadError.value = true;
  } finally {
    loading.value = false;
  }
};

const refresh = async () => {
  searchQuery.value = '';
  await loadSongs();
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice();
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    0,
    undefined,
    queueOptions.value,
  );
};

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice();
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, queueOptions.value);
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

onMounted(() => {
  void loadSongs();
});
</script>

<template>
  <PageScrollContainer class="free-listen-container">
    <div class="free-listen-view bg-bg-main min-h-full">
      <SliverHeader
        typeLabel="FREE"
        title="免费听"
        :coverUrl="coverUrl"
        :hasDetails="true"
        distribute-details
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="contents">
            <div class="text-[13px] font-semibold text-text-secondary">
              概念版免费听推荐流，跟着推着听
            </div>
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary"
            >
              <span v-if="!loading" class="inline-flex items-center gap-1.5">
                <Icon :icon="iconPlay" width="12" height="12" />
                {{ songs.length }} 首歌曲
              </span>
            </div>
          </div>
        </template>

        <template #actions>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="soft-primary"
              size="none"
              class="free-listen-btn"
              :disabled="displayedSongs.length === 0"
              @click="handlePlayAll"
            >
              <Icon :icon="iconPlay" width="16" height="16" />
              <span>播放</span>
            </Button>
            <Button
              variant="soft-secondary"
              size="none"
              class="free-listen-btn"
              :disabled="loading"
              @click="refresh"
            >
              <RefreshIcon width="16" height="16" :class="{ 'free-listen-spin': loading }" />
              <span>刷新</span>
            </Button>
          </div>
        </template>

        <template #collapsed-actions>
          <Button
            variant="unstyled"
            size="none"
            class="action-icon p-2 hover:bg-[var(--control-hover-bg)] text-primary-text"
            :disabled="displayedSongs.length === 0"
            @click="handlePlayAll"
          >
            <Icon :icon="iconPlay" width="20" height="20" />
          </Button>
        </template>
      </SliverHeader>

      <DetailPageError
        v-if="loadError && songs.length === 0"
        resourceName="免费听推荐"
        @retry="refresh"
      />

      <div v-else-if="!loading && songs.length === 0" class="free-listen-placeholder">
        <Icon
          :icon="iconMusicDiscount"
          width="34"
          height="34"
          class="free-listen-placeholder-icon"
        />
        <p class="free-listen-placeholder-title">这次没拿到推荐内容</p>
        <p class="free-listen-placeholder-desc">
          免费听来自概念版接口，返回空列表时通常是上游临时不可用，稍后重试即可。
        </p>
        <Button variant="secondary" size="sm" class="mt-5" @click="loadSongs">刷新</Button>
      </div>

      <template v-else>
        <div class="free-listen-toolbar">
          <span class="free-listen-toolbar-title">推荐歌曲</span>
          <div class="flex items-center gap-2">
            <SongSearchInput v-model="searchQuery" />
            <Button
              variant="unstyled"
              size="none"
              @click="handleLocate"
              class="action-icon p-2"
              tooltip="定位当前播放"
            >
              <Icon :icon="iconCurrentLocation" width="16" height="16" />
            </Button>
          </div>
        </div>

        <div class="px-6 pb-12">
          <p v-if="loadError" class="free-listen-inline-error">加载失败，可点上方「刷新」重试。</p>
          <SongList
            ref="songListRef"
            :loading="loading"
            :songs="displayedSongs"
            :contextSongs="songs"
            :searchQuery="searchQuery"
            :disableInternalFilter="true"
            :activeId="activeSongId"
            :showCover="true"
            :queueOptions="queueOptions"
            :enableDefaultDoubleTapPlay="true"
            :onSongDoubleTapPlay="
              settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
            "
          />
        </div>
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

/* 与 DetailPageActionRow 的操作按钮保持同一视觉规格。 */
.free-listen-btn {
  @apply flex items-center gap-2 px-3 h-9 rounded-lg text-[12px] font-semibold transition-all active:scale-95 select-none;
}

.free-listen-spin {
  animation: free-listen-spin 0.9s linear infinite;
}

@keyframes free-listen-spin {
  to {
    transform: rotate(360deg);
  }
}

.free-listen-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.free-listen-toolbar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.free-listen-inline-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.free-listen-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 72px 24px;
  text-align: center;
}

.free-listen-placeholder-icon {
  color: var(--icon-secondary);
}

.free-listen-placeholder-title {
  margin: 14px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
}

.free-listen-placeholder-desc {
  margin: 6px 0 0;
  max-width: 380px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
</style>
