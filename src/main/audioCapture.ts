import { app } from 'electron';
import path from 'path';
import log from './logger';

export interface NativeAudioCaptureStatus {
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

export interface NativeAudioCaptureStartOptions {
  source: 'system' | 'input';
  deviceId?: string;
  maxBufferDurationMs?: number;
}

export interface NativeAudioCaptureDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

export interface NativeAudioCaptureReadOptions {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  sampleFormat?: 'f32le' | 's16le';
}

export interface NativeCapturedAudio {
  data: Buffer;
  sampleRate: number;
  channels: number;
  sampleFormat: 'f32le' | 's16le';
  frames: number;
  durationMs: number;
  sourceSampleRate: number;
  sourceChannels: number;
}

export interface NativeAudioCapture {
  listInputDevices(): NativeAudioCaptureDevice[];
  startCapture(options: NativeAudioCaptureStartOptions): NativeAudioCaptureStatus;
  snapshotCapture(options?: NativeAudioCaptureReadOptions): NativeCapturedAudio;
  stopCapture(options?: NativeAudioCaptureReadOptions): NativeCapturedAudio;
  cancelCapture(): void;
  getCaptureStatus(): NativeAudioCaptureStatus;
}

let nativeModule: NativeAudioCapture | null | undefined;

export function loadAudioCapture(): NativeAudioCapture | null {
  if (nativeModule !== undefined) return nativeModule;

  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', 'echo-audio-capture.node')]
    : [
        path.join(__dirname, '../../native/echo-audio-capture/echo-audio-capture.node'),
        path.join(process.cwd(), 'native/echo-audio-capture/echo-audio-capture.node'),
      ];

  for (const candidate of candidates) {
    try {
      log.info('[AudioCapture] Loading native addon:', candidate);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nativeModule = require(candidate) as NativeAudioCapture;
      return nativeModule;
    } catch (error) {
      log.debug('[AudioCapture] Native addon candidate failed:', candidate, error);
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('../../native/echo-audio-capture') as NativeAudioCapture;
    return nativeModule;
  } catch (error) {
    log.warn('[AudioCapture] Native addon unavailable:', error);
    nativeModule = null;
    return null;
  }
}

export function requireAudioCapture(): NativeAudioCapture {
  const capture = loadAudioCapture();
  if (!capture) throw new Error('原生音频采集组件不可用，请重新安装或更新 EchoMusic');
  return capture;
}

export function destroyAudioCapture(): void {
  if (!nativeModule) return;
  try {
    nativeModule.cancelCapture();
  } catch (error) {
    log.warn('[AudioCapture] Failed to stop native capture during shutdown:', error);
  }
}
