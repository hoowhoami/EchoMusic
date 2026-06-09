import { app } from 'electron';
import path from 'path';
import type {
  AudioSpectrumFrame,
  AudioSpectrumOptions,
  AudioSpectrumStatus,
} from '../shared/audio-spectrum';
import log from './logger';

export interface NativeSpectrumCapture {
  start(options?: AudioSpectrumOptions): AudioSpectrumStatus;
  stop(): AudioSpectrumStatus;
  getStatus(): AudioSpectrumStatus;
  getSnapshot(): AudioSpectrumFrame | null;
}

let nativeModule: NativeSpectrumCapture | null | undefined;

export function loadSpectrumCapture(): NativeSpectrumCapture | null {
  if (nativeModule !== undefined) return nativeModule;

  try {
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'echo-spectrum-capture.node')
      : path.join(__dirname, '../../native/echo-spectrum-capture/echo-spectrum-capture.node');

    log.info('[SpectrumCapture] Loading native addon:', resourcePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require(resourcePath) as NativeSpectrumCapture;
    return nativeModule;
  } catch (err) {
    log.warn('[SpectrumCapture] Primary path load failed:', err);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nativeModule = require('../../native/echo-spectrum-capture') as NativeSpectrumCapture;
      return nativeModule;
    } catch (err2) {
      log.warn(
        '[SpectrumCapture] Native addon unavailable. Spectrum capture will stay disabled. Primary error:',
        err,
        'Fallback error:',
        err2,
      );
      nativeModule = null;
      return null;
    }
  }
}
