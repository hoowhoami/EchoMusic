<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
defineOptions({ name: 'discover-flow' });

import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';
import Cover from '@/components/ui/Cover.vue';
import DetailPageError from '@/components/music/DetailPageError.vue';
import { fetchDiscoverItems } from '@/services/discover';
import {
  iconChevronDown,
  iconChevronUp,
  iconHeart,
  iconHeartFilled,
  iconLoader2,
  iconPause,
  iconPlay,
} from '@/icons';
import { usePlayerStore } from '@/stores/player';
import {
  DISCOVER_QUEUE_ID,
  usePlaylistStore,
  type SetPlaybackQueueOptions,
} from '@/stores/playlist';
import { useToastStore } from '@/stores/toast';
import type { DiscoverItem } from '@/utils/mappers/discover';
import { resolvePlayableQueue } from '@/utils/playback';
import { getSongQualityTags, isPlayableSong } from '@/utils/song';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();

const items = ref<DiscoverItem[]>([]);
const activeIndex = ref(0);
const loading = ref(true);
const loadingMore = ref(false);
const actionBusy = ref(false);
const playbackBusy = ref(false);
const errorMessage = ref('');
const requestSeq = ref(0);
const lastWheelAt = ref(-Infinity);
let playbackSeq = 0;
let navigationSeq = 0;
let appendRequest: Promise<void> | null = null;
let disposed = false;
const followActiveQueue = ref(true);

const currentItem = computed(() => items.value[activeIndex.value] ?? null);
const currentSong = computed(() => currentItem.value?.song ?? null);
const artworkUrl = computed(() => currentSong.value?.cover || currentSong.value?.coverUrl || '');
const queueSongs = computed(() => items.value.map((item) => item.song));
const currentTrackId = computed(() => String(playerStore.currentTrackId ?? ''));
const isCurrentTrack = computed(
  () =>
    playerStore.currentSourceQueueId === DISCOVER_QUEUE_ID &&
    Boolean(currentSong.value) &&
    String(currentSong.value?.id) === currentTrackId.value,
);
const isCurrentPlaying = computed(() => isCurrentTrack.value && Boolean(playerStore.isPlaying));
const favorite = computed(() =>
  currentSong.value ? playlistStore.isFavoriteSong(currentSong.value) : false,
);
const canGoPrev = computed(() => activeIndex.value > 0);
const canGoNext = computed(
  () =>
    items.value.length === 0 || activeIndex.value < items.value.length - 1 || !loadingMore.value,
);
const progressLabel = computed(() =>
  items.value.length > 0 ? `${activeIndex.value + 1} / ${items.value.length}` : '0 / 0',
);
const qualityTags = computed(() => {
  const song = currentSong.value;
  return song ? getSongQualityTags(song.relateGoods) : [];
});

const discoverQueueOptions = computed<SetPlaybackQueueOptions>(() => ({
  queueId: DISCOVER_QUEUE_ID,
  title: '刷歌',
  subtitle: '',
  coverUrl: currentSong.value?.coverUrl,
  type: 'home-discover',
  dynamic: true,
  meta: {
    activeIndex: activeIndex.value,
    algPath: currentItem.value?.algPath,
  },
}));

watch(
  [() => playlistStore.defaultList, () => playerStore.currentSourceQueueId, followActiveQueue],
  () => {
    if (!followActiveQueue.value || playerStore.currentSourceQueueId !== DISCOVER_QUEUE_ID) return;
    const queue = playlistStore.getQueueById(DISCOVER_QUEUE_ID);
    if (!queue) return;
    const previous = new Map(items.value.map((item) => [String(item.song.id), item]));
    items.value = queue.songs.map((song) => ({
      key: String(song.mixSongId || song.id),
      algPath: '',
      itemId: String(song.id),
      ...previous.get(String(song.id)),
      song,
    }));
  },
  { immediate: true },
);

watch(
  [() => playerStore.currentSourceQueueId, currentTrackId, items],
  ([queueId, trackId], [previousQueueId]) => {
    if (queueId !== DISCOVER_QUEUE_ID || !followActiveQueue.value) {
      if (previousQueueId === DISCOVER_QUEUE_ID) {
        navigationSeq += 1;
        playbackSeq += 1;
        playbackBusy.value = false;
      }
      return;
    }
    const index = items.value.findIndex((item) => String(item.song.id) === trackId);
    if (index < 0 || index === activeIndex.value) return;

    // Follow player-originated changes without issuing another playback request.
    navigationSeq += 1;
    playbackSeq += 1;
    playbackBusy.value = false;
    activeIndex.value = index;
  },
  { immediate: true },
);

