import type { AudioEffectValue, AudioQualityValue } from '../../types';
import type { TrackLoudness } from '@/utils/player';

export type ClimaxMark = { start: number; end: number };

export type PlaybackNotice = {
  code: string;
  title: string;
  reason: string;
  detail: string;
  trackId: string | null;
};

export type ResolvedAudioSource = {
  url: string;
  quality: AudioQualityValue | null;
  effect: AudioEffectValue;
  loudness: TrackLoudness | null;
};
