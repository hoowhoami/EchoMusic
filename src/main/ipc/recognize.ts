import {
  systemPreferences,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
} from 'electron';
import { requireAudioCapture } from '../audioCapture';
import log from '../logger';
import type { RecognizeCaptureRequest, RecognizeCaptureStatus } from '../../shared/recognize';
import { ipcRegistry } from './registry';

const RECOGNITION_CAPTURE_DURATION_MS = 10_000;

export const registerRecognizeHandlers = () => {
  // 原生采集全局只保留一轮，等待系统授权也必须属于这一轮。
  let current: { sender: WebContents; active: boolean; detach: () => void } | null = null;
  const canceledStatus = (): RecognizeCaptureStatus => ({
    running: false,
    sampleRate: 0,
    channels: 0,
    capturedFrames: 0,
    durationMs: 0,
    error: 'audio capture canceled',
  });
  const release = () => {
    const capture = current;
    current = null;
    capture?.detach();
    if (capture?.active) requireAudioCapture().cancelCapture();
  };

  ipcRegistry.registerHandler('recognize:list-input-devices', () =>
    requireAudioCapture().listInputDevices(),
  );
  ipcRegistry.registerHandler(
    'recognize:start-audio-capture',
    async (event, request: RecognizeCaptureRequest) => {
      if (request?.source !== 'mic' && request?.source !== 'system') {
        throw new Error('不支持的音频采集来源');
      }

      if (event.sender.isDestroyed()) return canceledStatus();
      release();
      const sender = event.sender;
      const capture = { sender, active: false, detach: () => {} };
      current = capture;
      const invalidate = () => {
        if (current !== capture) return;
        try {
          release();
        } catch (error) {
          log.warn('[Recognize] Failed to cancel capture after renderer cleanup:', error);
        }
      };
      const onNavigation = ({
        isSameDocument,
        isMainFrame,
      }: WebContentsDidStartNavigationEventParams) => {
        if (isMainFrame && !isSameDocument) invalidate();
      };
      sender.once('destroyed', invalidate);
      sender.once('render-process-gone', invalidate);
      sender.on('did-start-navigation', onNavigation);
      capture.detach = () => {
        sender.removeListener('destroyed', invalidate);
        sender.removeListener('render-process-gone', invalidate);
        sender.removeListener('did-start-navigation', onNavigation);
      };
      const deviceId =
        request.source === 'mic' && typeof request.deviceId === 'string'
          ? request.deviceId.trim()
          : undefined;
      try {
        if (request.source === 'mic' && process.platform === 'darwin') {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          if (current !== capture || sender.isDestroyed()) return canceledStatus();
          if (!granted) throw new Error('麦克风权限未授权');
        }
        const status = requireAudioCapture().startCapture({
          source: request.source === 'mic' ? 'input' : 'system',
          ...(deviceId && deviceId !== 'default' ? { deviceId } : {}),
          maxBufferDurationMs: 15_000,
        });
        capture.active = true;
        if (!status.running) release();
        return status;
      } catch (error) {
        if (current !== capture) return canceledStatus();
        release();
        throw error;
      }
    },
  );
  ipcRegistry.registerHandler('recognize:stop-audio-capture', (event) => {
    if (current?.sender !== event.sender) {
      throw new Error('audio capture is not running');
    }
    if (!current.active) {
      release();
      throw new Error('audio capture is not running');
    }
    current.active = false;
    release();
    return requireAudioCapture().stopCapture({
      durationMs: RECOGNITION_CAPTURE_DURATION_MS,
      sampleRate: 8_000,
      channels: 1,
      sampleFormat: 's16le',
    }).data;
  });
  ipcRegistry.registerHandler('recognize:cancel-audio-capture', (event) => {
    if (current?.sender === event.sender) release();
  });
};