const mergeItems = (incoming: DiscoverItem[]) => {
  const seen = new Set(items.value.map((item) => item.key));
  const next = incoming.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
  if (next.length > 0) items.value = [...items.value, ...next];
  return next.length;
};

const fetchDiscover = async (append = false) => {
  if (append) {
    if (loadingMore.value) return;
    loadingMore.value = true;
  } else {
    loading.value = true;
    errorMessage.value = '';
  }

  const seq = ++requestSeq.value;
  try {
    if (
      append &&
      followActiveQueue.value &&
      playerStore.currentSourceQueueId === DISCOVER_QUEUE_ID
    ) {
      const added = await playlistStore.replenishDiscoverQueue(currentTrackId.value);
      if (!added && seq === requestSeq.value) toastStore.info('暂时没有新的推荐歌曲，请稍后重试');
      return;
    }
    const mapped = await fetchDiscoverItems();
    if (seq !== requestSeq.value) return;
    if (append) mergeItems(mapped);
    else items.value = mapped;
    if (!append) activeIndex.value = 0;
    if (items.value.length === 0) errorMessage.value = '暂时没有推荐歌曲';
  } catch {
    if (seq !== requestSeq.value) return;
    errorMessage.value = append ? '' : '推荐歌曲加载失败';
    if (!append) toastStore.loadFailed('推荐歌曲');
  } finally {
    if (seq === requestSeq.value) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
};

const loadDiscover = (append = false): Promise<void> => {
  if (!append) return fetchDiscover();
  if (appendRequest) return appendRequest;
  const request = fetchDiscover(true);
  appendRequest = request;
  void request.finally(() => {
    if (appendRequest === request) appendRequest = null;
  });
  return request;
};

const refreshDiscover = () => {
  navigationSeq += 1;
  followActiveQueue.value = false;
  void loadDiscover(false);
};

const goPrev = () => {
  navigationSeq += 1;
  if (activeIndex.value <= 0) return;
  activeIndex.value -= 1;
  void startCurrentPlayback();
};

const goNext = async () => {
  const seq = ++navigationSeq;
  if (activeIndex.value < items.value.length - 1) {
    activeIndex.value += 1;
    void startCurrentPlayback();
    return;
  }
  await loadDiscover(true);
  if (seq !== navigationSeq) return;
  if (activeIndex.value < items.value.length - 1) {
    activeIndex.value += 1;
    void startCurrentPlayback();
  }
};

const startCurrentPlayback = async () => {
  const song = currentSong.value;
  if (!song) return;
  if (!isPlayableSong(song)) {
    toastStore.unavailable('当前歌曲');
    return;
  }

  const seq = ++playbackSeq;
  playbackBusy.value = true;
  try {
    const resolved = resolvePlayableQueue(queueSongs.value, 0, song);
    const existing = playlistStore.getQueueById(DISCOVER_QUEUE_ID);
    if (
      !followActiveQueue.value ||
      !existing ||
      existing.songs.length !== resolved.queue.length ||
      existing.songs.some((track, index) => String(track.id) !== String(resolved.queue[index]?.id))
    ) {
      playlistStore.setPlaybackQueueWithOptions(
        resolved.queue,
        resolved.filteredInvalidCount,
        discoverQueueOptions.value,
      );
    }
    followActiveQueue.value = true;
    // Every swipe is a new playback intent, including returning to a still-loading song.
    await playerStore.playTrack(String(song.id), resolved.queue, {
      autoPlay: true,
      sourceQueueId: DISCOVER_QUEUE_ID,
    });
  } catch {
    if (seq === playbackSeq) toastStore.actionFailed('播放');
  } finally {
    if (seq === playbackSeq) playbackBusy.value = false;
  }
};

const playCurrent = async () => {
  if (playbackBusy.value) return;
  if (isCurrentTrack.value) {
    await playerStore.togglePlay();
    return;
  }
  await startCurrentPlayback();
};

const toggleFavorite = async () => {
  const song = currentSong.value;
  if (!song || actionBusy.value) return;

  actionBusy.value = true;
  try {
    const ok = favorite.value
      ? await playlistStore.removeFavoriteSong(song)
      : await playlistStore.addToFavorites(song);
    if (!ok) toastStore.actionFailed(favorite.value ? '取消收藏' : '收藏');
  } catch {
    toastStore.actionFailed(favorite.value ? '取消收藏' : '收藏');
  } finally {
    actionBusy.value = false;
  }
};

const handleWheel = (event: WheelEvent) => {
  if (Math.abs(event.deltaY) < 24) return;
  const now = window.performance.now();
  if (now - lastWheelAt.value < 420) return;
  lastWheelAt.value = now;
  if (event.deltaY > 0) void goNext();
  else goPrev();
};

const handleKeydown = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'ArrowDown' || event.key === 'PageDown') {
    event.preventDefault();
    void goNext();
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault();
    goPrev();
  }
};

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown);
  await playerStore.whenInitialized();
  if (disposed) return;
  if (items.value.length === 0) void loadDiscover(false);
  else loading.value = false;
});

