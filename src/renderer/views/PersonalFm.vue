<script setup lang="ts">
defineOptions({ name: 'personal-fm' });
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PERSONAL_FM_QUEUE_ID,
  getPersonalFmModePresentation,
  getPersonalFmSongPoolPresentation,
  usePlaylistStore,
} from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { iconHeartFilled, iconHeartOff, iconPause, iconPlay } from '@/icons';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import { replaceQueueAndPlay } from '@/utils/playback';
import { getSongQualityTags } from '@/utils/song';
import type { PersonalFmMode, PersonalFmSongPoolId } from '@/stores/playlist';
import type { Song } from '@/models/song';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const userStore = useUserStore();
const personalFmLoading = ref(false);
const personalFmVinylsRef = ref<HTMLElement | null>(null);
const personalFmVisibleSideCount = ref(3);
let personalFmVinylsObserver: ResizeObserver | null = null;

const personalFmModeOptions: Array<{ value: PersonalFmMode; label: string }> = [
  { value: 'normal', label: '红心' },
  { value: 'small', label: '小众' },
  { value: 'peak', label: '速览' },
];

const personalFmSongPoolOptions: Array<{ value: PersonalFmSongPoolId; label: string }> = [
  { value: 0, label: '根据口味' },
  { value: 1, label: '根据风格' },
  { value: 2, label: '探索' },
];

