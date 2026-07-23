import { defineStore } from 'pinia';
import { computed, reactive, toRefs, watch } from 'vue';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import { useToastStore } from './toast';
import { useUserStore } from './user';
import logger from '@/utils/logger';
import { PlayerEngine, type PlayerEngineEvents } from '@/utils/player';
import type { Song } from '@/models/song';
import type { PlayerErrorPayload } from '../../shared/player-error';

import { createPlayerState } from './player/state';
import { createPlaybackManager } from './player/playback';
import { createAudioManager } from './player/audio';
import { createResolver } from './player/resolver';
import { createHistoryManager } from './player/history';
import { createDeviceManager } from './player/device';
import {
  createPlayerEventBus,
  type PlayerEventName,
  type PlayerEventPayload,
} from './player/events';
import type { PlaybackSource, ResolvedAudioSource } from './player/types';
import {
  buildMediaMeta,
  buildMediaState,
  findTrackById,
  resolvePlaybackNotice,
} from './player/utils';
import { toRawSong } from './playlist/helpers';
import {
  beginPlaybackIntent,
  clearPlaybackIntent,
  completePlaybackIntent,
  getPlaybackDisplayState,
  getPlaybackIsLoading,
  getPlaybackIsPlaying,
  getPlaybackTargetTrackId,
  isPlaybackIntentPhase,
  setEnginePlaybackStatus,
  setPlaybackIntentPlayback,
  shouldIgnoreEnginePause,
} from './player/stateMachine';

const engine = new PlayerEngine();

