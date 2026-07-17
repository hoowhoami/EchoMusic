export type AudioSpectrumSource = 'player' | 'silence' | 'unavailable';
export type AudioSpectrumPlaybackState = 'playing' | 'paused' | 'idle';
export type AudioSpectrumScale = 'linear' | 'log' | 'mel';
export type AudioSpectrumProvider = 'player' | 'unavailable';

export interface AudioSpectrumOptions {
  fps?: number;
  binCount?: number;
  fftSize?: number;
  smoothing?: number;
  minFrequency?: number;
  maxFrequency?: number;
  scale?: AudioSpectrumScale;
  includeWaveform?: boolean;
}

export interface AudioSpectrumFrame {
  source: AudioSpectrumSource;
  state: AudioSpectrumPlaybackState;
  timestamp: number;
  timePos: number | null;
  sampleRate: number;
  fftSize: number;
  minFrequency: number;
  maxFrequency: number;
  /**
   * Frequency magnitudes normalized to 0..1 from the player engine.
   */
  bins: number[];
  waveform?: number[];
  rms: number;
  peak: number;
}

export interface AudioSpectrumStatus {
  available: boolean;
  running: boolean;
  provider: AudioSpectrumProvider;
  reason?: string;
  subscriberCount?: number;
}

export interface AudioSpectrumSubscribePayload {
  subscriptionId: string;
  pluginId?: string;
  options?: AudioSpectrumOptions;
}

export interface AudioSpectrumUnsubscribePayload {
  subscriptionId: string;
}

export type AudioSpectrumSubscribeResult =
  | {
      ok: true;
      status: AudioSpectrumStatus;
    }
  | {
      ok: false;
      error: string;
      status?: AudioSpectrumStatus;
    };
