import { systemPreferences } from 'electron';
import { requireAudioCapture } from '../audioCapture';
import type { RecognizeCaptureRequest } from '../../shared/recognize';
import { ipcRegistry } from './registry';

const RECOGNITION_CAPTURE_DURATION_MS = 10_000;

export const registerRecognizeHandlers = () => {
  ipcRegistry.registerHandler('recognize:list-input-devices', () =>
    requireAudioCapture().listInputDevices(),
  );
  ipcRegistry.registerHandler(
    'recognize:start-audio-capture',
    async (_event, request: RecognizeCaptureRequest) => {
      if (request?.source !== 'mic' && request?.source !== 'system') {
        throw new Error('不支持的音频采集来源');
      }

      if (request.source === 'mic' && process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) throw new Error('麦克风权限未授权');
      }

      const deviceId =
        request.source === 'mic' && typeof request.deviceId === 'string'
          ? request.deviceId.trim()
          : undefined;
      return requireAudioCapture().startCapture({
        source: request.source === 'mic' ? 'input' : 'system',
        ...(deviceId && deviceId !== 'default' ? { deviceId } : {}),
        maxBufferDurationMs: 15_000,
      });
    },
  );
  ipcRegistry.registerHandler(
    'recognize:stop-audio-capture',
    () =>
      requireAudioCapture().stopCapture({
        durationMs: RECOGNITION_CAPTURE_DURATION_MS,
        sampleRate: 8_000,
        channels: 1,
        sampleFormat: 's16le',
      }).data,
  );
  ipcRegistry.registerHandler('recognize:cancel-audio-capture', () =>
    requireAudioCapture().cancelCapture(),
  );
};