export const usePlayerStore = defineStore(
  'player',
  () => {
    const state = reactive(createPlayerState());
    const playlistStore = usePlaylistStore();
    const settingStore = useSettingStore();
    const lyricStore = useLyricStore();
    const toastStore = useToastStore();

    const resolver = createResolver(state, playlistStore, settingStore);
    const historyManager = createHistoryManager(state);

    // 播放生命周期事件总线：随 store 单例创建，全程存活，供插件等订阅方感知播放事件
    const playerEvents = createPlayerEventBus();
    const getPlayerEventPayload = (
      event: PlayerEventName,
      extra?: Partial<PlayerEventPayload>,
    ): PlayerEventPayload => ({
      event,
      track: state.currentTrackSnapshot ?? null,
      trackId: state.currentTrackId != null ? String(state.currentTrackId) : null,
      currentTime: state.currentTime,
      duration: state.duration,
      isPlaying: getPlaybackIsPlaying(state),
      ...extra,
    });
    const emitPlayerEvent = (event: PlayerEventName, extra?: Partial<PlayerEventPayload>) =>
      playerEvents.emit(event, getPlayerEventPayload(event, extra));

    const playbackTargetTrackId = computed(() => getPlaybackTargetTrackId(state));
    const playbackIsLoading = computed(() => getPlaybackIsLoading(state));
    const isLoading = computed(() => getPlaybackIsLoading(state));
    const isPlaying = computed(() => getPlaybackIsPlaying(state));
    const playbackDisplayState = computed(() => getPlaybackDisplayState(state));

    const getResolvedPlaybackSources = (resolved: ResolvedAudioSource): PlaybackSource[] => {
      const fallbackTrackId = resolved.source?.audioTrackId ?? resolved.audioTrackId ?? null;
      const toSource = (
        source: PlaybackSource | string | null | undefined,
      ): PlaybackSource | null => {
        const candidate =
          typeof source === 'string'
            ? { url: source, audioTrackId: fallbackTrackId }
            : {
                url: String(source?.url || '').trim(),
                audioTrackId: source?.audioTrackId ?? fallbackTrackId,
              };
        return candidate.url ? candidate : null;
      };
      const sources: PlaybackSource[] = [];
      [
        toSource(resolved.source) ?? toSource(resolved.url),
        ...(resolved.sources ?? []),
        ...(resolved.urls ?? []),
      ].forEach((item) => {
        const source = toSource(item);
        if (!source) return;
        const key = `${source.audioTrackId ? `mkv:${source.audioTrackId}:` : ''}${source.url}`;
        if (
          !sources.some(
            (existing) =>
              `${existing.audioTrackId ? `mkv:${existing.audioTrackId}:` : ''}${existing.url}` ===
              key,
          )
        ) {
          sources.push(source);
        }
      });
      return sources;
    };

    // 切歌与跳转事件来自状态跃迁，覆盖所有调用路径（含快捷键、媒体控制、mini 播放器等）
    watch(
      () => state.currentTrackId,
      () => emitPlayerEvent('trackchange'),
    );
    watch(
      () => state.seekTimestamp,
      (next, prev) => {
        if (next && next !== prev) emitPlayerEvent('seek');
      },
    );
    // 同步播放状态到主进程，更新 Windows 任务栏缩略图按钮图标
    watch(
      () => getPlaybackIsPlaying(state),
      (isPlaying) => {
        window.electron?.ipcRenderer?.send('thumbar:update-play-state', isPlaying);
      },
    );
    const syncMediaSkipIntervals = () => {
      engine.updateMediaSkipIntervals({
        forwardOffset: settingStore.seekForwardOffset ?? 5,
        backwardOffset: settingStore.seekBackwardOffset ?? 5,
      });
    };
    watch(
      () => [settingStore.seekForwardOffset, settingStore.seekBackwardOffset],
      syncMediaSkipIntervals,
      { immediate: true },
    );

    const refreshCurrentTrack = async () => {
      if (!state.currentTrackId) return;
      if (getPlaybackIsLoading(state)) {
        state.pendingSettingRefresh = true;
        return;
      }
      const requestSeq = ++state.playbackRequestSeq;
      const track = findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore);
      if (!track) return;

      state.pendingSettingRefresh = false;
      const wasPlaying = getPlaybackIsPlaying(state);
      const previousTime = state.currentTime;
      beginPlaybackIntent(state, {
        seq: requestSeq,
        trackId: String(state.currentTrackId),
        sourceQueueId: state.currentSourceQueueId,
        shouldPlay: wasPlaying,
      });

      const resolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      if (requestSeq !== state.playbackRequestSeq) return;
      if (!resolved.url) {
        completePlaybackIntent(state, requestSeq, { isPlaying: false });
        setEnginePlaybackStatus(state, 'error');
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        return;
      }

      clearPlaybackNotice();

      audioManager.setVolume(state.volume);
      if (requestSeq !== state.playbackRequestSeq) return;

      const playbackSources = getResolvedPlaybackSources(resolved);
      const playbackSource = playbackSources[0] ?? { url: resolved.url };
      state.currentAudioUrl = playbackSource.url;
      state.currentPlaybackSource = playbackSource;
      state.currentAudioCandidateUrls = playbackSources.map((source) => source.url);
      state.currentAudioCandidateSources = playbackSources;
      state.currentAudioCandidateIndex = 0;
      state.currentResolvedAudioQuality = resolved.quality;
      state.currentResolvedAudioEffect = resolved.effect;
      track.audioUrl = playbackSource.url;
      const savedDuration = state.duration;
      await engine.setSource(playbackSource);
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
        state.currentTimeUpdatedAt = Date.now();
      }

      let resumed = !wasPlaying;
      if (wasPlaying) {
        try {
          await engine.play();
          if (requestSeq !== state.playbackRequestSeq) return;
          resumed = true;
        } catch (error) {
          logger.error('PlayerStore', 'Reload track failed:', error);
          resumed = false;
        }
      }
      if (!state.duration && !engine.duration && track.duration) state.duration = track.duration;
      if (wasPlaying && resumed) engine.setVolume(state.volume);
      completePlaybackIntent(state, requestSeq, { isPlaying: wasPlaying && resumed });
      setEnginePlaybackStatus(state, wasPlaying && resumed ? 'playing' : 'paused');
      if (state.pendingSettingRefresh) {
        state.pendingSettingRefresh = false;
        void refreshCurrentTrack();
      }
    };

    const audioManager = createAudioManager(state, engine, refreshCurrentTrack);
    const getActiveImpulseResponsePath = () => {
      if (!settingStore.impulseResponseEnabled) return null;
      return settingStore.getSelectedImpulseResponse()?.path ?? null;
    };
    const showPlaybackNotice = (code: string, track?: Song | null) => {
      const userStore = useUserStore();
      const vipInfo = (userStore.info?.extendsInfo?.vip as any) || {};
      const busiVip: any[] = vipInfo?.busi_vip || [];
      const hasSvip = busiVip.some((v: any) => v.product_type === 'svip' && v.is_vip === 1);
      const hasTvip = busiVip.some((v: any) => v.product_type === 'tvip' && v.is_vip === 1);
      const isUserNovip = userStore.isLoggedIn && !hasSvip && !hasTvip;

      state.playbackNotice = resolvePlaybackNotice({
        code,
        track,
        autoNextEnabled: settingStore.autoNext,
        autoNextDelaySeconds: settingStore.autoNextDelaySeconds,
        isUserNovip,
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

    const recoverPlaybackStatusAfterOutputChange = (
      playerState: {
        playing?: boolean;
        paused?: boolean;
        duration?: number;
        timePos?: number;
      } | null,
    ) => {
      if (!playerState?.playing && !playerState?.paused) return;
      if (
        state.enginePlayback.status !== 'error' &&
        state.playbackIntent.phase !== 'failed' &&
        !state.playbackNotice
      )
        return;

      state.lastError = null;
      state.awaitingTrackLoad = false;
      clearPlaybackNotice(state.currentTrackId);

      if (typeof playerState.duration === 'number' && playerState.duration > 0) {
        state.duration = playerState.duration;
      }
      if (typeof playerState.timePos === 'number' && playerState.timePos >= 0) {
        state.currentTime = playerState.timePos;
        state.currentTimeUpdatedAt = Date.now();
      }

      setPlaybackIntentPlayback(state, Boolean(playerState.playing));
      setEnginePlaybackStatus(state, playerState.playing ? 'playing' : 'paused');
      settingStore.syncPreventSleep(Boolean(playerState.playing));
      engine.updateMediaPlaybackState(buildMediaState(state));
    };

    const deviceManager = createDeviceManager(state, engine, settingStore, {
      recoverPlaybackStatusAfterOutputChange,
    });

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
    let impulseResponseFailureListenerRegistered = false;
    let audioDeviceListListenerRegistered = false;

    const toggleLyricView = (open?: boolean) => {
      state.isLyricViewOpen = open ?? !state.isLyricViewOpen;
    };

    // 切歌重入保护：防止极短音频 / 临近结尾 seek / 异常重复 EOF 等场景下
    // handlePlaybackEnded 在上一次切歌尚未完成时被再次触发，导致连续多次切换。
    let handlingPlaybackEnd = false;
    const handlePlaybackEnded = async () => {
      if (handlingPlaybackEnd) return;
      handlingPlaybackEnd = true;
      try {
        if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
          const playedQueuedNext = await playbackManager.playQueuedNextOutsidePersonalFm({
            track: state.currentTrackSnapshot,
            playtime: state.duration,
            isOverplay: true,
          });
          if (playedQueuedNext) return;

          const nextFmSong = await playlistStore.consumeNextPersonalFmTrack({
            track: state.currentTrackSnapshot,
            playtime: state.duration,
            isOverplay: true,
          });

          if (nextFmSong) {
            await playbackManager.playTrack(
              String(nextFmSong.id),
              playlistStore.activeQueue.songs,
              {
                sourceQueueId: PERSONAL_FM_QUEUE_ID,
              },
            );
          } else {
            playbackManager.stop();
          }
          return;
        }
        if (state.playMode === 'single') {
          if (state.currentPlaybackSource || state.currentAudioUrl) {
            void engine
              .setSource(state.currentPlaybackSource ?? state.currentAudioUrl)
              .then(() => engine.play())
              .catch((error) => logger.warn('PlayerStore', 'Loop restart failed:', error));
          }
          return;
        }
        await playbackManager.next({ gaplessTransition: settingStore.gaplessPlayback });
      } finally {
        handlingPlaybackEnd = false;
      }
    };

    const registerSettingWatchers = () => {
      if (state.settingsWatcherRegistered) return;
      state.settingsWatcherRegistered = true;
      let snapshot = {
        defaultAudioQuality: settingStore.defaultAudioQuality,
        compatibilityMode: settingStore.compatibilityMode,
        volumeFade: settingStore.volumeFade,
        volumeFadeTime: settingStore.volumeFadeTime,
        gaplessPlayback: settingStore.gaplessPlayback,
        outputDevice: settingStore.outputDevice,
        exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
        impulseResponsePath: getActiveImpulseResponsePath(),
        impulseResponseMix: settingStore.impulseResponseMix,
        playbackStallTimeout: settingStore.playbackStallTimeout,
      };
      // 保存取消函数，以便在需要时清理订阅
      const unsubscribeSettings = settingStore.$subscribe(() => {
        const shouldRefresh =
          (state.currentAudioQualityOverride === null &&
            settingStore.defaultAudioQuality !== snapshot.defaultAudioQuality) ||
          settingStore.compatibilityMode !== snapshot.compatibilityMode;
        const shouldUpdateFade =
          settingStore.volumeFade !== snapshot.volumeFade ||
          settingStore.volumeFadeTime !== snapshot.volumeFadeTime;
        const shouldUpdateGapless = settingStore.gaplessPlayback !== snapshot.gaplessPlayback;
        const shouldUpdateOutputDevice =
          settingStore.outputDevice !== snapshot.outputDevice ||
          settingStore.exclusiveAudioDevice !== snapshot.exclusiveAudioDevice;
        const nextImpulseResponsePath = getActiveImpulseResponsePath();
        const shouldLoadImpulseResponse = nextImpulseResponsePath !== snapshot.impulseResponsePath;
        const shouldUpdateImpulseResponseMix =
          settingStore.impulseResponseMix !== snapshot.impulseResponseMix;
        const shouldUpdateStallTimeout =
          settingStore.playbackStallTimeout !== snapshot.playbackStallTimeout;
        snapshot = {
          defaultAudioQuality: settingStore.defaultAudioQuality,
          compatibilityMode: settingStore.compatibilityMode,
          volumeFade: settingStore.volumeFade,
          volumeFadeTime: settingStore.volumeFadeTime,
          gaplessPlayback: settingStore.gaplessPlayback,
          outputDevice: settingStore.outputDevice,
          exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
          impulseResponsePath: nextImpulseResponsePath,
          impulseResponseMix: settingStore.impulseResponseMix,
          playbackStallTimeout: settingStore.playbackStallTimeout,
        };
        if (shouldRefresh) {
          if (getPlaybackIsLoading(state) || state.pendingSettingRefresh)
            state.pendingSettingRefresh = true;
          else void refreshCurrentTrack();
        }
        if (shouldUpdateFade && getPlaybackIsPlaying(state)) {
          void audioManager.fadeVolume(state.volume, { durationMs: 120, respectUserVolume: false });
        }
        if (shouldUpdateGapless && !settingStore.gaplessPlayback)
          playbackManager.clearGaplessPreparedSource();
        if (shouldUpdateOutputDevice)
          void deviceManager.applyOutputDevice(settingStore.outputDevice);
        if (shouldLoadImpulseResponse)
          audioManager.setImpulseResponse(nextImpulseResponsePath, settingStore.impulseResponseMix);
        else if (shouldUpdateImpulseResponseMix)
          audioManager.setImpulseResponseMix(settingStore.impulseResponseMix);
        if (shouldUpdateStallTimeout)
          engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
      });
      // 返回清理函数
      return () => {
        unsubscribeSettings();
      };
    };

    const disableActiveImpulseResponse = (failedPath?: string) => {
      const active = settingStore.getSelectedImpulseResponse();
      if (failedPath && active?.path && active.path !== failedPath) return;
      if (!settingStore.impulseResponseEnabled) return;
      settingStore.impulseResponseEnabled = false;
      audioManager.setImpulseResponse(null, settingStore.impulseResponseMix);
      toastStore.warning('空间音效加载失败，已自动关闭', 4200);
    };

    const restorePlaybackSessionFromQueue = () => {
      const activeQueue = playlistStore.activeQueue;
      const activeSongs = activeQueue?.songs ?? [];
      const queueTrackId = String(activeQueue?.currentTrackId ?? '');
      const persistedTrackId = String(state.currentTrackId ?? '');
      const targetTrackId = queueTrackId || persistedTrackId;
      const targetTrack = targetTrackId
        ? activeSongs.find((song) => String(song.id) === targetTrackId)
        : undefined;

      clearPlaybackIntent(state);
      setEnginePlaybackStatus(state, 'idle');
      state.currentTime = 0;
      state.currentTimeUpdatedAt = Date.now();
      state.currentAudioUrl = '';
      state.currentPlaybackSource = null;
      state.currentAudioCandidateUrls = [];
      state.currentAudioCandidateSources = [];
      state.currentAudioCandidateIndex = -1;
      state.currentResolvedAudioQuality = null;
      state.currentResolvedAudioEffect = 'none';
      state.currentAudioQualityOverride = null;
      state.historyUploadCommitted = false;
      state.historyUploadTrackId = null;

      if (!targetTrack || !targetTrackId) {
        if (queueTrackId && activeQueue) {
          playlistStore.updateQueueCurrentTrack(null, activeQueue.id);
        }
        state.currentTrackId = null;
        state.currentSourceQueueId = null;
        state.currentPlaylist = null;
        state.currentTrackSnapshot = null;
        state.duration = 0;
        state.lastError = null;
        clearPlaybackNotice();
        engine.updateMediaPlaybackState(buildMediaState(state));
        return;
      }

      state.currentTrackId = targetTrackId;
      state.currentSourceQueueId = activeQueue?.id ?? playlistStore.activeQueueId ?? null;
      state.currentPlaylist = activeSongs.length > 0 ? activeSongs : null;
      state.currentTrackSnapshot = toRawSong(targetTrack);
      state.duration = targetTrack.duration || 0;
      state.lastError = null;
      clearPlaybackNotice();

      const mediaMeta = buildMediaMeta(targetTrack);
      if (mediaMeta) {
        engine.updateMediaMetadata({
          ...mediaMeta,
          durationMs: (targetTrack.duration || 0) * 1000,
        });
      }
      engine.updateMediaPlaybackState(buildMediaState(state));
    };

    const init = () => {
      // 提前注册 MediaSession handlers，避免启动时丢失系统媒体控制事件
      engine.setMediaSessionHandlers({
        play: () => {
          if (!getPlaybackIsPlaying(state)) playbackManager.togglePlay();
        },
        pause: () => {
          if (getPlaybackIsPlaying(state)) playbackManager.togglePlay();
        },
        previoustrack: () => playbackManager.prev(),
        nexttrack: () => playbackManager.next(),
        seekto: (time) => playbackManager.seek(time),
        seekbackward: (offset) =>
          playbackManager.seek(
            Math.max(0, state.currentTime - (offset ?? settingStore.seekBackwardOffset ?? 5)),
          ),
        seekforward: (offset) =>
          playbackManager.seek(
            Math.min(
              state.duration,
              state.currentTime + (offset ?? settingStore.seekForwardOffset ?? 5),
            ),
          ),
      });

      restorePlaybackSessionFromQueue();
      audioManager.setVolume(state.volume);
      engine.setPlaybackRate(state.playbackRate);
      engine.setEqualizer(state.equalizerGains);
      if (!settingStore.impulseResponseSafetyMigrationDone) {
        settingStore.impulseResponseEnabled = false;
        settingStore.impulseResponseSafetyMigrationDone = true;
      }
      void settingStore
        .reconcileImpulseResponseFiles()
        .finally(() =>
          engine.setImpulseResponse(
            getActiveImpulseResponsePath(),
            settingStore.impulseResponseMix,
          ),
        );
      engine.setVolumeNormalization(settingStore.volumeNormalization);
      engine.setReferenceLufs(settingStore.volumeNormalizationLufs);
      engine.setLoopFile(state.playMode === 'single');
      engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
      registerSettingWatchers();
      if (!impulseResponseFailureListenerRegistered) {
        impulseResponseFailureListenerRegistered = true;
        window.electron?.player?.onImpulseResponseDisabled?.((payload) => {
          disableActiveImpulseResponse(payload?.path);
        });
      }
      if (!audioDeviceListListenerRegistered) {
        audioDeviceListListenerRegistered = true;
        window.electron?.player?.onAudioDeviceListChanged?.((payload) => {
          void deviceManager.refreshOutputDevices(payload);
        });
        window.electron?.player?.onCoreStateChange?.((payload) => {
          deviceManager.handleCoreStateChange(payload);
        });
      }
      void deviceManager.refreshOutputDevices();

      let lastMediaSessionSync = 0;
      const MEDIA_SESSION_SYNC_MS = 2000;
      let lastHistoryCheck = 0;
      const HISTORY_CHECK_MS = 5000;
      let lastEventTimeUpdate = 0;
      const EVENT_TIMEUPDATE_MS = 1000;

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime) => {
          // 切歌加载护栏：新文件 file-loaded 之前到达的回报多为上一首的残留位置，一律丢弃，
          // 避免进度条切歌瞬间先跳到旧进度再归零
          if (state.awaitingTrackLoad) return;
          // 卡死恢复护栏：reload 期间还没追回断点的回报值（含归零）一律忽略，UI 停在断点不跳动；
          // 追回到断点附近或超时兜底后解除护栏。
          if (state.stallRecovering) {
            if (
              Date.now() < state.stallRecoverDeadline &&
              currentTime < state.stallRecoverTarget - 1
            )
              return;
            state.stallRecovering = false;
          }
          state.currentTime = currentTime;
          state.currentTimeUpdatedAt = Date.now();
          playbackManager.prepareGaplessNext();
          const now = Date.now();
          if (now - lastEventTimeUpdate >= EVENT_TIMEUPDATE_MS) {
            lastEventTimeUpdate = now;
            emitPlayerEvent('timeupdate');
          }
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
          // 切歌加载护栏：file-loaded 之前的 duration 回报（含 setSource 的归零与上一首残留）一律丢弃，
          // 真实时长在 fileLoaded 时从引擎补回
          if (state.awaitingTrackLoad) return;
          // 卡死恢复 reload 期间，player 会先回报 duration=0，忽略以免进度条最大值瞬间归零
          if (state.stallRecovering && duration <= 0) return;
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
        fileLoaded: (payload) => {
          if (playbackManager.activateGaplessPreparedTransition(payload?.seq)) return;
          // 新文件真正加载完成，解除切歌加载护栏，放行后续进度回报
          if (!state.awaitingTrackLoad) return;
          state.awaitingTrackLoad = false;
          setEnginePlaybackStatus(state, 'loading');
          // 补回加载窗口内被丢弃的真实时长，避免进度条最大值停留在 0
          if (engine.duration > 0) {
            state.duration = engine.duration;
            engine.updateMediaPlaybackState(buildMediaState(state));
          }
        },
        ended: () => {
          if (state.awaitingTrackLoad) return;
          setEnginePlaybackStatus(state, 'stopped');
          if (!state.recentSeekIgnoreEnd) {
            emitPlayerEvent('ended');
            handlePlaybackEnded();
          } else state.recentSeekIgnoreEnd = false;
        },
        play: () => {
          setEnginePlaybackStatus(state, 'playing');
          if (isPlaybackIntentPhase(state, 'loading')) {
            completePlaybackIntent(state, state.playbackIntent.seq, { isPlaying: true });
          } else {
            setPlaybackIntentPlayback(state, true);
          }
          clearPlaybackNotice(state.currentTrackId);
          settingStore.syncPreventSleep(true);
          engine.updateMediaPlaybackState(buildMediaState(state));
          emitPlayerEvent('play');
          // 本地历史记录已在 playback.ts 的 playTrack 中调用
          // 此处不再重复调用，避免同一首歌被记录两次
        },
        pause: () => {
          if (shouldIgnoreEnginePause(state)) return;
          setEnginePlaybackStatus(state, 'paused');
          setPlaybackIntentPlayback(state, false);
          settingStore.syncPreventSleep(false);
          engine.updateMediaPlaybackState(buildMediaState(state));
          emitPlayerEvent('pause');
        },
        error: (event) => {
          if (event && !event.isTrusted && !(event as any)?.detail) return;
          void (async () => {
            const detail = (event as CustomEvent<PlayerErrorPayload> | undefined)?.detail;
            const wasPlayingBeforeOutputError = getPlaybackIsPlaying(state);
            if (detail?.message && (await deviceManager.handleOutputDeviceError(detail))) {
              engine.updateMediaPlaybackState(buildMediaState(state));
              if (wasPlayingBeforeOutputError && !getPlaybackIsPlaying(state)) {
                emitPlayerEvent('pause');
              }
              return;
            }

            const triedFallback = await playbackManager.tryNextAudioCandidate({
              reason: 'player-error',
              position: state.currentTime,
            });
            if (triedFallback) return;

            state.lastError = (event as any)?.type ?? 'playback-error';
            setEnginePlaybackStatus(state, 'error');
            showPlaybackNotice('playback-failed', state.currentTrackSnapshot);
            playbackManager.applyFailedPlaybackState({ keepResolvedSource: true });
            settingStore.syncPreventSleep(false);
            if (settingStore.autoNext && state.currentPlaylist?.length)
              playbackManager.scheduleAutoNext();
            else playbackManager.clearAutoNextTimer();
            emitPlayerEvent('error', { error: state.lastError ?? 'playback-error' });
          })();
        },
        stalled: (position) => {
          void playbackManager.recoverFromStall(position);
        },
        seeked: (currentTime) => {
          state.seekTargetTime = null;
          state.currentTime = currentTime;
          state.currentTimeUpdatedAt = Date.now();
          engine.updateMediaPlaybackState(buildMediaState(state));
        },
      };
      engine.setEvents(events);
      window.electron?.player?.getState?.().then((playerState) => {
        if (!playerState) return;
        if (playerState.playing && !getPlaybackIsPlaying(state)) {
          setPlaybackIntentPlayback(state, true);
          settingStore.syncPreventSleep(true);
        }
        setEnginePlaybackStatus(
          state,
          playerState.playing ? 'playing' : playerState.paused ? 'paused' : 'idle',
        );
        if (playerState.duration > 0) state.duration = playerState.duration;
        if (playerState.timePos > 0) {
          state.currentTime = playerState.timePos;
          state.currentTimeUpdatedAt = Date.now();
        }
      });
    };

    const setVolumeSmooth = async (value: number, durationMs?: number) => {
      await engine.fadeTo(value, durationMs ?? 1000);
      state.volume = engine.volume;
      if (state.volume > 0) state.lastNonZeroVolume = state.volume;
    };

    // Explicitly return state and actions to help TypeScript
    return {
      ...toRefs(state),
      isPlaying,
      isLoading,
      playbackTargetTrackId,
      playbackIsLoading,
      playbackDisplayState,
      // State-like (actually actions but Pinia treats them as actions)
      getEffectiveAudioQuality: resolver.getEffectiveAudioQuality,
      getResolvedAudioQuality: resolver.getResolvedAudioQuality,
      ensureTrackRelateGoods: resolver.ensureTrackRelateGoods,
      resolveAudioUrl: resolver.resolveAudioUrl,
      fetchClimaxMarks: resolver.fetchClimaxMarks,

      resetHistoryUploadState: historyManager.resetHistoryUploadState,
      commitListeningHistory: historyManager.commitListeningHistory,

      setVolume: audioManager.setVolume,
      adjustVolume: audioManager.adjustVolume,
      toggleMute: audioManager.toggleMute,
      setPlaybackRate: audioManager.setPlaybackRate,
      setPlayMode: audioManager.setPlayMode,
      setVolumeNormalization: audioManager.setVolumeNormalization,
      setReferenceLufs: audioManager.setReferenceLufs,
      setEq: audioManager.setEq,
      setImpulseResponse: audioManager.setImpulseResponse,
      setAudioEffect: audioManager.setAudioEffect,
      fadeVolume: audioManager.fadeVolume,
      setCurrentAudioQualityOverride: audioManager.setCurrentAudioQualityOverride,

      refreshOutputDevices: deviceManager.refreshOutputDevices,
      applyOutputDevice: deviceManager.applyOutputDevice,

      playTrack: playbackManager.playTrack,
      togglePlay: playbackManager.togglePlay,
      seek: playbackManager.seek,
      next: playbackManager.next,
      dislikePersonalFm: playbackManager.dislikePersonalFm,
      prev: playbackManager.prev,
      stop: playbackManager.stop,

      toggleLyricView,
      showPlaybackNotice,
      clearPlaybackNotice,
      refreshCurrentTrack,
      init,
      setVolumeSmooth,
      onPlayerEvent: playerEvents.on,
      getPlayerEventPayload,
    };
  },
  {
    persist: {
      pick: [
        'volume',
        'lastNonZeroVolume',
        'playMode',
        'currentTrackId',
        'playbackRate',
        'audioEffect',
        'equalizerGains',
      ],
    },
  },
);
