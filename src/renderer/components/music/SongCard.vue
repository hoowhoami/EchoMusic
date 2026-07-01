<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Cover from '@/components/ui/Cover.vue';
import Tag from '@/components/ui/Tag.vue';
import { formatDuration } from '@/utils/format';
import type { Song, SongArtist } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import Button from '@/components/ui/Button.vue';
import { iconMessageCircle, iconHeart, iconHeartFilled, iconPlay } from '@/icons';
import MvIcon from '@/components/ui/MvIcon.vue';
import { playSongInContext, queueAndPlaySong } from '@/utils/playback';
import { getSongDerivedState } from '@/utils/song';

interface Props {
  song: Song;
  class?: string;
  showAlbum?: boolean;
  showDuration?: boolean;
  showMore?: boolean;
  showCover?: boolean;
  showQuality?: boolean;
  active?: boolean;
  variant?: 'card' | 'list';
  parentPlaylistId?: string | number;
  enableRemoveFromPlaylist?: boolean;
  disableLinks?: boolean;
  queueContext?: Song[];
  queueOptions?: SetPlaybackQueueOptions;
  queueFilteredInvalidCount?: number;
  onDoubleTapPlay?: (song: Song) => void | Promise<void>;
  onCoverPlay?: (song: Song) => void | Promise<void>;
  onRemovedFromPlaylist?: (song: Song) => void;
  enableDefaultDoubleTapPlay?: boolean;
  showCoverPlayButton?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  parentPlaylistId: '',
  enableRemoveFromPlaylist: false,
  showAlbum: true,
  showDuration: true,
  showMore: true,
  showCover: true,
  showQuality: true,
  active: false,
  variant: 'card',
  disableLinks: false,
  enableDefaultDoubleTapPlay: false,
  showCoverPlayButton: false,
  queueFilteredInvalidCount: 0,
});

const router = useRouter();
const route = useRoute();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
// const settingStore = useSettingStore();

const baseClass = computed(() =>
  props.variant === 'list'
    ? 'song-card group flex items-center gap-3 p-0 rounded-none transition-all duration-200 bg-transparent hover:bg-transparent cursor-default'
    : 'song-card song-card-surface group flex items-center gap-3 p-2 rounded-xl transition-all duration-200 cursor-pointer',
);

const songPayload = computed(() => props.song);
const songId = computed(() => String(songPayload.value.id ?? ''));
const songTitle = computed(() => songPayload.value.name || '');
const songArtistText = computed(() => songPayload.value.artist || '');
const songArtists = computed(() => songPayload.value.artists ?? songPayload.value.singers ?? []);
const songAlbum = computed(() => songPayload.value.album ?? songPayload.value.albumName ?? '');
const songAlbumId = computed(() => songPayload.value.albumId);
const songCoverUrl = computed(() => songPayload.value.coverUrl ?? songPayload.value.cover ?? '');
const songDuration = computed(() => songPayload.value.duration ?? 0);
const songHash = computed(() => songPayload.value.hash ?? '');
const songMixSongId = computed(() => songPayload.value.mixSongId ?? songPayload.value.id ?? '');
const songMvHash = computed(() => songPayload.value.mvHash ?? '');
const songAlbumAudioId = computed(
  () =>
    resolveNumericId(songPayload.value.albumAudioId) ??
    resolveNumericId(songMixSongId.value) ??
    resolveNumericId(songId.value),
);
const songIsOriginal = computed(() => Boolean(songPayload.value.isOriginal));

const derivedState = computed(() => getSongDerivedState(songPayload.value));
// const isVip = computed(() => derivedState.value.isVip);
// const isPaid = computed(() => derivedState.value.isPaid);
// const isNoCopyright = computed(() => derivedState.value.isNoCopyright);
// const isUnavailable = computed(() => derivedState.value.isUnavailable);
const isPlayable = computed(() => derivedState.value.isPlayable);
// const unavailableMessage = computed(() => derivedState.value.unavailableMessage);
const contentOpacity = computed(() => {
  if (props.variant === 'list') return 1;
  return isPlayable.value ? 1 : 0.45;
});

