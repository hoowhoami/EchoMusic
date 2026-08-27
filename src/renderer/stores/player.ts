import { defineStore } from 'pinia';
import { computed, reactive, toRefs, watch } from 'vue';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import { useToastStore } from './toast';
import { useUserStore } from './user';
import logger from '@/utils/logger';
import { normalizePlayerErrorPayload, PlayerEngine, type PlayerEngineEvents } from '@/utils/player';
import type { Song } from '@/models/song';
import type { PlayerErrorPayload } from '../../shared/player-error';
import type { AudioEffectPlaybackOptions, SpatialAudioEffectEntry } from '../../shared/audio';
import { createLatestRequestQueue } from '../../shared/latest-request-queue';
import { spatialAudioEffectOptions } from '../../shared/audio-effect-support';

import { createPlayerState } from './player/state';
import { createPlaybackManager } from './player/playback';
import { createAudioManager } from './player/audio';
import { createResolver } from './player/resolver';
import { createHistoryManager } from './player/history';
import { createListeningTimeManager } from './player/listeningTime';
import { createDeviceManager } from './player/device';
import { createSpatialAudioSupport } from './player/spatialAudioSupport';
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
  normalizeEffect,
  resolvePlaybackNotice,
} from './player/utils';
import { toRawSong } from './playlist/helpers';
import {
  abortNativeTrackLoad,
  beginNativeTrackLoad,
  beginPlaybackIntent,
  bindNativeTrackLoad,
  clearPlaybackIntent,
  completePlaybackIntent,
  getPlaybackHasFailed,
  getPlaybackDisplayState,
  getPlaybackIsLoading,
  getPlaybackIsPlaying,
  getPlaybackTargetTrackId,
  isPlaybackIntentPhase,
  setEnginePlaybackStatus,
  setPlaybackIntentPlayback,
  shouldIgnoreEnginePause,
} from './player/stateMachine';