const deactivate = () => {
  navigationSeq += 1;
  window.removeEventListener('keydown', handleKeydown);
};

onActivated(() => {
  window.addEventListener('keydown', handleKeydown);
});
onDeactivated(deactivate);
onBeforeUnmount(() => {
  disposed = true;
  requestSeq.value += 1;
  deactivate();
});
</script>

<template>
  <section class="discover-reel-page" @wheel.prevent="handleWheel">
    <Transition name="discover-backdrop">
      <div v-if="artworkUrl" :key="artworkUrl" class="discover-reel-backdrop" aria-hidden="true">
        <Cover
          :url="artworkUrl"
          :size="800"
          width="100%"
          height="100%"
          :border-radius="0"
          :show-border="false"
          alt=""
        />
      </div>
    </Transition>

    <header class="discover-reel-header">
      <h1>刷歌</h1>
      <Button
        class="action-icon discover-reel-refresh"
        variant="unstyled"
        size="none"
        tooltip="换一批推荐"
        tooltip-side="bottom"
        :disabled="loading"
        :aria-busy="loading"
        @click="refreshDiscover"
      >
        <RefreshIcon width="20" height="20" :class="{ 'spin-icon': loading }" />
      </Button>
    </header>

    <div v-if="loading && items.length === 0" class="discover-reel-state">
      <Icon class="spin-icon" :icon="iconLoader2" width="24" height="24" />
      <span>正在获取推荐</span>
    </div>

    <DetailPageError
      v-else-if="errorMessage && items.length === 0"
      class="discover-reel-error"
      resource-name="推荐歌曲"
      @retry="refreshDiscover"
    />

    <main v-else-if="currentItem && currentSong" class="discover-reel-stage">
      <Transition name="discover-info" mode="out-in">
        <section :key="currentItem.key" class="discover-reel-info" aria-live="polite">
          <div class="discover-reel-meta">
            <span class="discover-reel-progress">{{ progressLabel }}</span>
            <span v-for="tag in qualityTags" :key="tag" class="discover-reel-quality">
              {{ tag }}
            </span>
          </div>
          <Tooltip :content="currentSong.name || currentSong.title" overflow-only>
            <template #trigger>
              <h2>
                {{ currentSong.name || currentSong.title }}
              </h2>
            </template>
          </Tooltip>
          <Tooltip :content="currentSong.artist" overflow-only>
            <template #trigger>
              <p>{{ currentSong.artist }}</p>
            </template>
          </Tooltip>
          <Tooltip v-if="currentSong.albumName" :content="currentSong.albumName" overflow-only>
            <template #trigger>
              <div class="discover-reel-album">
                {{ currentSong.albumName }}
              </div>
            </template>
          </Tooltip>
        </section>
      </Transition>

      <nav class="discover-reel-actions" aria-label="刷歌操作">
        <Button
          class="action-icon discover-reel-action"
          variant="unstyled"
          size="none"
          :disabled="!canGoPrev"
          tooltip="上一首"
          tooltip-side="left"
          @click="goPrev"
        >
          <Icon :icon="iconChevronUp" width="22" height="22" />
        </Button>
        <Button
          class="action-icon discover-reel-action"
          :class="{ active: favorite }"
          variant="unstyled"
          size="none"
          :disabled="actionBusy"
          :tooltip="favorite ? '取消收藏' : '收藏'"
          tooltip-side="left"
          @click="toggleFavorite"
        >
          <Icon :icon="favorite ? iconHeartFilled : iconHeart" width="22" height="22" />
        </Button>
        <Button
          class="action-icon discover-reel-play"
          variant="unstyled"
          size="none"
          :disabled="playbackBusy"
          :tooltip="isCurrentPlaying ? '暂停' : '播放'"
          tooltip-side="left"
          @click="playCurrent"
        >
          <Icon
            :icon="playbackBusy ? iconLoader2 : isCurrentPlaying ? iconPause : iconPlay"
            width="26"
            height="26"
            :class="{ 'spin-icon': playbackBusy }"
          />
        </Button>
        <Button
          class="action-icon discover-reel-action"
          variant="unstyled"
          size="none"
          :disabled="!canGoNext"
          tooltip="下一首"
          tooltip-side="left"
          @click="goNext"
        >
          <Icon :icon="iconChevronDown" width="22" height="22" />
        </Button>
        <span
          class="discover-reel-loading"
          role="status"
          :aria-label="loadingMore ? '正在获取推荐' : undefined"
        >
          <Icon v-if="loadingMore" class="spin-icon" :icon="iconLoader2" width="16" height="16" />
        </span>
      </nav>
    </main>
  </section>
