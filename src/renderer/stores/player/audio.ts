import type { PlayerState } from './state';
import type { PlayerEngine } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '../../types';
import { clampNumber, normalizeEffect, normalizeQuality } from './utils';

export const createAudioManager = (
  state: PlayerState,
  engine: PlayerEngine,
  refreshCurrentTrack: () => Promise<void>,
) => {
  const setVolume = (value: number) => {
    state.volume = engine.setVolume(value);
  };

  const setPlaybackRate = (rate: number) => {
    state.playbackRate = engine.setPlaybackRate(rate);
  };

  const setPlayMode = (mode: PlayMode) => {
    state.playMode = mode;
    state.shuffleQueue = null;
    state.shuffleQueueLength = 0;
    state.shufflePlayed = new Set();
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
    setPlaybackRate,
    setPlayMode,
    setVolumeNormalization,
    setReferenceLufs,
    setEq,
    setAudioEffect,
    fadeVolume,
    setCurrentAudioQualityOverride,
  };
};