const qualityTag = computed(() => derivedState.value.qualityTag);

const privilegeTags = computed(() => derivedState.value.privilegeTags);

const isFavorite = computed(() => playlistStore.isFavoriteSong(songPayload.value));

const artistList = computed(() => {
  if (songArtists.value && songArtists.value.length > 0) return songArtists.value;
  if (!songArtistText.value) return [] as SongArtist[];
  const names = songArtistText.value
    .split(/[,/，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 1) {
    return [{ id: songArtists.value?.[0]?.id, name: names[0] }];
  }
  return names.map((name) => ({ name }));
});

const resolveRouteId = (value: unknown) => (Array.isArray(value) ? value[0] : value);

const resolveNumericId = (value?: string | number) => {
  if (value === undefined || value === null) return null;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
};

const isSameRoute = (name: string, id: string | number) => {
  const routeId = resolveRouteId(route.params.id);
  return route.name === name && String(routeId) === String(id);
};

const albumDetailId = computed(() => resolveNumericId(songAlbumId.value));
const hasAlbumDetail = computed(() => {
  if (!albumDetailId.value) return false;
  return Boolean(songAlbum.value.trim());
});

const isArtistClickable = (artist: SongArtist) => {
  if (props.disableLinks) return false;
  const artistId = resolveNumericId(artist.id);
  if (!artistId) return false;
  return !isSameRoute('artist-detail', artistId);
};

const isAlbumClickable = computed(() => {
  if (props.disableLinks) return false;
  const albumId = albumDetailId.value;
  if (!albumId || !hasAlbumDetail.value) return false;
  return !isSameRoute('album-detail', albumId);
});

const goToArtist = (artist: SongArtist) => {
  const artistId = resolveNumericId(artist.id);
  if (!artistId || isSameRoute('artist-detail', artistId)) return;
  router.push({
    name: 'artist-detail',
    params: { id: String(artistId) },
  });
};

const goToAlbum = () => {
  const albumId = albumDetailId.value;
  if (!albumId || !hasAlbumDetail.value || isSameRoute('album-detail', albumId)) return;
  router.push({
    name: 'album-detail',
    params: { id: String(albumId) },
  });
};

const goToSongDetail = () => {
  const commentId =
    resolveNumericId(songMixSongId.value) ?? resolveNumericId(songId.value) ?? songId.value;
  router.push({
    name: 'song-detail',
    params: { id: String(commentId) },
    query: {
      mainTab: 'detail',
      type: 'music',
      title: songTitle.value,
      artist: songArtistText.value,
      artistId: songArtists.value?.[0]?.id ?? '',
      album: songAlbum.value,
      cover: songCoverUrl.value,
      albumId: songAlbumId.value ?? '',
      hash: songHash.value,
      mixSongId: songMixSongId.value,
    },
  });
};

const hasMv = computed(() => Boolean(songAlbumAudioId.value));

const goToMvDetail = () => {
  const mvHash = String(songMvHash.value ?? '').trim();
  const albumAudioId = songAlbumAudioId.value;
  if (!albumAudioId) return;
  router.push({
    name: 'mv-detail',
    params: { id: String(albumAudioId) },
    query: {
      hash: mvHash,
      albumAudioId,
      title: songTitle.value,
      artist: songArtistText.value,
      cover: songCoverUrl.value,
      album: songAlbum.value,
      songId: songId.value,
      mixSongId: songMixSongId.value,
      from: router.currentRoute.value.fullPath,
    },
  });
};

const handleQueueAndPlayCurrentSong = async (payload = songPayload.value) => {
  if (!isPlayable.value) return false;
  if ((props.queueContext?.length ?? 0) > 0 && props.queueOptions?.queueId) {
    return playSongInContext(
      playlistStore,
      playerStore,
      payload,
      props.queueContext ?? [],
      props.queueFilteredInvalidCount ?? 0,
      props.queueOptions,
    );
  }
  return queueAndPlaySong(playlistStore, playerStore, payload, props.queueOptions);
};

const handleDoubleClick = async () => {
  if (!isPlayable.value) return;
  const payload = songPayload.value;

  if (props.onDoubleTapPlay) {
    await props.onDoubleTapPlay(payload);
    return;
  }

  if (props.enableDefaultDoubleTapPlay) {
    await handleQueueAndPlayCurrentSong(payload);
    return;
  }

  await handleQueueAndPlayCurrentSong(payload);
};

const handleCoverPlay = async () => {
  const payload = songPayload.value;
  if (props.onCoverPlay) {
    await props.onCoverPlay(payload);
    return;
  }
  if (!isPlayable.value) return;
  await handleQueueAndPlayCurrentSong(payload);
};

const handleFavorite = () => {
  const payload = songPayload.value;
  if (isFavorite.value) {
    void playlistStore.removeFavoriteSong(payload);
    return;
  }

  void playlistStore.addToFavorites(payload);
};
</script>

<template>
  <div :class="[baseClass, props.class]" @dblclick="handleDoubleClick">
    <!-- 封面 -->
    <div
      v-if="showCover"
      class="song-cover-frame relative w-[46px] h-[46px] shrink-0 rounded-[12px] shadow-sm"
      :class="{ 'has-cover-play': showCoverPlayButton }"
      :style="{ opacity: contentOpacity }"
    >
      <Cover :url="songCoverUrl" :size="160" :borderRadius="12" class="w-full h-full" />
      <Button
        v-if="showCoverPlayButton"
        variant="unstyled"
        size="none"
        class="song-cover-play"
        title="播放"
        @click.stop="handleCoverPlay"
        @dblclick.stop
      >
        <Icon :icon="iconPlay" width="14" height="14" />
      </Button>
    </div>

    <!-- 信息 -->
    <div
      class="song-content flex-1 min-w-0 flex flex-col gap-0.5"
      :style="{ opacity: contentOpacity }"
    >
      <div class="song-title-row flex items-center min-w-0 gap-1.5">
        <h3
          class="song-title text-[13px] font-semibold truncate"
          :class="props.active ? 'text-primary' : 'text-text-main'"
        >
          {{ songTitle }}
        </h3>
        <Tag v-for="tag in privilegeTags" :key="tag.label" class="song-tag" :color="tag.color">
          {{ tag.label }}
        </Tag>
        <Tag v-if="qualityTag && showQuality" class="song-tag" color="#06B6D4">
          {{ qualityTag }}
        </Tag>
        <Tag v-if="songIsOriginal" class="song-tag" color="#F59E0B"> 原唱 </Tag>
      </div>
      <div
        class="song-subline text-[12px] flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap"
        :class="props.active ? 'text-primary/70' : 'text-text-secondary'"
      >
        <span class="song-artist-list">
          <span
            v-for="(artistItem, index) in artistList"
            :key="`${artistItem.name}-${index}`"
            :class="isArtistClickable(artistItem) ? 'song-artist song-link' : 'song-artist'"
            @click.stop="isArtistClickable(artistItem) && goToArtist(artistItem)"
          >
            {{ artistItem.name }}
            <span v-if="index < artistList.length - 1" class="mx-1 opacity-50">/</span>
          </span>
        </span>
        <Button
          variant="unstyled"
          size="none"
          v-if="showAlbum && songAlbum"
          type="button"
          :class="isAlbumClickable ? 'song-album song-link opacity-60' : 'song-album opacity-60'"
          @click.stop="isAlbumClickable && goToAlbum()"
        >
          • {{ songAlbum }}
        </Button>
      </div>
    </div>

    <!-- 详情及评论 / 收藏 -->
    <div v-if="showMore" class="song-actions ml-3 mr-[10px]" @click.stop>
      <Button
        v-if="hasMv"
        variant="unstyled"
        size="none"
        type="button"
        class="song-action song-action-hover-only"
        title="播放 MV"
        @click.stop="goToMvDetail"
      >
        <MvIcon class="w-4 h-4" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="song-action song-action-hover-only"
        title="详情及评论"
        @click.stop="goToSongDetail"
      >
        <Icon :icon="iconMessageCircle" width="16" height="16" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="song-action song-action-favorite"
        :class="{ 'is-active': isFavorite }"
        :title="isFavorite ? '已收藏' : '收藏'"
        :aria-pressed="isFavorite"
        @click.stop="handleFavorite"
      >
        <Icon
          :icon="isFavorite ? iconHeartFilled : iconHeart"
          width="16"
          height="16"
          class="text-red-500"
        />
      </Button>
    </div>

    <!-- 时长 -->
    <div
      v-if="showDuration && songDuration"
      class="text-[11px] text-text-secondary opacity-60 px-2 group-hover:opacity-80 transition-opacity"
    >
      {{ formatDuration(songDuration) }}
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.song-card {
  user-select: none;
}

.song-card-surface:hover {
  background: var(--row-hover-bg);
}

.song-cover-frame {
  overflow: hidden;
}

.song-cover-frame.has-cover-play::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
  background: rgba(0, 0, 0, 0.36);
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}