export const usePlayerStore = defineStore(
  'player',
  () => {
    const engine = new PlayerEngine();
    const state = reactive(createPlayerState());
    const playlistStore = usePlaylistStore();
    const settingStore = useSettingStore();
    const lyricStore = useLyricStore();
    const toastStore = useToastStore();

    const resolver = createResolver(state, playlistStore, settingStore);
    const historyManager = createHistoryManager(state);
    const listeningTimeManager = createListeningTimeManager(state);

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
      beginNativeTrackLoad(state);

      let resolved: ResolvedAudioSource;
      try {
        resolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      } catch (error) {
        if (requestSeq !== state.playbackRequestSeq) return;
        abortNativeTrackLoad(state);
        completePlaybackIntent(state, requestSeq, { isPlaying: false });
        setEnginePlaybackStatus(state, 'error');
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        logger.error('PlayerStore', 'Refresh track source resolution failed:', error);
        return;
      }
      if (requestSeq !== state.playbackRequestSeq) return;
      if (!resolved.url) {
        abortNativeTrackLoad(state);
        completePlaybackIntent(state, requestSeq, { isPlaying: false });
        setEnginePlaybackStatus(state, 'error');
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        return;
      }

      if (resolved.noticeCode) {
        showPlaybackNotice(resolved.noticeCode, track);
      } else {
        clearPlaybackNotice(state.currentTrackId);
      }

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
      state.currentResolvedAudioLoudness = resolved.loudness;
      state.currentResolvedSourceKind = resolved.sourceKind ?? 'catalog';
      track.audioUrl = playbackSource.url;
      const savedDuration = state.duration;
      try {
        await engine.setSource(playbackSource, { force: true });
      } catch (error) {
        if (requestSeq === state.playbackRequestSeq) {
          abortNativeTrackLoad(state);
          completePlaybackIntent(state, requestSeq, { isPlaying: false });
          setEnginePlaybackStatus(state, 'error');
          state.lastError = 'playback-failed';
          showPlaybackNotice('playback-failed', track);
        }
        logger.error('PlayerStore', 'Refresh track reload failed:', error);
        return;
      }
      if (requestSeq !== state.playbackRequestSeq) return;
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
            if (requestSeq !== state.playbackRequestSeq) return;
            actualDuration = engine.duration;
            if (actualDuration > 0) break;
          }
        }
        if (requestSeq !== state.playbackRequestSeq) return;
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
      if (requestSeq !== state.playbackRequestSeq) return;
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
    const configuredProviderPath = () =>
      settingStore.dspProviderEnabled
        ? settingStore.dspProviderPath.trim() || undefined
        : undefined;
    const configuredProviderMode = (): 'headphone' | 'speaker' =>
      settingStore.dspProviderMode === 'headphone' ? 'headphone' : 'speaker';
    const configuredProviderPreset = () => settingStore.dspProviderPresetJson.trim() || undefined;
    const ensureConfiguredProviderPath = async () => {
      if (!settingStore.dspProviderEnabled) return undefined;
      const savedPath = configuredProviderPath();
      if (savedPath) return savedPath;
      const providers = await window.electron.player.listDspProviders();
      if (!settingStore.dspProviderEnabled) return undefined;
      if (configuredProviderPath()) return configuredProviderPath();
      if (providers.length !== 1) return undefined;
      settingStore.configureDspProvider(providers[0], settingStore.dspProviderMode);
      return providers[0];
    };
    const refreshAudioGraphSnapshot = async () => {
      const graph = await engine.getAudioGraph();
      state.playbackDiagnostics.graph = graph
        ? {
            ...graph,
            updatedAt: Date.now(),
          }
        : null;
    };
    const spatialAudioSupport = createSpatialAudioSupport({
      providerPath: configuredProviderPath,
      providerMode: configuredProviderMode,
      graph: () => state.playbackDiagnostics.graph,
      selected: () => settingStore.getSelectedImpulseResponse(),
      enabled: () => settingStore.impulseResponseEnabled,
      inspect: (path) => window.electron.player.inspectDspProvider(path),
      unsupported: (file, reason) => {
        settingStore.selectOriginalSpatialAudio();
        toastStore.warning(`“${file.name}”暂不可用：${reason}，已切换为原声，文件仍保留`, 5000);
      },
    });
    const getSpatialAudioEffectSupport = (file: SpatialAudioEffectEntry) =>
      spatialAudioSupport.support(file);
    const selectSpatialAudioEffect = (id: string): boolean => {
      const file = settingStore.impulseResponseFiles.find((item) => item.id === id);
      if (!file) return false;
      const support = getSpatialAudioEffectSupport(file);
      if (support.status !== 'supported') {
        toastStore.warning(support.reason);
        return false;
      }
      if (settingStore.impulseResponseEnabled && settingStore.selectedImpulseResponseId === id)
        return true;
      settingStore.setSelectedImpulseResponse(id);
      return true;
    };
    const getActiveSpatialAudioEffect = (): AudioEffectPlaybackOptions | null => {
      const file = settingStore.getSelectedImpulseResponse();
      return spatialAudioEffectOptions({
        providerPath: configuredProviderPath(),
        providerMode: configuredProviderMode(),
        providerPresetJson: configuredProviderPreset(),
        enabled: settingStore.impulseResponseEnabled,
        file,
        support: file ? getSpatialAudioEffectSupport(file) : undefined,
        impulseResponseMix: file ? settingStore.getImpulseResponseMix(file.id) : undefined,
      });
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
      state.supersededNativeTrackSeq = null;
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
      (error) => deviceManager.handleOutputDeviceError(normalizePlayerErrorPayload(error)),
    );
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
            const restartTrackId = state.currentTrackId;
            const restartSeq = state.playbackRequestSeq;
            beginNativeTrackLoad(state);
            let nativeLoadCompleted = false;
            void (async () => {
              await engine.setSource(state.currentPlaybackSource ?? state.currentAudioUrl, {
                force: true,
              });
              nativeLoadCompleted = true;
              if (
                restartSeq !== state.playbackRequestSeq ||
                String(state.currentTrackId ?? '') !== String(restartTrackId ?? '')
              ) {
                return;
              }
              await engine.play();
            })().catch((error) => {
              if (
                restartSeq === state.playbackRequestSeq &&
                String(state.currentTrackId ?? '') === String(restartTrackId ?? '') &&
                !nativeLoadCompleted
              ) {
                abortNativeTrackLoad(state);
              }
              logger.warn('PlayerStore', 'Loop restart failed:', error);
            });
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
        playbackStallTimeout: settingStore.playbackStallTimeout,
        pauseOnOutputDeviceDisconnect: settingStore.pauseOnOutputDeviceDisconnect,
        volumeNormalization: settingStore.volumeNormalization,
        volumeNormalizationLufs: settingStore.volumeNormalizationLufs,
      };
      const unsubscribePauseOnDeviceDisconnect = watch(
        () => settingStore.pauseOnOutputDeviceDisconnect,
        (enabled) => {
          void window.electron?.player?.setPauseOnDeviceDisconnect(enabled);
        },
        { immediate: true },
      );
      // Capabilities can resolve without a settings mutation. Watch both the
      // persisted selection and runtime support through the effective command.
      const unsubscribeSpatialAudio = watch(
        () => JSON.stringify(getActiveSpatialAudioEffect()),
        () => spatialAudioEffectQueue.enqueue(getActiveSpatialAudioEffect()),
      );
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
        const shouldUpdateStallTimeout =
          settingStore.playbackStallTimeout !== snapshot.playbackStallTimeout;
        const shouldUpdateVolumeNormalization =
          settingStore.volumeNormalization !== snapshot.volumeNormalization;
        const shouldUpdateReferenceLufs =
          settingStore.volumeNormalizationLufs !== snapshot.volumeNormalizationLufs;
        snapshot = {
          defaultAudioQuality: settingStore.defaultAudioQuality,
          compatibilityMode: settingStore.compatibilityMode,
          volumeFade: settingStore.volumeFade,
          volumeFadeTime: settingStore.volumeFadeTime,
          gaplessPlayback: settingStore.gaplessPlayback,
          outputDevice: settingStore.outputDevice,
          exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
          playbackStallTimeout: settingStore.playbackStallTimeout,
          pauseOnOutputDeviceDisconnect: settingStore.pauseOnOutputDeviceDisconnect,
          volumeNormalization: settingStore.volumeNormalization,
          volumeNormalizationLufs: settingStore.volumeNormalizationLufs,
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
        if (shouldUpdateStallTimeout)
          engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
        if (shouldUpdateVolumeNormalization)
          audioManager.setVolumeNormalization(settingStore.volumeNormalization);
        if (shouldUpdateReferenceLufs)
          audioManager.setReferenceLufs(settingStore.volumeNormalizationLufs);
      });
      // 返回清理函数
      return () => {
        unsubscribePauseOnDeviceDisconnect();
        unsubscribeSpatialAudio();
        unsubscribeSettings();
      };
    };

    const disableActiveSpatialAudioEffect = (failedEffect?: AudioEffectPlaybackOptions | null) => {
      if (
        failedEffect &&
        JSON.stringify(getActiveSpatialAudioEffect()) !== JSON.stringify(failedEffect)
      )
        return;
      if (failedEffect?.providerPath) {
        if (configuredProviderPath() !== failedEffect.providerPath) return;
        if (failedEffect.providerResources?.length) {
          // A rejected file is not proof the engine itself cannot run. Unload
          // all of the file's resources, keep the engine and preserve downloads.
          settingStore.selectOriginalSpatialAudio();
          spatialAudioEffectQueue.enqueue(getActiveSpatialAudioEffect());
          toastStore.warning('音效应用失败，已切换为原声，文件仍保留', 4200);
          return;
        }
        settingStore.disableDspProvider();
        const builtinEffect = getActiveSpatialAudioEffect();
        spatialAudioEffectQueue.enqueue(builtinEffect);
        toastStore.warning(
          builtinEffect
            ? '第三方音效引擎加载失败，已改用内置音效处理'
            : '第三方音效引擎加载失败，已自动停用',
          4200,
        );
        return;
      }
      if (failedEffect) {
        const current = getActiveSpatialAudioEffect();
        if (current?.impulseResponsePath !== failedEffect.impulseResponsePath) {
          return;
        }
      }
      if (!settingStore.impulseResponseEnabled) return;
      settingStore.impulseResponseEnabled = false;
      spatialAudioEffectQueue.enqueue(null);
      toastStore.warning('音效加载失败，已自动关闭', 4200);
    };
    let appliedSpatialAudioEffect: AudioEffectPlaybackOptions | null | undefined;
    const canPatchBasicDspMix = (
      previous: AudioEffectPlaybackOptions | null | undefined,
      next: AudioEffectPlaybackOptions | null,
    ) =>
      !!previous &&
      !!next &&
      !previous.providerPath &&
      !next.providerPath &&
      !!previous.impulseResponsePath &&
      previous.impulseResponsePath === next.impulseResponsePath &&
      previous.impulseResponseMix !== next.impulseResponseMix;
    const applySpatialAudioEffect = async (effect: AudioEffectPlaybackOptions | null) => {
      if (canPatchBasicDspMix(appliedSpatialAudioEffect, effect)) {
        try {
          await engine.setAudioGraphParameter({
            kind: 'spatial',
            name: 'mix',
            value: effect?.impulseResponseMix ?? 0.5,
          });
        } catch {
          // A stale native build may not expose spatial.mix yet. Reloading preserves
          // correctness and keeps the setting usable while the addon is being updated.
          await engine.setSpatialAudioEffect(effect);
        }
      } else {
        await engine.setSpatialAudioEffect(effect);
      }
      appliedSpatialAudioEffect = effect ? { ...effect } : null;
    };
    const spatialAudioEffectQueue = createLatestRequestQueue<AudioEffectPlaybackOptions | null>({
      apply: applySpatialAudioEffect,
      applied: refreshAudioGraphSnapshot,
      failed: (effect) => disableActiveSpatialAudioEffect(effect),
      report: (error) => logger.warn('音效状态刷新失败', error),
    });

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
      state.nativeTrackSeq = null;
      state.supersededNativeTrackSeq = null;
      state.currentResolvedAudioQuality = null;
      state.currentResolvedAudioEffect = 'none';
      state.currentResolvedAudioLoudness = null;
      state.currentResolvedSourceKind = 'catalog';
      state.currentAudioQualityOverride = null;
      state.currentCatalogSourceOverrideTrackId = null;
      state.currentCloudSourceOverrideTrackId = null;
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
      state.nativeTrackSeq = null;
      state.supersededNativeTrackSeq = null;
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
      state.audioEffect = normalizeEffect(state.audioEffect);
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
      void (async () => {
        try {
          await ensureConfiguredProviderPath();
          await settingStore.reconcileSpatialAudioEffects();
        } catch (error) {
          logger.warn('音效设置恢复失败', error);
        }
        // Even a failed file reconciliation must not leave every library item
        // stuck in the initial capability-checking state.
        try {
          await spatialAudioSupport.start();
          spatialAudioEffectQueue.enqueue(getActiveSpatialAudioEffect());
        } catch (error) {
          logger.warn('音效能力检查失败', error);
        }
      })();
      engine.setVolumeNormalization(settingStore.volumeNormalization);
      engine.setReferenceLufs(settingStore.volumeNormalizationLufs);
      engine.setLoopFile(state.playMode === 'single');
      engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
      registerSettingWatchers();
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
      const isCurrentNativePlaybackContext = (payload?: { trackSeq?: number }) => {
        const trackSeq = Number(payload?.trackSeq);
        if (!Number.isFinite(trackSeq) || trackSeq <= 0) return true;
        return state.nativeTrackSeq === null || state.nativeTrackSeq === trackSeq;
      };

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime, payload) => {
          if (!isCurrentNativePlaybackContext(payload) || getPlaybackHasFailed(state)) return;
          // Only file-loaded may bind the native sequence for a new track. While an
          // async source is resolving, these ticks can still belong to the old track.
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
          void playbackManager.prepareGaplessNext();
          const now = Date.now();
          if (now - lastEventTimeUpdate >= EVENT_TIMEUPDATE_MS) {
            lastEventTimeUpdate = now;
            emitPlayerEvent('timeupdate');
          }
          if (now - lastHistoryCheck >= HISTORY_CHECK_MS) {
            lastHistoryCheck = now;
            void historyManager.commitListeningHistory();
            void listeningTimeManager.tick();
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
          const payloadSeq =
            typeof payload?.seq === 'number' && Number.isFinite(payload.seq) && payload.seq > 0
              ? payload.seq
              : typeof payload?.trackSeq === 'number' &&
                  Number.isFinite(payload.trackSeq) &&
                  payload.trackSeq > 0
                ? payload.trackSeq
                : undefined;
          if (playbackManager.activateGaplessPreparedTransition(payloadSeq)) return;
          const expectedPath =
            state.currentPlaybackSource?.url ?? state.currentAudioUrl ?? undefined;
          if (
            state.awaitingTrackLoad &&
            payload?.path &&
            expectedPath &&
            payload.path !== expectedPath
          ) {
            return;
          }
          // 新文件真正加载完成，解除切歌加载护栏，放行后续进度回报
          if (!bindNativeTrackLoad(state, payloadSeq)) return;
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
          void listeningTimeManager.flush();
          if (!state.recentSeekIgnoreEnd) {
            emitPlayerEvent('ended');
            handlePlaybackEnded();
          } else state.recentSeekIgnoreEnd = false;
        },
        play: (payload) => {
          if (state.awaitingTrackLoad) return;
          if (!isCurrentNativePlaybackContext(payload) || getPlaybackHasFailed(state)) return;
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
        pause: (payload) => {
          if (
            !isCurrentNativePlaybackContext(payload) ||
            shouldIgnoreEnginePause(state) ||
            getPlaybackHasFailed(state)
          )
            return;
          setEnginePlaybackStatus(state, 'paused');
          setPlaybackIntentPlayback(state, false);
          void listeningTimeManager.flush();
          settingStore.syncPreventSleep(false);
          engine.updateMediaPlaybackState(buildMediaState(state));
          emitPlayerEvent('pause');
        },
        error: (event) => {
          if (event && !event.isTrusted && !(event as any)?.detail) return;
          const detail = (event as CustomEvent<PlayerErrorPayload> | undefined)?.detail;
          const errorTrackSeq = Number(detail?.trackSeq);
          const isOutputError = Boolean(detail?.errorCode?.startsWith('output-'));
          if (
            (!isOutputError &&
              state.awaitingTrackLoad &&
              (!Number.isFinite(errorTrackSeq) ||
                errorTrackSeq <= 0 ||
                errorTrackSeq === state.supersededNativeTrackSeq)) ||
            (!isOutputError && !isCurrentNativePlaybackContext(detail))
          ) {
            return;
          }
          const requestSeq = state.playbackRequestSeq;
          const trackId = String(state.currentTrackId ?? '');
          const isCurrentRequest = () =>
            requestSeq === state.playbackRequestSeq &&
            String(state.currentTrackId ?? '') === trackId;
          void (async () => {
            const wasPlayingBeforeOutputError = getPlaybackIsPlaying(state);
            if (detail?.message) {
              const handledOutputError = await deviceManager.handleOutputDeviceError(detail);
              if (!isCurrentRequest()) return;
              if (handledOutputError) {
                engine.updateMediaPlaybackState(buildMediaState(state));
                if (wasPlayingBeforeOutputError && !getPlaybackIsPlaying(state)) {
                  emitPlayerEvent('pause');
                }
                return;
              }
            }

            const triedFallback = await playbackManager.tryNextAudioCandidate({
              reason: 'player-error',
              position: state.currentTime,
            });
            if (triedFallback) return;
            if (!isCurrentRequest()) return;

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
          if (state.awaitingTrackLoad) return;
          void playbackManager.recoverFromStall(position);
        },
        coreStateChange: (payload) => {
          state.playbackDiagnostics.core = {
            ...payload,
            updatedAt: Date.now(),
          };
        },
        aoStateChange: (payload) => {
          state.playbackDiagnostics.ao = {
            ...payload,
            updatedAt: Date.now(),
          };
        },
        packetCacheStats: (payload) => {
          state.playbackDiagnostics.packetCache = payload
            ? {
                ...payload,
                updatedAt: Date.now(),
              }
            : null;
        },
        audioOutputStats: (payload) => {
          state.playbackDiagnostics.output = payload
            ? {
                ...payload,
                updatedAt: Date.now(),
              }
            : null;
        },
        audioGraphChange: (payload) => {
          state.playbackDiagnostics.graph = payload
            ? {
                ...payload,
                updatedAt: Date.now(),
              }
            : null;
        },
        seeked: (currentTime) => {
          state.seekTargetTime = null;
          if (state.awaitingTrackLoad) return;
          state.currentTime = currentTime;
          state.currentTimeUpdatedAt = Date.now();
          listeningTimeManager.resetPosition();
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
      getSpatialAudioEffectSupport,
      selectSpatialAudioEffect,
      // State-like (actually actions but Pinia treats them as actions)
      getEffectiveAudioQuality: resolver.getEffectiveAudioQuality,
      getResolvedAudioQuality: resolver.getResolvedAudioQuality,
      ensureTrackRelateGoods: resolver.ensureTrackRelateGoods,
      resolveAudioUrl: resolver.resolveAudioUrl,
      fetchClimaxMarks: resolver.fetchClimaxMarks,

      resetHistoryUploadState: historyManager.resetHistoryUploadState,
      commitListeningHistory: historyManager.commitListeningHistory,
      flushListeningTime: listeningTimeManager.flush,

      setVolume: audioManager.setVolume,
      adjustVolume: audioManager.adjustVolume,
      toggleMute: audioManager.toggleMute,
      setPlaybackRate: audioManager.setPlaybackRate,
      setPlayMode: audioManager.setPlayMode,
      setVolumeNormalization: audioManager.setVolumeNormalization,
      setReferenceLufs: audioManager.setReferenceLufs,
      setEq: audioManager.setEq,
      setAudioEffect: audioManager.setAudioEffect,
      fadeVolume: audioManager.fadeVolume,
      setCurrentAudioQualityOverride: audioManager.setCurrentAudioQualityOverride,
      preferCurrentTrackCatalogQuality: audioManager.preferCurrentTrackCatalogQuality,
      preferCurrentTrackCloudSource: audioManager.preferCurrentTrackCloudSource,

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