const personalFmQueue = computed(
  () => playlistStore.playbackQueues.find((queue) => queue.id === PERSONAL_FM_QUEUE_ID) ?? null,
);
const isLoggedIn = computed(() => userStore.isLoggedIn);
const personalFmCurrentTrack = computed(() => playlistStore.getPersonalFmPreviewTrack());
const isPersonalFmActive = computed(() => playlistStore.activeQueueId === PERSONAL_FM_QUEUE_ID);
const personalFmQueueCurrentTrackId = computed(() =>
  String(personalFmQueue.value?.currentTrackId ?? ''),
);
const isPersonalFmCurrentTrackActive = computed(() => {
  const queueTrackId = personalFmQueueCurrentTrackId.value;
  if (!queueTrackId) return false;
  return (
    playerStore.currentSourceQueueId === PERSONAL_FM_QUEUE_ID &&
    String(playerStore.currentTrackId ?? '') === queueTrackId
  );
});
const isPersonalFmPlaying = computed(
  () => isPersonalFmCurrentTrackActive.value && playerStore.isPlaying,
);
const personalFmDisplayTracks = computed(() => playlistStore.getPersonalFmDisplayTracks(5));
const personalFmNowPlayingTrack = computed(() => {
  const queue = personalFmQueue.value;
  const queueCurrentTrackId = String(queue?.currentTrackId ?? '');
  if (queue && queueCurrentTrackId) {
    return (
      queue.songs.find((song) => String(song.id) === queueCurrentTrackId) ??
      personalFmCurrentTrack.value
    );
  }
  return personalFmCurrentTrack.value;
});
const personalFmCurrentDisc = computed(
  () => personalFmNowPlayingTrack.value ?? personalFmCurrentTrack.value,
);
const personalFmSideTracks = computed(() => {
  const currentId = String(personalFmCurrentDisc.value?.id ?? '');
  return personalFmDisplayTracks.value
    .filter((track) => String(track.id) !== currentId)
    .slice(0, 3);
});
const personalFmVisibleSideTracks = computed(() =>
  personalFmSideTracks.value.slice(0, personalFmVisibleSideCount.value),
);
const selectedPersonalFmMode = computed(() => playlistStore.personalFmMode);
const selectedPersonalFmSongPoolId = computed(() => playlistStore.personalFmSongPoolId);
const personalFmPresentation = computed(() =>
  getPersonalFmModePresentation(selectedPersonalFmMode.value),
);
const personalFmSongPoolPresentation = computed(() =>
  getPersonalFmSongPoolPresentation(selectedPersonalFmSongPoolId.value),
);
const personalFmCurrentTrackCapsuleLabel = computed(
  () => `${personalFmPresentation.value.title} 实时推荐`,
);
const personalFmCurrentTrackReason = computed(() => {
  const track = personalFmCurrentDisc.value;
  if (!track) return '';
  return track.recDesc || `${personalFmPresentation.value.title} 实时推荐`;
});
const personalFmCurrentTrackAlbum = computed(() => {
  const track = personalFmCurrentDisc.value;
  return String(track?.albumName ?? track?.album ?? '').trim();
});
const personalFmCurrentTrackInfoChips = computed(() => {
  const track = personalFmCurrentDisc.value;
  if (!track) return [];

  const chips: string[] = [];
  const duration =
    track.duration > 0
      ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}`
      : '';
  const quality = getSongQualityTags(track.relateGoods).at(-1) ?? '';

  if (duration) chips.push(duration);
  if (quality) chips.push(quality);
  if (track.language) chips.push(track.language);
  if (track.similarDesc) chips.push(`相似度${track.similarDesc}`);

  return chips.slice(0, 4);
});

const updatePersonalFmVisibleSideCount = () => {
  const element = personalFmVinylsRef.value;
  if (!element) {
    personalFmVisibleSideCount.value = 3;
    return;
  }

  const reservedWidth = 92;
  const gap = 28;
  const discWidths = [186, 168, 168];
  const availableWidth = Math.max(0, element.clientWidth - reservedWidth + 18);

  let count = 0;
  let usedWidth = 0;

  for (const [index, width] of discWidths.entries()) {
    const nextWidth = width + (index > 0 ? gap : 0);
    if (usedWidth + nextWidth > availableWidth && count > 0) break;
    if (usedWidth + nextWidth > availableWidth && count === 0) {
      count = 1;
      break;
    }
    usedWidth += nextWidth;
    count += 1;
  }

  personalFmVisibleSideCount.value = Math.max(1, Math.min(discWidths.length, count || 1));
};

const playCurrentPersonalFm = async () => {
  const queue = playlistStore.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
  if (!queue) return;
  const targetSong = await playlistStore.consumeNextPersonalFmTrack({
    playtime: 0,
    isOverplay: false,
  });
  if (!targetSong) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queue.songs, 0, targetSong, {
    queueId: PERSONAL_FM_QUEUE_ID,
    title: queue.title,
    subtitle: queue.subtitle,
    type: 'fm',
    dynamic: true,
    meta: {
      mode: selectedPersonalFmMode.value,
      song_pool_id: selectedPersonalFmSongPoolId.value,
    },
  });
  void playlistStore.ensurePersonalFmQueue({ track: targetSong, playtime: 0, isOverplay: false });
};

const resumeCurrentPersonalFm = async () => {
  const targetTrack = personalFmCurrentDisc.value ?? personalFmCurrentTrack.value;
  if (!targetTrack) return false;

  const queueSongs = playlistStore.activatePersonalFmTrack(targetTrack);
  await playerStore.playTrack(String(targetTrack.id), queueSongs, {
    sourceQueueId: PERSONAL_FM_QUEUE_ID,
  });
  void playlistStore.ensurePersonalFmQueue({
    track: targetTrack,
    playtime: 0,
    isOverplay: false,
  });
  return true;
};

const handlePlayPersonalFm = async () => {
  const resetPending = playlistStore.isPersonalFmSessionResetPending();
  if (
    isPersonalFmCurrentTrackActive.value &&
    personalFmQueue.value?.songs.length &&
    !resetPending
  ) {
    await playerStore.togglePlay();
    return;
  }
  if (personalFmLoading.value) return;
  personalFmLoading.value = true;
  try {
    if (!resetPending) {
      const resumed = await resumeCurrentPersonalFm();
      if (resumed) return;
    }

    const ready = await playlistStore.startPersonalFm({
      fresh: true,
      mode: selectedPersonalFmMode.value,
      recreate: resetPending,
      retainBuffer: resetPending,
    });
    if (!ready) return;
    await playCurrentPersonalFm();
  } finally {
    personalFmLoading.value = false;
  }
};

const handleSelectPersonalFmTrack = async (track: Song) => {
  if (personalFmLoading.value) return;

  const targetId = String(track.id ?? '');
  if (!targetId) return;

  if (isPersonalFmActive.value && String(playerStore.currentTrackId ?? '') === targetId) {
    if (!playerStore.isPlaying) {
      await playerStore.togglePlay();
    }
    return;
  }

  personalFmLoading.value = true;
  try {
    if (playlistStore.isPersonalFmSessionResetPending()) {
      const ready = await playlistStore.startPersonalFm({
        fresh: true,
        mode: selectedPersonalFmMode.value,
        recreate: true,
      });
      if (!ready) return;
      await playCurrentPersonalFm();
      return;
    }
    const queueSongs = playlistStore.activatePersonalFmTrack(track);
    await playerStore.playTrack(targetId, queueSongs, {
      sourceQueueId: PERSONAL_FM_QUEUE_ID,
    });
    void playlistStore.ensurePersonalFmQueue({ track, playtime: 0, isOverplay: false });
  } finally {
    personalFmLoading.value = false;
  }
};

const handleChangePersonalFmMode = async (mode: PersonalFmMode) => {
  if (personalFmLoading.value || mode === selectedPersonalFmMode.value) return;
  personalFmLoading.value = true;
  try {
    await playlistStore.resetPersonalFmPreview({
      mode,
      songPoolId: selectedPersonalFmSongPoolId.value,
    });
    if (isPersonalFmActive.value) {
      await playCurrentPersonalFm();
    }
  } finally {
    personalFmLoading.value = false;
  }
};

const handleChangePersonalFmSongPool = async (songPoolId: PersonalFmSongPoolId) => {
  if (personalFmLoading.value || songPoolId === selectedPersonalFmSongPoolId.value) return;
  personalFmLoading.value = true;
  try {
    await playlistStore.resetPersonalFmPreview({
      mode: selectedPersonalFmMode.value,
      songPoolId,
    });
    if (isPersonalFmActive.value) {
      await playCurrentPersonalFm();
    }
  } finally {
    personalFmLoading.value = false;
  }
};

const handleDislikePersonalFm = async () => {
  const currentTrack = personalFmNowPlayingTrack.value ?? personalFmCurrentTrack.value;
  if (personalFmLoading.value || !currentTrack) return;

  personalFmLoading.value = true;
  try {
    if (!isPersonalFmActive.value || !playerStore.currentTrackId) {
      await playlistStore.resetPersonalFmPreview({
        mode: selectedPersonalFmMode.value,
        songPoolId: selectedPersonalFmSongPoolId.value,
      });
      return;
    }

    await playlistStore.ensurePersonalFmQueue({
      track: currentTrack,
      playtime: Math.max(0, Math.floor(playerStore.currentTime || 0)),
      action: 'garbage',
      isOverplay: false,
    });

    playlistStore.removeFromQueue(currentTrack.id);
    await playCurrentPersonalFm();
  } finally {
    personalFmLoading.value = false;
  }
};

onMounted(() => {
  if (!isLoggedIn.value) return;

  const shouldFetchPreview =
    playlistStore.isPersonalFmSessionResetPending() || !personalFmCurrentTrack.value;

  if (shouldFetchPreview && !personalFmLoading.value) {
    personalFmLoading.value = true;
    void playlistStore
      .resetPersonalFmPreview({
        mode: selectedPersonalFmMode.value,
        songPoolId: selectedPersonalFmSongPoolId.value,
        preserveQueue: true,
      })
      .finally(() => {
        personalFmLoading.value = false;
      });
  }

  updatePersonalFmVisibleSideCount();
  if (typeof ResizeObserver !== 'undefined') {
    personalFmVinylsObserver = new ResizeObserver(() => {
      updatePersonalFmVisibleSideCount();
    });
    if (personalFmVinylsRef.value) {
      personalFmVinylsObserver.observe(personalFmVinylsRef.value);
    }
  }
});

onBeforeUnmount(() => {
  personalFmVinylsObserver?.disconnect();
  personalFmVinylsObserver = null;
});

onActivated(() => {
  const scrollContainer = document.querySelector('.view-port');
  if (scrollContainer) {
    scrollContainer.scrollTop = 0;
  }
});
</script>

<template>
  <div class="personal-fm-view px-10 pt-4 pb-10">
    <div class="fm-header">
      <div class="fm-page-title">私人 FM</div>
      <div class="fm-page-subtitle">实时推荐会根据你的反馈持续更新</div>
    </div>

    <section
      v-if="!isLoggedIn"
      class="fm-empty flex flex-col items-center justify-center text-center px-6"
    >
      <div
        class="w-18 h-18 rounded-[24px] bg-primary/10 text-primary flex items-center justify-center mb-5"
      >
        <Icon :icon="iconHeartFilled" width="32" height="32" />
      </div>
      <div class="text-[22px] font-semibold text-text-main">登录后查看私人 FM</div>
      <div class="text-[13px] text-text-secondary mt-2">猜你喜欢和实时推荐需要登录状态</div>
    </section>

    <section v-else class="fm-shell">
      <div class="fm-toolbar">
        <div class="fm-toolbar-group">
          <div class="fm-toolbar-label">推荐方式</div>
          <div class="radio-strategy-switch outside">
            <button
              v-for="option in personalFmSongPoolOptions"
              :key="option.value"
              type="button"
              class="radio-strategy-btn"
              :class="{ 'is-active': option.value === selectedPersonalFmSongPoolId }"
              :disabled="personalFmLoading"
              @click="handleChangePersonalFmSongPool(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="fm-toolbar-note">
          {{ personalFmPresentation.title }} · {{ personalFmSongPoolPresentation.label }}
        </div>
      </div>

      <div class="radio-hero">
        <div class="radio-card">
          <div class="radio-mode-switch">
            <button
              v-for="option in personalFmModeOptions"
              :key="option.value"
              type="button"
              class="radio-mode-btn"
              :class="{ 'is-active': option.value === selectedPersonalFmMode }"
              :disabled="personalFmLoading"
              @click="handleChangePersonalFmMode(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <div class="radio-title">{{ personalFmPresentation.title }}</div>
          <div class="radio-subtitle">
            {{
              personalFmCurrentDisc
                ? `${personalFmCurrentDisc.title} · ${personalFmCurrentDisc.artist}`
                : `${personalFmPresentation.subtitle} · ${personalFmSongPoolPresentation.label}`
            }}
          </div>
          <div class="radio-footer">
            <div class="radio-bars" aria-hidden="true">
              <span v-for="index in 10" :key="index"></span>
            </div>
            <div class="radio-actions">
              <Button
                variant="unstyled"
                size="none"
                class="radio-dislike"
                :disabled="personalFmLoading || !personalFmCurrentDisc"
                @click="handleDislikePersonalFm"
              >
                <Icon :icon="iconHeartOff" width="16" height="16" />
              </Button>
              <Button
                variant="unstyled"
                size="none"
                class="radio-play"
                :class="{ 'is-loading': personalFmLoading }"
                :aria-busy="personalFmLoading"
                @click="handlePlayPersonalFm"
              >
                <span v-if="personalFmLoading" class="radio-play-spinner" aria-hidden="true"></span>
                <Icon
                  v-else
                  :icon="isPersonalFmPlaying ? iconPause : iconPlay"
                  width="18"
                  height="18"
                />
              </Button>
            </div>
          </div>
        </div>
        <div v-if="personalFmCurrentDisc" class="radio-current-disc">
          <button
            type="button"
            class="radio-vinyl radio-vinyl-current"
            :title="`${isPersonalFmPlaying ? '暂停' : '播放'} ${personalFmCurrentDisc.title}`"
            @click="handlePlayPersonalFm"
          >
            <div class="radio-vinyl-core" :class="{ 'is-spinning': isPersonalFmPlaying }">
              <Cover
                :url="personalFmCurrentDisc.coverUrl"
                :size="320"
                :borderRadius="'50%'"
                class="w-full h-full"
              />
            </div>
          </button>
        </div>
        <div ref="personalFmVinylsRef" class="radio-vinyls">
          <button
            v-for="(track, index) in personalFmVisibleSideTracks"
            :key="`${track.id}:${track.hash ?? ''}:${index}`"
            type="button"
            class="radio-vinyl"
            :class="[`radio-vinyl-${index + 1}`]"
            :title="`播放 ${track.title} · ${track.artist}`"
            @click="handleSelectPersonalFmTrack(track)"
          >
            <Cover :url="track.coverUrl" :size="320" :borderRadius="'50%'" class="w-full h-full" />
          </button>
        </div>
      </div>

      <section class="fm-panel fm-now-panel">
        <div class="fm-panel-header">
          <div class="fm-panel-title">当前播放</div>
          <div v-if="personalFmCurrentDisc" class="fm-now-capsule">
            {{ personalFmCurrentTrackCapsuleLabel }}
          </div>
        </div>
        <div v-if="personalFmCurrentDisc" class="fm-now-card">
          <Cover
            :url="personalFmCurrentDisc.coverUrl"
            :size="240"
            :borderRadius="20"
            class="fm-now-cover"
          />
          <div class="fm-now-body">
            <div class="fm-now-heading">
              <div class="fm-now-name">{{ personalFmCurrentDisc.title }}</div>
              <div class="fm-now-artist">{{ personalFmCurrentDisc.artist }}</div>
            </div>
            <div v-if="personalFmCurrentTrackAlbum" class="fm-now-album">
              {{ personalFmCurrentTrackAlbum }}
            </div>
            <div class="fm-now-reason">{{ personalFmCurrentTrackReason }}</div>
            <div v-if="personalFmCurrentTrackInfoChips.length" class="fm-now-info-chips">
              <span
                v-for="item in personalFmCurrentTrackInfoChips"
                :key="item"
                class="fm-now-info-chip"
              >
                {{ item }}
              </span>
            </div>
          </div>
        </div>
        <div v-else class="fm-panel-empty">
          {{ personalFmLoading ? '正在获取推荐内容...' : '暂时没有可展示的推荐内容。' }}
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.personal-fm-view {
  animation: fade-in 0.45s ease-out;
}

.fm-header {
  margin-bottom: 20px;
}

.fm-page-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.04em;
  color: var(--color-text-main);
}

.fm-page-subtitle {
  margin-top: 6px;
  font-size: 13px;
  color: color-mix(in srgb, var(--color-text-main) 58%, transparent);
  max-width: 520px;
}

.fm-shell {
  margin-top: 8px;
  overflow-anchor: none;
}

.fm-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
  padding: 14px 16px;
  border-radius: 20px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-text-main) 2.5%, transparent),
      transparent
    ),
    var(--color-bg-main);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.fm-toolbar-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fm-toolbar-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--color-text-main) 54%, transparent);
  text-transform: uppercase;
}

.fm-toolbar-note {
  font-size: 13px;
  color: color-mix(in srgb, var(--color-text-main) 64%, transparent);
  white-space: nowrap;
}

.fm-empty {
  min-height: 420px;
}

.radio-hero {
  position: relative;
  --radio-card-size: 248px;
  --radio-current-size: 176px;
  --radio-current-overlap: 88px;
  display: grid;
  grid-template-columns: var(--radio-card-size) minmax(0, 1fr);
  align-items: center;
  gap: 24px;
  width: 100%;
  min-height: 220px;
  overflow: visible;
}

.radio-card {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 174px;
  width: 100%;
  aspect-ratio: 1 / 1;
  padding: 16px;
  border-radius: 22px;
  overflow: hidden;
  background:
    radial-gradient(circle at 16% 18%, rgba(112, 213, 255, 0.24), transparent 30%),
    linear-gradient(160deg, #0d3951 0%, #0f5a7a 56%, #0b1620 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 18px 34px rgba(5, 12, 20, 0.18),
    0 26px 50px rgba(8, 24, 38, 0.14);
}

.radio-mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  padding: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(10px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.radio-mode-btn {
  min-width: 52px;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.74);
  transition: all 0.2s ease;
}

.radio-mode-btn.is-active {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
  box-shadow: 0 8px 18px rgba(8, 24, 38, 0.18);
}

.radio-title {
  margin-top: 12px;
  color: #fff;
  font-size: 28px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.04em;
  text-shadow: 0 1px 12px rgba(5, 12, 20, 0.14);
}

.radio-strategy-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  padding: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-main) 3%, var(--color-bg-sidebar));
}

.radio-strategy-switch.outside {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-text-main) 1.8%, transparent),
      transparent
    ),
    var(--color-bg-sidebar);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 10px 24px rgba(15, 23, 42, 0.06);
}

.radio-strategy-btn {
  min-width: 88px;
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  color: color-mix(in srgb, var(--color-text-main) 62%, transparent);
  transition: all 0.2s ease;
}

.radio-strategy-btn.is-active {
  background: linear-gradient(135deg, #0d8fff, #2fb4ff);
  color: #fff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.24),
    0 10px 20px rgba(13, 143, 255, 0.22);
}

.radio-subtitle {
  margin-top: 10px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.radio-footer {
  margin-top: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.radio-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.radio-dislike {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(10px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.radio-bars {
  display: flex;
  align-items: end;
  gap: 6px;
  flex: 1;
}

.radio-bars span {
  width: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.4);
}

.radio-bars span:nth-child(1) {
  height: 11px;
}
.radio-bars span:nth-child(2) {
  height: 17px;
}
.radio-bars span:nth-child(3) {
  height: 8px;
}
.radio-bars span:nth-child(4) {
  height: 19px;
}
.radio-bars span:nth-child(5) {
  height: 13px;
}
.radio-bars span:nth-child(6) {
  height: 18px;
}
.radio-bars span:nth-child(7) {
  height: 9px;
}
.radio-bars span:nth-child(8) {
  height: 14px;
}
.radio-bars span:nth-child(9) {
  height: 8px;
}
.radio-bars span:nth-child(10) {
  height: 15px;
}

.radio-play {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0d8fff, #2fb4ff);
  color: #fff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 14px 30px rgba(2, 118, 198, 0.35);
}

.radio-play.is-loading {
  cursor: default;
}

.radio-play-spinner {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: rgba(255, 255, 255, 0.98);
  animation: radio-play-spin 0.75s linear infinite;
}

.radio-vinyls {
  position: relative;
  min-height: 188px;
  display: flex;
  align-items: center;
  gap: 28px;
  padding-left: 112px;
  overflow: visible;
}

.radio-current-disc {
  position: absolute;
  top: 50%;
  left: calc(var(--radio-card-size) - var(--radio-current-overlap));
  width: var(--radio-current-size);
  height: var(--radio-current-size);
  transform: translateY(-50%);
  z-index: 1;
}

.radio-vinyl {
  position: relative;
  width: 176px;
  height: 176px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  box-shadow: 0 26px 40px rgba(5, 12, 20, 0.32);
  background:
    radial-gradient(
      circle at center,
      rgba(0, 0, 0, 0.26) 0 14%,
      rgba(255, 255, 255, 0.05) 15%,
      transparent 16%
    ),
    linear-gradient(135deg, rgba(255, 179, 122, 0.68), rgba(51, 21, 39, 0.96));
  z-index: 1;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.radio-vinyl:hover {
  transform: translateY(-2px);
  box-shadow: 0 30px 44px rgba(5, 12, 20, 0.38);
}

.radio-vinyl :deep(.cover-container),
.radio-vinyl :deep(img) {
  width: 100%;
  height: 100%;
}

.radio-vinyl::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 8px rgba(72, 46, 53, 0.82),
    inset 0 0 0 9px rgba(255, 255, 255, 0.06);
  pointer-events: none;
  z-index: 2;
}

.radio-vinyl-current {
  position: relative;
  width: var(--radio-current-size);
  height: var(--radio-current-size);
}

.radio-vinyl-core {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
}

.radio-vinyl-core.is-spinning {
  animation: radio-vinyl-spin 8s linear infinite;
}

.fm-panel {
  border-radius: 24px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 7%, transparent);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-text-main) 2.2%, transparent),
      transparent
    ),
    var(--color-bg-main);
  padding: 22px;
  margin-top: 28px;
  box-shadow: 0 14px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.fm-panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-main);
  letter-spacing: -0.01em;
}

.fm-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.fm-now-card {
  display: grid;
  grid-template-columns: 180px minmax(320px, 1fr);
  align-items: center;
  gap: 28px;
  margin-top: 18px;
}

.fm-now-cover {
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 7%, transparent);
  box-shadow: 0 18px 34px rgba(15, 23, 42, 0.12);
}

.fm-now-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  min-width: 0;
  min-height: 180px;
}

.fm-now-capsule {
  display: inline-flex;
  align-items: center;
  width: auto;
  min-height: 36px;
  max-width: 100%;
  padding: 0 16px;
  border-radius: 14px;
  background: #ffffff;
  color: #1677ff;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.03em;
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08);
  white-space: nowrap;
}

.fm-now-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.fm-now-name {
  font-size: 28px;
  line-height: 1.16;
  font-weight: 700;
  color: var(--color-text-main);
  letter-spacing: -0.03em;
  word-break: break-word;
}

.fm-now-artist {
  font-size: 15px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 74%, transparent);
  word-break: break-word;
}

.fm-now-album {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: color-mix(in srgb, var(--color-text-main) 56%, transparent);
}

.fm-now-reason {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--color-primary);
  max-width: 100%;
}

.fm-now-info-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.fm-now-info-chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 6%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 2.2%, transparent);
  font-size: 12px;
  font-weight: 700;
  color: color-mix(in srgb, var(--color-text-main) 68%, transparent);
}

.fm-panel-empty {
  font-size: 13px;
  line-height: 1.6;
  color: color-mix(in srgb, var(--color-text-main) 58%, transparent);
  min-height: 180px;
  display: flex;
  align-items: center;
}

@keyframes radio-vinyl-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes radio-play-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