.song-card:hover .song-cover-frame.has-cover-play::after,
.song-card:focus-within .song-cover-frame.has-cover-play::after {
  opacity: 1;
}

.song-cover-play {
  position: absolute;
  inset: 0;
  z-index: 2;
  margin: auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: transparent;
  opacity: 0;
  transform: scale(0.92);
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
}

.song-card:hover .song-cover-play,
.song-card:focus-within .song-cover-play {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

.song-cover-play:hover {
  background: transparent;
  transform: scale(1.08);
}

.song-card .song-title {
  color: var(--color-text-main);
  letter-spacing: -0.2px;
}

.song-card .song-title.text-primary {
  color: var(--color-primary);
}

.song-card .song-subline {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.song-card .song-subline.text-primary\/70 {
  color: color-mix(in srgb, var(--color-primary) 70%, transparent);
}

.song-content {
  min-width: 0;
}

.song-tag {
  margin-left: 4px;
  flex-shrink: 0;
}

.song-artist {
  white-space: nowrap;
  display: inline;
}

.song-subline {
  flex-wrap: nowrap;
}

.song-artist-list {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-subline .song-artist {
  max-width: none;
}

.song-album {
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-link {
  cursor: pointer;
}

.song-link:hover {
  color: var(--primary);
}

.song-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 1;
}

.song-action-hover-only {
  opacity: 0;
  transition:
    opacity 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease;
}

.song-card:hover .song-action-hover-only {
  opacity: 1;
}

.song-action {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.2s ease;
}

.song-action:hover {
  color: var(--primary);
  transform: scale(1.12);
}

.song-action.is-active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.song-action-favorite {
  color: #ef4444;
  background: transparent;
}

.song-action-favorite:hover {
  color: #dc2626;
  background: transparent;
}

.song-action-favorite.is-active {
  color: #ef4444;
  background: transparent;
}

.song-action-favorite.is-active:hover {
  background: transparent;
}

:deep(.song-context-menu) {
  min-width: 172px;
  padding: 6px;
  border-radius: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-elevated);
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 1200;
}

:deep(.song-context-item) {
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-main);
  transition: all 0.2s ease;
}

:deep(.song-context-item:hover) {
  background-color: var(--row-hover-bg);
  color: var(--color-primary);
}

:deep(.song-context-separator) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 4px 6px;
}

.song-title-row {
  min-width: 0;
  flex-wrap: nowrap;
}

.song-title {
  flex: 0 1 auto;
  min-width: 0;
}

.song-tag {
  margin-left: 0;
}
</style>
