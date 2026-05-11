import logger from '@/utils/logger';
import type { Song } from '@/models/song';
import { isPlayableSong } from '@/utils/song';
import type { PlayerState } from './state';
import type { PlayerEngine } from '@/utils/player';
import type { usePlaylistStore } from '../playlist';
import type { useSettingStore } from '../setting';
import { PERSONAL_FM_QUEUE_ID } from '../playlist';
import {
  buildMediaMeta,
  buildMediaState,
  buildStoppedPlaybackState,
  clampNumber,
  findPlayableIndex,
  findTrackById,
} from './utils';

export const createPlaybackManager = (
  state: PlayerState,
  engine: PlayerEngine,
  playlistStore: ReturnType<typeof usePlaylistStore>,
  settingStore: ReturnType<typeof useSettingStore>,
  lyricStore: any,
  resolver: any,
  historyManager: any,
  showPlaybackNotice: (code: string, track?: Song | null) => void,
  clearPlaybackNotice: (trackId?: string | number | null) => void,
) => {
  const applyFailedPlaybackState = (options?: { keepResolvedSource?: boolean }) => {
    state.isLoading = false;
    state.isPlaying = false;
    state.currentTime = 0;
    state.duration = 0;
    if (!options?.keepResolvedSource) {
      state.currentAudioUrl = '';
      state.currentResolvedAudioQuality = null;
      state.currentResolvedAudioEffect = 'none';
    }
    engine.updateMediaPlaybackState(buildStoppedPlaybackState(state));
  };

  const clearAutoNextTimer = () => {
    if (state.autoNextTimer !== null) {
      window.clearTimeout(state.autoNextTimer);
      state.autoNextTimer = null;
    }
  };

  const skipToNextAfterFailure = async () => {
    playlistStore.syncQueuedNextTrackIds();
    if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
      const currentTrack =
        findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
        state.currentTrackSnapshot;
      void playlistStore.ensurePersonalFmQueue({
        track: currentTrack,
        playtime: state.currentTime,
        isOverplay: false,
      });
    }
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0 || !state.currentTrackId) return;

    const currentIndex = list.findIndex((song) => String(song.id) === String(state.currentTrackId));
    let nextIndex = -1;

    if (state.playMode === 'random') {
      nextIndex = pickRandomIndex(list.length, currentIndex);
      if (!isPlayableSong(list[nextIndex]))
        nextIndex = findPlayableIndex(list, nextIndex, true, false);
    } else {
      nextIndex = findPlayableIndex(list, Math.max(0, currentIndex), true, false);
    }

    const nextSong = nextIndex >= 0 ? list[nextIndex] : null;
    if (!nextSong) return;

    return playTrack(String(nextSong.id), list, {
      preserveFailureChain: true,
      sourceQueueId: state.currentSourceQueueId,
    });
  };

  const scheduleAutoNext = () => {
    if (!settingStore.autoNext || !state.currentTrackId) return;
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length <= 1) return;

    const currentTrackId = String(state.currentTrackId);
    const maxAttempts = Math.max(0, Math.floor(settingStore.autoNextMaxAttempts || 0));
    if (maxAttempts > 0 && state.autoNextAttempts >= maxAttempts) return;

    clearAutoNextTimer();
    const delayMs = Math.max(0, Math.floor((settingStore.autoNextDelaySeconds || 0) * 1000));
    state.autoNextTimer = window.setTimeout(() => {
      state.autoNextTimer = null;
      if (
        String(state.currentTrackId ?? '') !== currentTrackId ||
        state.isPlaying ||
        state.isLoading
      )
        return;
      state.autoNextAttempts += 1;
      void skipToNextAfterFailure();
    }, delayMs);
  };

  const playTrack = async (
    id: string,
    playlist?: Song[],
    options?: {
      preserveFailureChain?: boolean;
      autoPlay?: boolean;
      sourceQueueId?: string | null;
    },
  ) => {
    const requestSeq = ++state.playbackRequestSeq;
    const sourceList = playlist ?? playlistStore.activeQueue?.songs ?? playlistStore.defaultList;
    const resolvedId = String(id);
    clearAutoNextTimer();
    if (!options?.preserveFailureChain) {
      state.autoNextAttempts = 0;
      state.autoNextSourceTrackId = null;
    }
    const track =
      sourceList.find((s) => String(s.id) === resolvedId) ||
      playlistStore.favorites.find((s) => String(s.id) === resolvedId);

    if (!track) return;

    if (!isPlayableSong(track)) {
      state.lastError = 'track-not-playable';
      state.currentTrackSnapshot = track;
      state.currentTrackId = resolvedId;
      state.currentPlaylist = sourceList;
      showPlaybackNotice('track-not-playable', track);
      applyFailedPlaybackState();
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
      return;
    }

    const autoPlay = options?.autoPlay ?? true;
    const wasPlaying = autoPlay ? state.isPlaying : false;

    if (wasPlaying && settingStore.volumeFade) {
      const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
      await engine.pause({ fadeOut: true, fadeDurationMs: fadeMs });
    }

    if (requestSeq !== state.playbackRequestSeq) return;

    // 不调用 engine.reset()，避免释放音频设备导致多设备同步抢占
    // mpv 的 loadFile 会直接替换当前文件，无需先 stop
    engine.setPlaybackRate(state.playbackRate);

    state.currentTrackId = resolvedId;
    state.currentSourceQueueId =
      options?.sourceQueueId ??
      playlistStore.activeQueue?.id ??
      playlistStore.activeQueueId ??
      null;
    state.currentTrackSnapshot = track;
    historyManager.resetHistoryUploadState(track);
    state.currentPlaylist = sourceList;
    playlistStore.updateQueueCurrentTrack(resolvedId);
    state.currentAudioUrl = '';
    state.currentResolvedAudioQuality = null;
    state.currentResolvedAudioEffect = 'none';
    state.currentTime = 0;
    state.duration = 0;
    state.isPlaying = false;
    state.isLoading = true;
    state.lastError = null;
    clearPlaybackNotice();
    state.climaxMarks = [];

    playlistStore.consumeQueuedNextTrackId(id);
    playlistStore.syncQueuedNextTrackIds();

    const lyricHash = String(track.hash ?? track.id ?? '');
    if (track.lyric) {
      lyricStore.setLyric(track.lyric, lyricHash);
    } else {
      lyricStore.clear(lyricHash, '歌词加载中...');
    }
    if (lyricHash) {
      void lyricStore.fetchLyrics(lyricHash, {
        preserveCurrent: Boolean(track.lyric),
      });
    } else if (!track.lyric) {
      lyricStore.clear('', '暂无歌词');
    }

    const pendingMediaMeta = buildMediaMeta(track);
    if (pendingMediaMeta) {
      engine.updateMediaMetadata({
        ...pendingMediaMeta,
        durationMs: (track.duration || 0) * 1000,
      });
    }
    engine.updateMediaPlaybackState(
      buildStoppedPlaybackState({ playbackRate: state.playbackRate }),
    );

    const resolved = await resolver.resolveAudioUrl(track);
    if (requestSeq !== state.playbackRequestSeq) return;
    if (!resolved.url) {
      state.lastError = 'audio-url-unavailable';
      state.currentTrackSnapshot = track;
      state.currentTrackId = resolvedId;
      state.currentPlaylist = sourceList;
      showPlaybackNotice('audio-url-unavailable', track);
      applyFailedPlaybackState();
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
      return;
    }

    state.currentAudioQualityOverride = null;
    state.currentAudioUrl = resolved.url;
    state.currentResolvedAudioQuality = resolved.quality;
    state.currentResolvedAudioEffect = resolved.effect;
    track.audioUrl = resolved.url;

    engine.setSource(resolved.url);
    engine.applyTrackLoudness(resolved.loudness);
    engine.setLoopFile(state.playMode === 'single');

    try {
      if (autoPlay) {
        if (settingStore.volumeFade) {
          const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
          await engine.play({ fadeIn: true, fadeDurationMs: fadeMs });
        } else {
          await engine.play();
        }
      }
      if (requestSeq !== state.playbackRequestSeq) return;
      state.isLoading = false;
      state.autoNextAttempts = 0;
      state.autoNextSourceTrackId = String(track.id);
      clearAutoNextTimer();
      if (!state.duration && !engine.duration && track.duration) state.duration = track.duration;
      if (!autoPlay || !settingStore.volumeFade) engine.setVolume(state.volume);
      if (!autoPlay) {
        state.isPlaying = false;
        engine.updateMediaPlaybackState(buildStoppedPlaybackState(state));
      } else {
        state.isPlaying = true;
      }
      void resolver.fetchClimaxMarks(track);
    } catch (error) {
      logger.error('PlayerPlayback', 'Play track failed:', error);
      if (requestSeq !== state.playbackRequestSeq) return;
      state.lastError = 'playback-failed';
      showPlaybackNotice('playback-failed', track);
      applyFailedPlaybackState({ keepResolvedSource: true });
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
    }
  };

  const togglePlay = async () => {
    if (state.isResuming) return;

    if (!state.currentTrackId) {
      if ((playlistStore.activeQueue?.songs.length ?? playlistStore.defaultList.length) > 0) {
        const activeSongs = playlistStore.activeQueue?.songs ?? playlistStore.defaultList;
        let firstTrackIndex = 0;
        if (state.playMode === 'random')
          firstTrackIndex = Math.floor(Math.random() * activeSongs.length);
        const playableIndex = findPlayableIndex(activeSongs, firstTrackIndex, true, true);
        if (playableIndex !== -1) playTrack(activeSongs[playableIndex].id, activeSongs);
      }
      return;
    }

    if (state.isPlaying) {
      state.isPlaying = false;
      settingStore.syncPreventSleep(false);
      engine.updateMediaPlaybackState(buildMediaState(state));
      engine.pause().catch((err) => logger.error('PlayerPlayback', 'Pause failed', err));
      return;
    }

    if (!engine.source) {
      await playTrack(state.currentTrackId);
      return;
    }

    state.isResuming = true;
    state.isPlaying = true;
    settingStore.syncPreventSleep(true);
    engine.updateMediaPlaybackState(buildMediaState(state));

    try {
      const timeoutMs = (settingStore.playResumeTimeout ?? 5) * 1000;
      await engine.play({ timeoutMs: timeoutMs > 0 ? timeoutMs : undefined });
    } catch {
      state.isPlaying = false;
      try {
        await playTrack(state.currentTrackId);
      } catch {
        /* ignore */
      }
    } finally {
      state.isResuming = false;
    }
  };

  const seek = (time: number) => {
    const effectiveDuration = engine.duration > 0 ? engine.duration : state.duration;
    const targetTime = Math.max(0, Math.min(effectiveDuration, time));
    if (state.isDraggingProgress) state.isDraggingProgress = false;
    state.seekTargetTime = targetTime;
    state.seekTimestamp = Date.now();
    engine.seek(targetTime);
    state.currentTime = targetTime;

    // 当 seek 目标接近结尾时（距结尾 < 2 秒），不忽略 EOF 事件，
    // 否则播放完毕后不会自动切下一首
    const nearEnd = effectiveDuration > 0 && effectiveDuration - targetTime < 2;
    if (!nearEnd) {
      state.recentSeekIgnoreEnd = true;
      window.setTimeout(() => {
        state.recentSeekIgnoreEnd = false;
      }, 800);
    }

    engine.updateMediaPlaybackState(buildMediaState(state));
  };

  const next = async () => {
    playlistStore.syncQueuedNextTrackIds();
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0) return;

    clearAutoNextTimer();

    const queuedNextId = playlistStore.peekQueuedNextTrackId();
    if (queuedNextId) {
      const queuedSong = list.find((song) => String(song.id) === queuedNextId);
      if (queuedSong && isPlayableSong(queuedSong)) {
        playlistStore.consumeQueuedNextTrackId(queuedNextId);
        void playTrack(String(queuedSong.id), list, { sourceQueueId: state.currentSourceQueueId });
        return;
      }
      playlistStore.consumeQueuedNextTrackId(queuedNextId);
    }

    let nextIndex = 0;
    const currentIndex = list.findIndex((s) => String(s.id) === String(state.currentTrackId));

    if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
      void playlistStore.ensurePersonalFmQueue({
        track:
          list[currentIndex] ||
          findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
          state.currentTrackSnapshot,
        playtime: state.currentTime,
        isOverplay:
          state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false,
      });
      const fmNextSong =
        currentIndex >= 0 && currentIndex < list.length - 1
          ? list[currentIndex + 1]
          : await playlistStore.consumeNextPersonalFmTrack({
              track:
                list[currentIndex] ||
                findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
                state.currentTrackSnapshot,
              playtime: state.currentTime,
              isOverplay:
                state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false,
            });
      if (fmNextSong) {
        const fmList = playlistStore.activeQueue?.songs || list;
        await playTrack(String(fmNextSong.id), fmList, { sourceQueueId: PERSONAL_FM_QUEUE_ID });
      }
      return;
    }

    if (state.playMode === 'random') {
      nextIndex = pickRandomIndex(list.length, currentIndex);
    } else if (state.playMode === 'sequential') {
      if (currentIndex >= list.length - 1) {
        state.isPlaying = false;
        engine.pause();
        return;
      }
      nextIndex = currentIndex + 1;
    } else {
      nextIndex = (currentIndex + 1) % list.length;
    }

    if (state.playMode !== 'random') {
      nextIndex = findPlayableIndex(list, nextIndex, true, true);
    } else if (!isPlayableSong(list[nextIndex])) {
      nextIndex = findPlayableIndex(list, nextIndex, true, false);
    }

    if (state.playMode === 'sequential' && nextIndex <= currentIndex) {
      state.isPlaying = false;
      engine.pause();
      return;
    }

    const nextSong = list[nextIndex];
    if (!nextSong) return;
    await playTrack(String(nextSong.id), list, { sourceQueueId: state.currentSourceQueueId });
  };

  const prev = async () => {
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0) return;

    const currentIndex = list.findIndex((s) => String(s.id) === String(state.currentTrackId));
    let prevIndex = (currentIndex - 1 + list.length) % list.length;
    prevIndex = findPlayableIndex(list, prevIndex, false, true);
    const prevSong = list[prevIndex];
    if (!prevSong) return;
    clearAutoNextTimer();
    void playTrack(prevSong.id, list, { sourceQueueId: state.currentSourceQueueId });
  };

  const stop = () => {
    clearAutoNextTimer();
    state.autoNextAttempts = 0;
    state.autoNextSourceTrackId = null;
    state.currentTrackSnapshot = null;
    state.historyUploadCommitted = false;
    state.historyUploadTrackId = null;
    state.historyUploadPlayCount = 0;
    engine.reset();
    state.currentTime = 0;
    state.duration = 0;
    state.isPlaying = false;
    state.currentTrackId = null;
    state.currentSourceQueueId = null;
    state.currentAudioUrl = '';
    state.currentResolvedAudioQuality = null;
    state.currentResolvedAudioEffect = 'none';
    state.currentAudioQualityOverride = null;
    state.audioEffect = 'none';
    state.playbackRequestSeq += 1;
    state.climaxRequestSeq += 1;
    state.isLoading = false;
    playlistStore.updateQueueCurrentTrack(null);
    engine.updateMediaPlaybackState(buildMediaState(state));
  };

  const pickRandomIndex = (length: number, currentIndex: number) => {
    if (length <= 1) return currentIndex;
    state.shufflePlayed.add(currentIndex);
    if (!state.shuffleQueue || state.shuffleQueueLength !== length) {
      if (state.shuffleQueue && state.shuffleQueueLength !== length) {
        const remaining = new Set(state.shuffleQueue.filter((i) => i < length));
        const newIndices: number[] = [];
        for (let i = 0; i < length; i++) {
          if (i !== currentIndex && !state.shufflePlayed.has(i) && !remaining.has(i))
            newIndices.push(i);
        }
        for (const idx of state.shufflePlayed) {
          if (idx >= length) state.shufflePlayed.delete(idx);
        }
        shuffleInsert(newIndices);
        const validRemaining = state.shuffleQueue.filter((i) => i < length && i !== currentIndex);
        state.shuffleQueue = [...validRemaining, ...newIndices];
      } else {
        state.shufflePlayed = new Set([currentIndex]);
        state.shuffleQueue = buildShuffleQueue(length, currentIndex);
      }
      state.shuffleQueueLength = length;
    }
    if (state.shuffleQueue.length === 0) {
      state.shufflePlayed = new Set([currentIndex]);
      state.shuffleQueue = buildShuffleQueue(length, currentIndex);
    }
    const nextIndex = state.shuffleQueue.shift()!;
    state.shufflePlayed.add(nextIndex);
    return nextIndex;
  };

  const shuffleInsert = (arr: number[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  const buildShuffleQueue = (length: number, excludeIndex: number): number[] => {
    const indices = Array.from({ length }, (_, i) => i).filter((i) => i !== excludeIndex);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  };

  return {
    applyFailedPlaybackState,
    clearAutoNextTimer,
    skipToNextAfterFailure,
    scheduleAutoNext,
    playTrack,
    togglePlay,
    seek,
    next,
    prev,
    stop,
    pickRandomIndex,
    shuffleInsert,
    buildShuffleQueue,
  };
};
