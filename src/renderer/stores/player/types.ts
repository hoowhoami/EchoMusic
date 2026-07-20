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

export type PlaybackSource = {
  url: string;
  audioTrackId?: number | null;
};

export type ResolvedAudioSource = {
  url: string;
  urls?: string[];
  audioTrackId?: number | null;
  source?: PlaybackSource;
  sources?: PlaybackSource[];
  quality: AudioQualityValue | null;
  effect: AudioEffectValue;
  loudness: TrackLoudness | null;
};
