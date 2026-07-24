import type { AudioEffectValue, AudioQualityValue } from '../../types';
import type {
  PlayerAudioOutputStats,
  PlayerAudioGraphSnapshot,
  PlayerCacheStatePayload,
  PlayerCoreStatePayload,
  PlayerPacketCacheStats,
  TrackLoudness,
} from '@/utils/player';

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

export type PlaybackIntentPhase = 'idle' | 'loading' | 'ready' | 'failed';

export type PlaybackIntent = {
  seq: number;
  trackId: string | null;
  sourceQueueId: string | null;
  shouldPlay: boolean;
  phase: PlaybackIntentPhase;
  startedAt: number;
};

export type EnginePlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export type EnginePlaybackState = {
  status: EnginePlaybackStatus;
  trackId: string | null;
  updatedAt: number;
};

export type PlaybackDiagnostics = {
  core: (PlayerCoreStatePayload & { updatedAt: number }) | null;
  cache: (PlayerCacheStatePayload & { updatedAt: number }) | null;
  packetCache: (PlayerPacketCacheStats & { updatedAt: number }) | null;
  output: (PlayerAudioOutputStats & { updatedAt: number }) | null;
  graph: (PlayerAudioGraphSnapshot & { updatedAt: number }) | null;
};

export type PlaybackDisplayState = 'loading' | 'playing' | 'paused' | 'error';

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
