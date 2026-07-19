import type { PlayerState } from './state';
import type { PlayerEngine } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '../../types';
import { clampNumber, normalizeEffect, normalizeQuality } from './utils';
import { DEFAULT_PLAYER_VOLUME } from '../../../shared/playback';
import { DEFAULT_IMPULSE_RESPONSE_MIX } from '../../../shared/audio';

export const createAudioManager = (
  state: PlayerState,
  engine: PlayerEngine,
  refreshCurrentTrack: () => Promise<void>,
) => {
  const normalizeVolume = (value: number, fallback = DEFAULT_PLAYER_VOLUME) => {
    const candidate = Number.isFinite(value) ? value : fallback;
    return clampNumber(Number.isFinite(candidate) ? candidate : DEFAULT_PLAYER_VOLUME, 0, 1);
  };

  const rememberVolume = (value = state.volume) => {
    if (value > 0) state.lastNonZeroVolume = normalizeVolume(value);
  };

  const getRestoreVolume = () =>
    state.lastNonZeroVolume > 0 ? normalizeVolume(state.lastNonZeroVolume) : DEFAULT_PLAYER_VOLUME;

  const setVolume = (value: number) => {
    state.volume = engine.setVolume(normalizeVolume(value, state.volume));
    rememberVolume();
  };

  const adjustVolume = (delta: number) => {
    const base = state.volume > 0 ? state.volume : getRestoreVolume();
    setVolume(base + delta);
  };

  const toggleMute = () => {
    if (state.volume > 0) {
      rememberVolume();
      setVolume(0);
    } else {
      setVolume(getRestoreVolume());
    }
  };

  const setPlaybackRate = (rate: number) => {
    state.playbackRate = engine.setPlaybackRate(rate);
  };

  const setPlayMode = (mode: PlayMode) => {
    state.playMode = mode;
    state.shuffleQueue = null;
    state.shuffleQueueLength = 0;
    state.shufflePlayed = new Set();
    state.shuffleHistory = [];
    engine.setLoopFile(mode === 'single');
  };

  const setVolumeNormalization = (enabled: boolean) => {
    engine.setVolumeNormalization(enabled);
  };

  const setReferenceLufs = (lufs: number) => {
    engine.setReferenceLufs(lufs);
  };

  const setEq = (gains: number[]) => {
    const clampedGains = gains.map((g) => clampNumber(g, -12, 12));
    state.equalizerGains = clampedGains;
    engine.setEqualizer(clampedGains);
  };

  const setImpulseResponse = (filePath: string | null, mix = DEFAULT_IMPULSE_RESPONSE_MIX) => {
    engine.setImpulseResponse(filePath, mix);
  };

  const setImpulseResponseMix = (mix: number) => {
    engine.setImpulseResponseMix(mix);
  };

  const setAudioEffect = (effect: AudioEffectValue) => {
    const nextEffect = normalizeEffect(effect);
    if (state.audioEffect === nextEffect) return;
    state.audioEffect = nextEffect;
    if (!state.currentTrackId) return;
    if (state.isLoading || state.pendingSettingRefresh) {
      state.pendingSettingRefresh = true;
      return;
    }
    void refreshCurrentTrack();
  };

  const fadeVolume = (
    target: number,
    options?: { durationMs?: number; respectUserVolume?: boolean },
  ): Promise<void> => {
    const durationMs = Math.max(0, options?.durationMs ?? 1000);
    const respectUserVolume = options?.respectUserVolume ?? false;
    const targetValue = respectUserVolume ? Math.min(target, state.volume) : target;
    return engine.fadeTo(targetValue, durationMs).then(() => {
      if (!respectUserVolume) {
        state.volume = engine.volume;
        rememberVolume();
      }
    });
  };

  const setCurrentAudioQualityOverride = (
    quality: AudioQualityValue | null,
    options?: { refresh?: boolean },
  ) => {
    const nextQuality = quality ? normalizeQuality(quality) : null;
    if (state.currentAudioQualityOverride === nextQuality) return;
    state.currentAudioQualityOverride = nextQuality;
    if (options?.refresh === false) return;
    if (!state.currentTrackId) return;
    if (state.isLoading || state.pendingSettingRefresh) {
      state.pendingSettingRefresh = true;
      return;
    }
    void refreshCurrentTrack();
  };

  return {
    setVolume,
    adjustVolume,
    toggleMute,
    setPlaybackRate,
    setPlayMode,
    setVolumeNormalization,
    setReferenceLufs,
    setEq,
    setImpulseResponse,
    setImpulseResponseMix,
    setAudioEffect,
    fadeVolume,
    setCurrentAudioQualityOverride,
  };
};
