import { computed, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { usePlayerStore } from '@/stores/player';
import {
  usePlaylistStore,
  LISTEN_TOGETHER_QUEUE_ID,
  PERSONAL_FM_QUEUE_ID,
  MANUAL_PLAYBACK_QUEUE_ID,
} from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { useSongQualityAccessStore, songQualityResourceKey } from '@/stores/songQualityAccess';
import { getQualityAccessReason } from '@/utils/songQualityAccess';
import type { Song } from '@/models/song';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '@/types';
import { hasSongQuality, isViperAudioQuality, resolveEffectiveSongQuality } from '@/utils/song';
import { copyShareTarget, createSongShareTarget, isSongHashId } from '@/utils/share';
import { getCloudAudioSourceForSong } from '@/services/cloudAudioIndex';
import {
  iconRepeat,
  iconRepeatOff,
  iconShuffle,
  iconListRestart,
  iconVolume2,
  iconVolume1,
  iconVolumeX,
} from '@/icons';

export const playModeOptions = [
  { value: 'sequential', label: '顺序播放', icon: iconRepeatOff },
  { value: 'list', label: '列表循环', icon: iconRepeat },
  { value: 'random', label: '随机播放', icon: iconShuffle },
  { value: 'single', label: '单曲循环', icon: iconListRestart },
] as const;

export function usePlayerControls() {
  const router = useRouter();
  const route = useRoute();
  const player = usePlayerStore();
  const playlist = usePlaylistStore();
  const settingStore = useSettingStore();
  const desktopLyricStore = useDesktopLyricStore();
  const userStore = useUserStore();
  const toastStore = useToastStore();
  const qualityAccessStore = useSongQualityAccessStore();

  const isQueueDrawerOpen = ref(false);
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
    currentTrack.value ? playlist.isFavoriteSong(currentTrack.value as Song) : false,
  );

  const toggleFavorite = () => {
    if (!currentTrack.value) return;
    if (isFavorite.value) {
      return playlist.removeFavoriteSong(currentTrack.value);
    } else {
      return playlist.addToFavorites(currentTrack.value);
    }
  };

  // ── 播放模式 ──
  const currentPlayMode = computed(
    () => playModeOptions.find((option) => option.value === player.playMode) ?? playModeOptions[0],
  );
  const playModeLabel = computed(() => currentPlayMode.value.label);
  const playModeIcon = computed(() => currentPlayMode.value.icon);

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
    if (player.volume > 50) return iconVolume2;
    if (player.volume > 0) return iconVolume1;
    return iconVolumeX;
  });

  const handleVolumeChange = (value: number[] | undefined) => {
    if (!value?.length) return;
    player.setVolume(value[0]);
  };

  const toggleMute = () => {
    player.toggleMute();
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
  const requestedAudioQuality = computed(() => player.getEffectiveAudioQuality());
  const isCurrentTrackCloud = computed(() => currentTrack.value?.source === 'cloud');
  const isResolvedCloudSource = computed(() => player.currentResolvedSourceKind === 'cloud');
  const hasCloudAudioSourceOption = computed(
    () =>
      !!currentTrack.value &&
      (isResolvedCloudSource.value ||
        isCurrentTrackCloud.value ||
        Boolean(currentTrack.value.cloudAudioSource?.hash)),
  );
  const cloudAudioSourceLookupKey = computed(() => {
    const track = currentTrack.value;
    if (!track || track.source === 'cloud' || track.cloudAudioSource?.hash) return '';
    return `${track.id}:${track.albumAudioId ?? track.mixSongId ?? ''}:${track.fileId ?? track.songId ?? ''}:${track.hash ?? ''}`;
  });
  const cloudAudioSourceLoadingKey = ref('');
  let cloudAudioSourceFetchSeq = 0;
  const isAudioEffectPresetSelectionDisabled = computed(
    () => isResolvedCloudSource.value || isAudioSourceSwitching.value,
  );
  const qualityAccessResource = computed(() => {
    const track = currentTrack.value;
    if (!track) return null;
    const hash = track.source === 'cloud' ? track.cloudAudioSource?.hashStd : track.hash;
    return hash ? { hash, albumId: track.albumId } : null;
  });
  const hasCatalogAudioSourceOption = computed(() => !!qualityAccessResource.value);
  const audioQualityAccessLookupKey = computed(() => {
    const resource = qualityAccessResource.value;
    return resource
      ? `${songQualityResourceKey(resource.hash, resource.albumId)}:${qualityAccessStore.sessionRevision}`
      : '';
  });
  const audioQualityAccessEntry = computed(() => {
    const resource = qualityAccessResource.value;
    return resource
      ? qualityAccessStore.entries.get(songQualityResourceKey(resource.hash, resource.albumId))
      : undefined;
  });
  const isAudioQualityAccessLoading = computed(
    () =>
      !!qualityAccessResource.value &&
      (!audioQualityAccessEntry.value ||
        audioQualityAccessEntry.value.status === 'loading' ||
        qualityAccessStore.membershipStatus === 'loading'),
  );
  const hasAudioQualityAccessError = computed(
    () =>
      audioQualityAccessEntry.value?.status === 'error' ||
      (!!qualityAccessResource.value && qualityAccessStore.membershipStatus === 'error'),
  );
  const hasAudioQualityAccessData = computed(
    () =>
      !!audioQualityAccessEntry.value?.qualities.length &&
      (qualityAccessStore.membershipStatus !== 'loading' || !!qualityAccessStore.membership),
  );
  const isAudioQualityHidden = (quality: AudioQualityValue) =>
    settingStore.viperQualityEnabled === false && isViperAudioQuality(quality);
  const getAudioQualityAccessReason = (quality: AudioQualityValue) => {
    if (currentTrack.value && isAudioQualityHidden(quality)) return '蝰蛇音质未开启';
    if (!qualityAccessResource.value) return '';
    const entry = audioQualityAccessEntry.value;
    if (!entry || (entry.status === 'loading' && !entry.qualities.length))
      return '正在查询音质权限';
    if (entry.status === 'error') return '音质权限查询失败';
    return getQualityAccessReason(
      entry.qualities.find((item) => item.quality === quality),
      qualityAccessStore.membership,
    );
  };
  const getAudioQualitySizeText = (quality: AudioQualityValue) =>
    audioQualityAccessEntry.value?.qualities.find((item) => item.quality === quality)?.sizeText ??
    '';
  const effectiveAudioQuality = computed(() => {
    if (player.currentResolvedAudioQuality) return player.currentResolvedAudioQuality;
    if (!currentTrack.value) return requestedAudioQuality.value;
    return resolveEffectiveSongQuality(
      currentTrack.value,
      requestedAudioQuality.value,
      settingStore.compatibilityMode ?? true,
      settingStore.viperQualityEnabled,
    );
  });
  const isAudioSourceSwitching = computed(
    () =>
      player.audioSourceRefreshRequestSeq !== null &&
      player.audioSourceRefreshRequestSeq === player.playbackRequestSeq,
  );

  const isAudioQualityDisabled = (quality: AudioQualityValue) => {
    if (isAudioQualityHidden(quality)) return true;
    if (!currentTrack.value) return true;
    if (isAudioSourceSwitching.value) return true;
    if (isAudioQualityAccessLoading.value) return true;
    if (qualityAccessResource.value) return !!getAudioQualityAccessReason(quality);
    if (hasCloudAudioSourceOption.value) return true;
    if (quality === effectiveAudioQuality.value) return false;
    return !hasSongQuality(currentTrack.value, quality);
  };

  const audioQualityButtonBadge = computed(() => {
    if (isResolvedCloudSource.value) return 'CLD';
    if (effectiveAudioQuality.value === '128') return 'SD';
    if (effectiveAudioQuality.value === '320') return 'HQ';
    if (effectiveAudioQuality.value === 'flac') return 'SQ';
    if (effectiveAudioQuality.value === 'viper_tape') return 'VPT';
    if (effectiveAudioQuality.value === 'viper_clear') return 'VPC';
    if (effectiveAudioQuality.value === 'viper_atmos') return 'VPA';
    return 'HR';
  });

  const audioEffectButtonBadge = computed(() => {
    if (player.currentResolvedAudioEffect !== 'none') return 'FX';
    if (player.playbackDiagnostics.graph?.providerPresetJson) return 'FX';
    if (settingStore.impulseResponseEnabled && settingStore.getSelectedImpulseResponse())
      return 'IR';
    if (player.equalizerGains.some((g) => g !== 0)) return 'EQ';
    return null;
  });

  const currentAudioQualityBadgeColor = computed(() => {
    if (isResolvedCloudSource.value) return '#0EA5E9';
    return getAudioQualityTagColor(effectiveAudioQuality.value);
  });

  const getAudioQualityTagColor = (quality: AudioQualityValue) => {
    if (quality === '128') return '#64748B';
    if (quality === '320') return '#8B5CF6';
    if (quality === 'flac') return '#2563EB';
    if (quality === 'viper_tape') return '#E11D48';
    if (quality === 'viper_clear') return '#0891B2';
    if (quality === 'viper_atmos') return '#7C3AED';
    return '#F59E0B';
  };

  const setAudioQuality = (quality: AudioQualityValue) => {
    if (isAudioQualityDisabled(quality)) return;
    player.setPreferredAudioQuality(quality);
  };

  const setCloudAudioSource = () => {
    if (isAudioSourceSwitching.value || !hasCloudAudioSourceOption.value) return;
    player.preferCurrentTrackCloudSource();
  };

  const syncCurrentTrackCloudAudioSource = (
    track: Song,
    cloudAudioSource: Song['cloudAudioSource'],
  ) => {
    if (!cloudAudioSource?.hash) return;
    track.cloudAudioSource = cloudAudioSource;
    if (
      player.currentTrackSnapshot &&
      String(player.currentTrackSnapshot.id) === String(track.id)
    ) {
      player.currentTrackSnapshot = {
        ...player.currentTrackSnapshot,
        cloudAudioSource,
      };
    }
  };

  const ensureCurrentTrackCloudAudioSource = async () => {
    const track = currentTrack.value;
    const lookupKey = cloudAudioSourceLookupKey.value;
    if (!track) return false;
    if (track.source === 'cloud' || track.cloudAudioSource?.hash) return false;
    if (!lookupKey || cloudAudioSourceLoadingKey.value === lookupKey) return false;
    const fetchSeq = ++cloudAudioSourceFetchSeq;
    cloudAudioSourceLoadingKey.value = lookupKey;
    try {
      const cloudAudioSource = await getCloudAudioSourceForSong(track);
      if (cloudAudioSourceLookupKey.value !== lookupKey || !cloudAudioSource?.hash) {
        return false;
      }
      syncCurrentTrackCloudAudioSource(track, cloudAudioSource);
      return true;
    } finally {
      if (fetchSeq === cloudAudioSourceFetchSeq) {
        cloudAudioSourceLoadingKey.value = '';
      }
    }
  };

  const ensureCurrentTrackCatalogQualities = async () => {
    if (!currentTrack.value) return;
    const resource = qualityAccessResource.value;
    // 音质权限先查询，云盘关联查找不阻塞普通曲库的音质列表。
    const accessTask = resource
      ? qualityAccessStore.ensure(resource.hash, resource.albumId)
      : Promise.resolve();
    const cloudTask = !hasCloudAudioSourceOption.value
      ? ensureCurrentTrackCloudAudioSource()
      : Promise.resolve();
    await Promise.all([accessTask, cloudTask]);
    const nextResource = qualityAccessResource.value;
    if (
      nextResource &&
      (nextResource.hash !== resource?.hash || nextResource.albumId !== resource?.albumId)
    ) {
      await qualityAccessStore.ensure(nextResource.hash, nextResource.albumId);
    }
  };

  const retryCurrentTrackQualityAccess = async () => {
    const resource = qualityAccessResource.value;
    if (resource) await qualityAccessStore.ensure(resource.hash, resource.albumId, true);
  };

  const setAudioEffect = (effect: AudioEffectValue) => {
    if (isAudioEffectPresetSelectionDisabled.value) return;
    if (
      player.audioEffect === effect &&
      (!player.currentTrackId || player.currentResolvedAudioEffect === effect)
    )
      return;
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
      name: 'song-detail',
      params: { id: track.mixSongId ? String(track.mixSongId) : String(track.id) },
      query: {
        mainTab: 'detail',
        type: 'music',
        title: track.name,
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

  const resolveTrackAlbumAudioId = (track?: Song | null) => {
    if (!track) return null;
    return (
      resolveNumericId(track.albumAudioId) ??
      resolveNumericId(track.mixSongId) ??
      resolveNumericId(track.id)
    );
  };

  const hasCurrentTrackMv = computed(() => Boolean(resolveTrackAlbumAudioId(currentTrack.value)));

  const goToMv = async () => {
    const track = currentTrack.value;
    const albumAudioId = resolveTrackAlbumAudioId(track);
    if (!track || !albumAudioId) return;
    const mvHash = String(track.mvHash ?? '').trim();
    if (player.isPlaying) {
      await player.togglePlay();
    }
    router.push({
      name: 'mv-detail',
      params: { id: String(albumAudioId) },
      query: {
        hash: mvHash,
        albumAudioId,
        title: track.name,
        artist: track.artist,
        cover: track.coverUrl ?? '',
        album: track.album ?? '',
        songId: track.id,
        mixSongId: track.mixSongId ?? '',
        from: route.fullPath,
      },
    });
  };

  // ── 分享 ──
  const canShareCurrentTrack = computed(() => isSongHashId(currentTrack.value?.hash));

  const handleShareCurrentTrack = async () => {
    const track = currentTrack.value;
    if (!track) return;
    const target = createSongShareTarget(track);
    if (!target) {
      toastStore.unavailable('当前歌曲');
      return;
    }
    try {
      await copyShareTarget(target);
      toastStore.actionCompleted('分享链接已复制');
    } catch {
      toastStore.actionFailed('复制分享链接');
    }
  };

  // ── 队列 ──
  const queueCount = computed(() =>
    Math.max(
      0,
      currentPlaybackQueue.value?.songCount ?? currentPlaybackQueue.value?.songs.length ?? 0,
    ),
  );

  const openQueue = () => {
    isQueueDrawerOpen.value = true;
  };

  // ── 添加到歌单 ──
  const showAddToPlaylistDialog = ref(false);
  // Freeze the target at open time; changing playback must not change the pending action.
  const addToPlaylistTrack = ref<Song | null>(null);
  const isPlaylistLoading = ref(false);

  const canAddToPlaylist = computed(() => userStore.isLoggedIn && !!currentTrack.value);

  const createdPlaylists = computed(() => playlist.getCreatedPlaylists(userStore.info?.userid));

  const addToPlaybackQueues = computed(() =>
    playlist.playbackQueueList.filter(
      (queue) =>
        queue.id !== PERSONAL_FM_QUEUE_ID &&
        queue.id !== LISTEN_TOGETHER_QUEUE_ID &&
        Math.max(0, queue.songCount ?? queue.songs.length) > 0,
    ),
  );

  const handleOpenAddToPlaylist = async () => {
    if (!canAddToPlaylist.value) return;
    addToPlaylistTrack.value = currentTrack.value ? { ...currentTrack.value } : null;
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
    const track = addToPlaylistTrack.value;
    if (!track) return;
    const options = queueId ? { queueId } : {};
    const addedCount = playlist.appendToPlaybackQueue?.([track], options) ?? 0;
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
    const track = addToPlaylistTrack.value;
    if (!track) return;
    try {
      const result = await playlist.addToPlaylist(String(listId), track);
      if (result === 'added') {
        toastStore.actionCompleted('添加成功');
        showAddToPlaylistDialog.value = false;
        return;
      }
      if (result === 'exists') {
        toastStore.warning('歌单中已有此内容');
        showAddToPlaylistDialog.value = false;
        return;
      }
      toastStore.actionFailed('添加到歌单');
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
    currentPlaybackQueue,
    // 收藏
    isFavorite,
    toggleFavorite,
    // 播放模式
    playModeLabel,
    playModeIcon,
    cyclePlayMode,
    // 音量
    volumeIcon,
    handleVolumeChange,
    toggleMute,
    // 倍速
    playbackRateDisplay,
    handlePlaybackRateSlider,
    resetPlaybackRate,
    setPlaybackRate,
    // 音质
    effectiveAudioQuality,
    requestedAudioQuality,
    isAudioSourceSwitching,
    isResolvedCloudSource,
    hasCloudAudioSourceOption,
    hasCatalogAudioSourceOption,
    isAudioEffectPresetSelectionDisabled,
    isAudioQualityDisabled,
    isAudioQualityHidden,
    audioQualityAccessLookupKey,
    isAudioQualityAccessLoading,
    hasAudioQualityAccessError,
    hasAudioQualityAccessData,
    getAudioQualityAccessReason,
    getAudioQualitySizeText,
    retryCurrentTrackQualityAccess,
    audioQualityButtonBadge,
    audioEffectButtonBadge,
    currentAudioQualityBadgeColor,
    getAudioQualityTagColor,
    ensureCurrentTrackCatalogQualities,
    setAudioQuality,
    setCloudAudioSource,
    setAudioEffect,
    // 桌面歌词
    toggleDesktopLyric,
    // 导航
    resolveNumericId,
    goToComments,
    hasCurrentTrackMv,
    goToMv,
    // 分享
    canShareCurrentTrack,
    handleShareCurrentTrack,
    // 队列
    queueCount,
    isQueueDrawerOpen,
    openQueue,
    // 添加到歌单
    showAddToPlaylistDialog,
    addToPlaylistTrack,
    isPlaylistLoading,
    canAddToPlaylist,
    createdPlaylists,
    addToPlaybackQueues,
    handleOpenAddToPlaylist,
    handleAddToQueue,
    handleSelectPlaylist,
  };
}
