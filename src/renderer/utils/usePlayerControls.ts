import { computed, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { usePlayerStore } from '@/stores/player';
import {
  usePlaylistStore,
  PERSONAL_FM_QUEUE_ID,
  MANUAL_PLAYBACK_QUEUE_ID,
} from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { Song } from '@/models/song';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '@/types';
import { hasSongQuality, isSameSong, resolveEffectiveSongQuality } from '@/utils/song';
import {
  iconRepeat,
  iconRepeatOff,
  iconShuffle,
  iconListRestart,
  iconVolume2,
  iconVolume1,
  iconVolumeX,
} from '@/icons';

export function usePlayerControls() {
  const router = useRouter();
  const route = useRoute();
  const player = usePlayerStore();
  const playlist = usePlaylistStore();
  const settingStore = useSettingStore();
  const desktopLyricStore = useDesktopLyricStore();
  const userStore = useUserStore();
  const toastStore = useToastStore();

  const isQueueDrawerOpen = ref(false);
  const lastVolume = ref(0.8);
  const currentPlaybackQueue = computed(
    () =>
      playlist.getQueueById(player.currentSourceQueueId) ??
      playlist.activeQueue ??
      playlist.customPlaybackQueue ??
      null,
  );

  // ── 当前曲目 ──
  const currentTrack = computed<Song | undefined>(() => {
    const currentId = String(player.currentTrackId ?? '');
    if (!currentId) return undefined;
    return (
      player.currentTrackSnapshot ||
      (currentPlaybackQueue.value?.songs ?? []).find((s) => String(s.id) === currentId) ||
      playlist.defaultList.find((s) => String(s.id) === currentId) ||
      playlist.favorites.find((s) => String(s.id) === currentId) ||
      undefined
    );
  });

  // ── 收藏 ──
  const isFavorite = computed(() =>
    currentTrack.value
      ? playlist.favorites.some(
          (s) => isSameSong(s, currentTrack.value as Song) || s.id === currentTrack.value?.id,
        )
      : false,
  );

  const toggleFavorite = () => {
    if (!currentTrack.value) return;
    if (isFavorite.value) {
      playlist.removeFavoriteSong(currentTrack.value);
    } else {
      playlist.addToFavorites(currentTrack.value);
    }
  };

  // ── 播放模式 ──
  const playModeLabel = computed(() => {
    const labels: Record<PlayMode, string> = {
      sequential: '顺序播放',
      list: '列表循环',
      random: '随机播放',
      single: '单曲循环',
    };
    return labels[player.playMode] ?? '顺序播放';
  });

  const playModeIcon = computed(() => {
    if (player.playMode === 'sequential') return iconRepeatOff;
    if (player.playMode === 'list') return iconRepeat;
    if (player.playMode === 'random') return iconShuffle;
    return iconListRestart;
  });

  const cyclePlayMode = () => {
    const next: PlayMode =
      player.playMode === 'sequential'
        ? 'list'
        : player.playMode === 'list'
          ? 'random'
          : player.playMode === 'random'
            ? 'single'
            : 'sequential';
    player.setPlayMode(next);
  };

  // ── 音量 ──
  const volumeIcon = computed(() => {
    if (player.volume > 0.5) return iconVolume2;
    if (player.volume > 0) return iconVolume1;
    return iconVolumeX;
  });

  const handleVolumeChange = (value: number[] | undefined) => {
    if (!value?.length) return;
    player.setVolume(value[0] / 100);
  };

  const toggleMute = () => {
    if (player.volume > 0) {
      lastVolume.value = player.volume;
      player.setVolume(0);
    } else {
      player.setVolume(lastVolume.value || 0.8);
    }
  };

  // ── 倍速 ──
  const playbackRateDisplay = computed(() => {
    const r = player.playbackRate;
    if (r === Math.floor(r)) return `${r.toFixed(1)}x`;
    return `${r.toFixed(2).replace(/0$/, '')}x`;
  });

  const handlePlaybackRateSlider = (value: number[] | undefined) => {
    if (!value) return;
    const rate = Math.round(value[0] ?? 10) / 10;
    player.setPlaybackRate(rate);
  };

  const resetPlaybackRate = () => {
    player.setPlaybackRate(1);
  };

  const setPlaybackRate = (rate: number) => {
    if (player.playbackRate === rate) return;
    player.setPlaybackRate(rate);
  };

  // ── 音质 ──
  const requestedAudioQuality = computed(() => player.getEffectiveAudioQuality(settingStore));
  const effectiveAudioQuality = computed(() => {
    if (player.currentResolvedAudioQuality) return player.currentResolvedAudioQuality;
    if (!currentTrack.value) return requestedAudioQuality.value;
    return resolveEffectiveSongQuality(
      currentTrack.value,
      requestedAudioQuality.value,
      settingStore.compatibilityMode ?? true,
    );
  });

  const isAudioQualityDisabled = (quality: AudioQualityValue) => {
    if (quality === effectiveAudioQuality.value) return false;
    if (!currentTrack.value) return quality !== '128';
    return !hasSongQuality(currentTrack.value, quality);
  };

  const audioQualityButtonBadge = computed(() => {
    if (player.currentResolvedAudioEffect !== 'none') return 'FX';
    if (effectiveAudioQuality.value === '128') return 'SD';
    if (effectiveAudioQuality.value === '320') return 'HQ';
    if (effectiveAudioQuality.value === 'flac') return 'SQ';
    return 'HR';
  });

  const currentAudioQualityBadgeColor = computed(() =>
    player.currentResolvedAudioEffect !== 'none'
      ? '#10B981'
      : getAudioQualityTagColor(effectiveAudioQuality.value),
  );

  const getAudioQualityTagColor = (quality: AudioQualityValue) => {
    if (quality === '128') return '#64748B';
    if (quality === '320') return '#8B5CF6';
    if (quality === 'flac') return '#2563EB';
    return '#F59E0B';
  };

  const setAudioQuality = (quality: AudioQualityValue) => {
    if (player.currentAudioQualityOverride === null && effectiveAudioQuality.value === quality)
      return;
    if (player.currentAudioQualityOverride === quality) return;
    player.setCurrentAudioQualityOverride(quality);
  };

  const setAudioEffect = (effect: AudioEffectValue) => {
    if (player.audioEffect === effect) return;
    player.setAudioEffect(effect);
  };

  // ── 桌面歌词 ──
  const toggleDesktopLyric = async () => {
    await desktopLyricStore.setEnabled(!desktopLyricStore.settings.enabled);
  };

  // ── 导航 ──
  const resolveNumericId = (value: unknown) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isNaN(parsed) || parsed <= 0) return null;
    return parsed;
  };

  const goToComments = () => {
    if (!currentTrack.value) return;
    const track = currentTrack.value;
    router.push({
      name: 'comment',
      params: { id: track.mixSongId ? String(track.mixSongId) : String(track.id) },
      query: {
        mainTab: 'detail',
        type: 'music',
        title: track.title,
        artist: track.artist,
        artistId: track.artists?.[0]?.id ?? '',
        album: track.album ?? '',
        cover: track.coverUrl ?? '',
        albumId: track.albumId ?? '',
        hash: track.hash ?? '',
        mixSongId: track.mixSongId ?? '',
      },
    });
  };

  const goToMv = async () => {
    const track = currentTrack.value;
    const mvHash = String(track?.mvHash ?? '').trim();
    if (!track || !mvHash) return;
    if (player.isPlaying) {
      await player.togglePlay();
    }
    router.push({
      name: 'mv-detail',
      params: { id: mvHash },
      query: {
        hash: mvHash,
        albumAudioId: track.mixSongId ?? track.id,
        title: track.title,
        artist: track.artist,
        cover: track.coverUrl ?? '',
        album: track.album ?? '',
        songId: track.id,
        mixSongId: track.mixSongId ?? '',
        from: route.fullPath,
      },
    });
  };

  // ── 队列 ──
  const queueCount = computed(() => currentPlaybackQueue.value?.songs.length ?? 0);

  const openQueue = () => {
    isQueueDrawerOpen.value = true;
  };

  // ── 添加到歌单 ──
  const showAddToPlaylistDialog = ref(false);
  const isPlaylistLoading = ref(false);

  const canAddToPlaylist = computed(() => userStore.isLoggedIn && !!currentTrack.value);

  const createdPlaylists = computed(() => playlist.getCreatedPlaylists(userStore.info?.userid));

  const addToPlaybackQueues = computed(() =>
    playlist.playbackQueueList.filter(
      (queue) => queue.id !== PERSONAL_FM_QUEUE_ID && queue.songs.length > 0,
    ),
  );

  const handleOpenAddToPlaylist = async () => {
    if (!canAddToPlaylist.value) return;
    showAddToPlaylistDialog.value = true;
    if (playlist.userPlaylists.length === 0) {
      isPlaylistLoading.value = true;
      try {
        await playlist.fetchUserPlaylists();
      } catch {
        toastStore.loadFailed('歌单');
      }
      isPlaylistLoading.value = false;
    }
  };

  const handleAddToQueue = (queueId?: string) => {
    if (!currentTrack.value) return;
    const options = queueId ? { queueId } : {};
    const addedCount = playlist.appendToPlaybackQueue?.([currentTrack.value], options) ?? 0;
    if (addedCount > 0) {
      toastStore.actionCompleted(
        queueId === MANUAL_PLAYBACK_QUEUE_ID ? '已添加到我的队列' : '已添加到队列',
      );
    } else {
      toastStore.actionCompleted(
        queueId === MANUAL_PLAYBACK_QUEUE_ID ? '歌曲已在我的队列中' : '歌曲已在队列中',
      );
    }
    showAddToPlaylistDialog.value = false;
  };

  const handleSelectPlaylist = async (listId: string | number) => {
    if (!currentTrack.value) return;
    try {
      await playlist.addToPlaylist(String(listId), currentTrack.value);
      toastStore.actionCompleted('已添加到歌单');
      showAddToPlaylistDialog.value = false;
    } catch {
      toastStore.actionFailed('添加到歌单');
    }
  };

  return {
    player,
    playlist,
    settingStore,
    desktopLyricStore,
    currentTrack,
    // 收藏
    isFavorite,
    toggleFavorite,
    // 播放模式
    playModeLabel,
    playModeIcon,
    cyclePlayMode,
    // 音量
    volumeIcon,
    lastVolume,
    handleVolumeChange,
    toggleMute,
    // 倍速
    playbackRateDisplay,
    handlePlaybackRateSlider,
    resetPlaybackRate,
    setPlaybackRate,
    // 音质
    effectiveAudioQuality,
    isAudioQualityDisabled,
    audioQualityButtonBadge,
    currentAudioQualityBadgeColor,
    getAudioQualityTagColor,
    setAudioQuality,
    setAudioEffect,
    // 桌面歌词
    toggleDesktopLyric,
    // 导航
    resolveNumericId,
    goToComments,
    goToMv,
    // 队列
    queueCount,
    isQueueDrawerOpen,
    openQueue,
    // 添加到歌单
    showAddToPlaylistDialog,
    isPlaylistLoading,
    canAddToPlaylist,
    createdPlaylists,
    addToPlaybackQueues,
    handleOpenAddToPlaylist,
    handleAddToQueue,
    handleSelectPlaylist,
  };
}