</template>

<style scoped>
.discover-reel-page {
  position: relative;
  isolation: isolate;
  container-type: size;
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--color-text-main);
  background: transparent;
}

.discover-reel-backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  pointer-events: none;
}

.discover-reel-backdrop :deep(.cover-container) {
  background: transparent;
  mask-image: linear-gradient(
    180deg,
    transparent,
    rgb(0 0 0 / 10%) 5%,
    rgb(0 0 0 / 45%) 12%,
    rgb(0 0 0 / 82%) 20%,
    #000 28%,
    #000 58%,
    transparent
  );
}

.discover-reel-backdrop :deep(.cover-img) {
  object-fit: cover;
  object-position: center 35%;
}

.discover-reel-header,
.discover-reel-stage,
.discover-reel-state,
.discover-reel-error {
  position: relative;
  z-index: 1;
}

.discover-reel-header {
  position: absolute;
  top: 20px;
  right: 28px;
  left: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.discover-reel-header h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.4;
  font-weight: 700;
  letter-spacing: 0;
}

.discover-reel-refresh {
  display: inline-flex;
  flex: 0 0 34px;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  box-shadow: none;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.discover-reel-refresh:hover:not(:disabled) {
  color: var(--color-text-main);
}

.discover-reel-state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.discover-reel-error {
  height: 100%;
}

.discover-reel-stage {
  --reel-text-secondary: color-mix(in srgb, var(--color-text-main) 80%, transparent);
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 52px;
  align-items: end;
  gap: 32px;
  padding: 88px 32px 40px;
  pointer-events: none;
}

.discover-reel-stage::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  /* A readable media scrim, independent of the window/panel opacity. It sits
   * behind the content, so neither the artwork nor the foreground is blurred. */
  background: linear-gradient(
    to top,
    var(--surface-main-base),
    color-mix(in srgb, var(--surface-main-base) 96%, transparent) 240px,
    transparent 460px
  );
}

.discover-reel-info {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  width: 100%;
  max-width: 680px;
  display: grid;
  gap: 10px;
  align-self: end;
  pointer-events: auto;
}

.discover-reel-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.discover-reel-progress {
  margin-right: 4px;
  color: var(--reel-text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.discover-reel-info h2 {
  margin: 0;
  color: var(--color-text-main);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 32px;
  line-height: 1.3;
  font-weight: 700;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.discover-reel-info p {
  margin: 0;
  color: var(--reel-text-secondary);
  font-size: 16px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-reel-album {
  color: var(--reel-text-secondary);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-reel-actions {
  grid-column: 2;
  grid-row: 1;
  position: relative;
  display: grid;
  gap: 12px;
  justify-items: center;
  pointer-events: auto;
}

.discover-reel-action,
.discover-reel-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  flex-shrink: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  color: var(--reel-text-secondary);
}

.discover-reel-action:hover:not(:disabled),
.discover-reel-play:hover:not(:disabled) {
  color: var(--color-text-main);
}

.discover-reel-action {
  width: 40px;
  height: 40px;
}

.discover-reel-play {
  width: 52px;
  height: 52px;
  color: var(--color-text-main);
}

.discover-reel-action.active {
  color: var(--state-danger);
}

.discover-reel-loading {
  position: absolute;
  bottom: -26px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--reel-text-secondary);
}

.discover-backdrop-enter-active,
.discover-backdrop-leave-active {
  transition: opacity 0.4s ease;
}

.discover-backdrop-enter-from,
.discover-backdrop-leave-to {
  opacity: 0;
}

.discover-info-enter-active,
.discover-info-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.discover-info-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.discover-info-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.spin-icon {
  animation: discover-spin 0.9s linear infinite;
}

@keyframes discover-spin {
  to {
    transform: rotate(360deg);
  }
}

@container (max-width: 600px) {
  .discover-reel-header {
    top: 16px;
    right: 18px;
    left: 18px;
  }

  .discover-reel-stage {
    gap: 20px;
    padding: 76px 18px 32px;
  }

  .discover-reel-info h2 {
    font-size: 24px;
  }

  .discover-reel-info p {
    font-size: 14px;
  }
}

@container (max-height: 420px) {
  .discover-reel-stage {
    padding-top: 68px;
    padding-bottom: 28px;
  }

  .discover-reel-info h2 {
    font-size: 24px;
  }

  .discover-reel-actions {
    gap: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .discover-backdrop-enter-active,
  .discover-backdrop-leave-active,
  .discover-info-enter-active,
  .discover-info-leave-active {
    transition: none;
  }
}
</style>
