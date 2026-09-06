/** 听歌识曲相关类型定义 */

/** 识别状态 */
export type RecognizeStatus = 'idle' | 'recording' | 'recognizing' | 'success' | 'failed';

export type RecognizeAudioSource = 'mic' | 'system';

export interface RecognizeInputDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

export interface RecognizeCaptureRequest {
  source: RecognizeAudioSource;
  deviceId?: string;
}

export interface RecognizeCaptureStatus {
  running: boolean;
  source?: 'system' | 'input';
  deviceId?: string;
  deviceName?: string;
  sampleRate: number;
  channels: number;
  capturedFrames: number;
  durationMs: number;
  error?: string;
}
