import { defineStore } from 'pinia';
import { reactive, toRefs } from 'vue';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import logger from '@/utils/logger';
import { PlayerEngine, type PlayerEngineEvents } from '@/utils/player';
import type { Song } from '@/models/song';

import { createPlayerState } from './player/state';
import { createPlaybackManager } from './player/playback';
import { createAudioManager } from './player/audio';
import { createResolver } from './player/resolver';
import { createHistoryManager } from './player/history';
import { createDeviceManager } from './player/device';
import { buildMediaState, findTrackById, resolvePlaybackNotice } from './player/utils';

const engine = new PlayerEngine();

export const usePlayerStore = defineStore(
  'player',
  () => {
    const state = reactive(createPlayerState());
    const playlistStore = usePlaylistStore();
    const settingStore = useSettingStore();
    const lyricStore = useLyricStore();

    const resolver = createResolver(state, playlistStore, settingStore);
    const historyManager = createHistoryManager(state);

    const refreshCurrentTrack = async () => {
      if (!state.currentTrackId) return;
      if (state.isLoading) {
        state.pendingSettingRefresh = true;
        return;
      }
      const requestSeq = ++state.playbackRequestSeq;
      const track = findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore);
      if (!track) return;

      state.pendingSettingRefresh = false;
      const wasPlaying = state.isPlaying;
      const previousTime = state.currentTime;
      state.isLoading = true;

      const resolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      if (requestSeq !== state.playbackRequestSeq) return;
      if (!resolved.url) {
        state.isLoading = false;
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        return;
      }

      clearPlaybackNotice();

      engine.setVolume(state.volume);
      if (requestSeq !== state.playbackRequestSeq) return;

      state.currentAudioUrl = resolved.url;
      state.currentResolvedAudioQuality = resolved.quality;
      state.currentResolvedAudioEffect = resolved.effect;
      track.audioUrl = resolved.url;
      const savedDuration = state.duration;
      engine.setSource(resolved.url);
      if (!state.duration && !engine.duration && savedDuration) state.duration = savedDuration;
      engine.applyTrackLoudness(resolved.loudness);
      engine.setPlaybackRate(state.playbackRate);
      void resolver.fetchClimaxMarks(track);

      if (previousTime > 0) {
        state.recentSeekIgnoreEnd = true;
        window.setTimeout(() => {
          state.recentSeekIgnoreEnd = false;
        }, 1500);
        let actualDuration = engine.duration;
        if (actualDuration <= 0) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => window.setTimeout(r, 50));
            actualDuration = engine.duration;
            if (actualDuration > 0) break;
          }
        }
        let safeTime = previousTime;
        if (actualDuration > 0 && previousTime >= actualDuration - 0.5) safeTime = 0;
        engine.seek(safeTime);
        state.currentTime = safeTime;
      }

      if (wasPlaying) {
        try {
          await engine.play();
          if (requestSeq !== state.playbackRequestSeq) return;
        } catch (error) {
          logger.error('PlayerStore', 'Reload track failed:', error);
        }
      }
      if (!state.duration && !engine.duration && track.duration) state.duration = track.duration;
      if (wasPlaying) engine.setVolume(state.volume);
      state.isLoading = false;
      if (state.pendingSettingRefresh) {
        state.pendingSettingRefresh = false;
        void refreshCurrentTrack();
      }
    };

    const audioManager = createAudioManager(state, engine, refreshCurrentTrack);
    const deviceManager = createDeviceManager(state, engine, settingStore);
    const showPlaybackNotice = (code: string, track?: Song | null) => {
      state.playbackNotice = resolvePlaybackNotice({
        code,
        track,
        autoNextEnabled: settingStore.autoNext,
        autoNextDelaySeconds: settingStore.autoNextDelaySeconds,
      });
    };

    const clearPlaybackNotice = (trackId?: string | number | null) => {
      if (!state.playbackNotice) return;
      if (
        trackId !== undefined &&
        trackId !== null &&
        state.playbackNotice.trackId !== String(trackId)
      )
        return;
      state.playbackNotice = null;
    };

    const playbackManager = createPlaybackManager(
      state,
      engine,
      playlistStore,
      settingStore,
      lyricStore,
      resolver,
      historyManager,
      showPlaybackNotice,
      clearPlaybackNotice,
    );

    const toggleLyricView = (open?: boolean) => {
      state.isLyricViewOpen = open ?? !state.isLyricViewOpen;
    };

    const handlePlaybackEnded = async () => {
      if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
        const nextFmSong = await playlistStore.consumeNextPersonalFmTrack({
          track: state.currentTrackSnapshot,
          playtime: state.duration,
          isOverplay: true,
        });

        if (nextFmSong) {
          await playbackManager.playTrack(String(nextFmSong.id), playlistStore.activeQueue.songs, {
            sourceQueueId: PERSONAL_FM_QUEUE_ID,
          });
        } else {
          playbackManager.stop();
        }
        return;
      }
      if (state.playMode === 'single') {
        if (state.currentAudioUrl) {
          engine.setSource(state.currentAudioUrl);
          void engine.play();
        }
        return;
      }
      playbackManager.next();
    };

    const registerSettingWatchers = () => {
      if (state.settingsWatcherRegistered) return;
      state.settingsWatcherRegistered = true;
      let snapshot = {
        defaultAudioQuality: settingStore.defaultAudioQuality,
        compatibilityMode: settingStore.compatibilityMode,
        volumeFade: settingStore.volumeFade,
        volumeFadeTime: settingStore.volumeFadeTime,
        outputDevice: settingStore.outputDevice,
        exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
      };
      settingStore.$subscribe(() => {
        const shouldRefresh =
          (state.currentAudioQualityOverride === null &&
            settingStore.defaultAudioQuality !== snapshot.defaultAudioQuality) ||
          settingStore.compatibilityMode !== snapshot.compatibilityMode;
        const shouldUpdateFade =
          settingStore.volumeFade !== snapshot.volumeFade ||
          settingStore.volumeFadeTime !== snapshot.volumeFadeTime;
        const shouldUpdateOutputDevice =
          settingStore.outputDevice !== snapshot.outputDevice ||
          settingStore.exclusiveAudioDevice !== snapshot.exclusiveAudioDevice;
        snapshot = {
          defaultAudioQuality: settingStore.defaultAudioQuality,
          compatibilityMode: settingStore.compatibilityMode,
          volumeFade: settingStore.volumeFade,
          volumeFadeTime: settingStore.volumeFadeTime,
          outputDevice: settingStore.outputDevice,
          exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
        };
        if (shouldRefresh) {
          if (state.isLoading || state.pendingSettingRefresh) state.pendingSettingRefresh = true;
          else void refreshCurrentTrack();
        }
        if (shouldUpdateFade && state.isPlaying) {
          void audioManager.fadeVolume(state.volume, { durationMs: 120, respectUserVolume: false });
        }
        if (shouldUpdateOutputDevice)
          void deviceManager.applyOutputDevice(settingStore.outputDevice);
      });
    };

    const init = () => {
      engine.setVolume(state.volume);
      engine.setPlaybackRate(state.playbackRate);
      engine.setVolumeNormalization(settingStore.volumeNormalization);
      engine.setReferenceLufs(settingStore.volumeNormalizationLufs);
      engine.setLoopFile(state.playMode === 'single');
      registerSettingWatchers();
      deviceManager.registerOutputDeviceWatcher();
      void deviceManager.refreshOutputDevices();

      let lastMediaSessionSync = 0;
      const MEDIA_SESSION_SYNC_MS = 2000;
      let lastHistoryCheck = 0;
      const HISTORY_CHECK_MS = 5000;

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime) => {
          if (state.isDraggingProgress) return;
          if (
            state.seekTargetTime !== null &&
            Date.now() - state.seekTimestamp < 500 &&
            currentTime < state.seekTargetTime - 0.5
          )
            return;
          state.seekTargetTime = null;
          state.currentTime = currentTime;
          const now = Date.now();
          if (now - lastHistoryCheck >= HISTORY_CHECK_MS) {
            lastHistoryCheck = now;
            void historyManager.commitListeningHistory();
          }
          if (now - lastMediaSessionSync >= MEDIA_SESSION_SYNC_MS) {
            lastMediaSessionSync = now;
            engine.updateMediaPlaybackState(buildMediaState(state));
          }
        },
        durationChange: (duration) => {
          state.duration = duration;
          engine.updateMediaPlaybackState(buildMediaState(state));
          const trackDuration = state.currentTrackSnapshot?.duration ?? 0;
          if (duration > 0 && trackDuration > 0) {
            const diff = Math.abs(duration - trackDuration);
            lyricStore.lyricSyncWarning = diff > 10 && diff / trackDuration > 0.1;
          } else {
            lyricStore.lyricSyncWarning = false;
          }
        },
        ended: () => {
          if (!state.recentSeekIgnoreEnd) handlePlaybackEnded();
          else state.recentSeekIgnoreEnd = false;
        },
        play: () => {
          state.isPlaying = true;
          state.isLoading = false;
          clearPlaybackNotice(state.currentTrackId);
          settingStore.syncPreventSleep(true);
          engine.updateMediaPlaybackState(buildMediaState(state));
        },
        pause: () => {
          state.isPlaying = false;
          settingStore.syncPreventSleep(false);
          engine.updateMediaPlaybackState(buildMediaState(state));
        },
        error: (event) => {
          if (event && !event.isTrusted && !(event as any)?.detail) return;
          state.lastError = (event as any)?.type ?? 'playback-error';
          showPlaybackNotice('playback-failed', state.currentTrackSnapshot);
          playbackManager.applyFailedPlaybackState({ keepResolvedSource: true });
          settingStore.syncPreventSleep(false);
          if (settingStore.autoNext && state.currentPlaylist?.length)
            playbackManager.scheduleAutoNext();
          else playbackManager.clearAutoNextTimer();
        },
      };
      engine.setEvents(events);
      engine.setMediaSessionHandlers({
        play: () => {
          if (!state.isPlaying) playbackManager.togglePlay();
        },
        pause: () => {
          if (state.isPlaying) playbackManager.togglePlay();
        },
        previoustrack: () => playbackManager.prev(),
        nexttrack: () => playbackManager.next(),
        seekto: (time) => playbackManager.seek(time),
        seekbackward: (offset) => playbackManager.seek(Math.max(0, state.currentTime - offset)),
        seekforward: (offset) =>
          playbackManager.seek(Math.min(state.duration, state.currentTime + offset)),
      });
      window.electron?.mpv?.getState?.().then((mpvState) => {
        if (!mpvState) return;
        if (mpvState.playing && !state.isPlaying) {
          state.isPlaying = true;
          state.isLoading = false;
          settingStore.syncPreventSleep(true);
        }
        if (mpvState.duration > 0) state.duration = mpvState.duration;
        if (mpvState.timePos > 0) state.currentTime = mpvState.timePos;
      });
    };

    const notifySeekStart = () => {
      state.isDraggingProgress = true;
    };
    const notifySeekEnd = () => {
      state.isDraggingProgress = false;
    };
    const setVolumeSmooth = async (value: number, durationMs?: number) => {
      await engine.fadeTo(value, durationMs ?? 1000);
      state.volume = engine.volume;
    };

    // Explicitly return state and actions to help TypeScript
    return {
      ...toRefs(state),
      // State-like (actually actions but Pinia treats them as actions)
      getEffectiveAudioQuality: resolver.getEffectiveAudioQuality,
      getResolvedAudioQuality: resolver.getResolvedAudioQuality,
      ensureTrackRelateGoods: resolver.ensureTrackRelateGoods,
      resolveAudioUrl: resolver.resolveAudioUrl,
      fetchClimaxMarks: resolver.fetchClimaxMarks,

      getTrackedPlayCount: historyManager.getTrackedPlayCount,
      syncTrackedPlayCount: historyManager.syncTrackedPlayCount,
      hydrateHistoryPlayCounts: historyManager.hydrateHistoryPlayCounts,
      resetHistoryUploadState: historyManager.resetHistoryUploadState,
      commitListeningHistory: historyManager.commitListeningHistory,

      setVolume: audioManager.setVolume,
      setPlaybackRate: audioManager.setPlaybackRate,
      setPlayMode: audioManager.setPlayMode,
      setVolumeNormalization: audioManager.setVolumeNormalization,
      setReferenceLufs: audioManager.setReferenceLufs,
      setEq: audioManager.setEq,
      setAudioEffect: audioManager.setAudioEffect,
      fadeVolume: audioManager.fadeVolume,
      setCurrentAudioQualityOverride: audioManager.setCurrentAudioQualityOverride,

      refreshOutputDevices: deviceManager.refreshOutputDevices,
      applyOutputDevice: deviceManager.applyOutputDevice,

      playTrack: playbackManager.playTrack,
      togglePlay: playbackManager.togglePlay,
      seek: playbackManager.seek,
      next: playbackManager.next,
      prev: playbackManager.prev,
      stop: playbackManager.stop,

      toggleLyricView,
      showPlaybackNotice,
      clearPlaybackNotice,
      refreshCurrentTrack,
      init,
      notifySeekStart,
      notifySeekEnd,
      setVolumeSmooth,
    };
  },
  {
    persist: {
      pick: [
        'volume',
        'playMode',
        'currentTrackId',
        'playbackRate',
        'audioEffect',
        'equalizerGains',
        'historyPlayCountMap',
      ],
    },
  },
);
