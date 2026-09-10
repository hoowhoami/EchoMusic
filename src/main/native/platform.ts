import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import log from '../logger';

export interface NativePlatform {
  getWindowCompositionDiagnostics?(handle: string): {
    layered: boolean;
    noRedirectionBitmap: boolean;
    remoteSession: boolean;
    compositionEnabled?: boolean;
    accentState?: number;
    systemBackdrop?: number;
  } | null;
  setWindowComposition(handle: string, mode: number): boolean;
  taskbarEnableIconic(handle: string): void;
  taskbarDisableIconic(handle: string): void;
  taskbarInvalidate(handle: string): void;
  taskbarSetThumbnail(handle: string, image: Buffer, maxWidth: number, maxHeight: number): void;
  taskbarSetLivePreview(handle: string, image: Buffer, maxWidth: number, maxHeight: number): void;
}

let native: NativePlatform | null | undefined;
export function getNativePlatform(): NativePlatform | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== 'win32') return native;
  try {
    const candidate = createRequire(join(process.cwd(), 'package.json'))(
      app.isPackaged
        ? join(process.resourcesPath, 'native/echo-platform-adaptor.node')
        : join(__dirname, '../../native/echo-platform-adaptor/echo-platform-adaptor.node'),
    );
    const methods: (keyof NativePlatform)[] = [
      'setWindowComposition',
      'taskbarEnableIconic',
      'taskbarDisableIconic',
      'taskbarInvalidate',
      'taskbarSetThumbnail',
      'taskbarSetLivePreview',
    ];
    if (!methods.every((method) => typeof candidate[method] === 'function')) {
      throw new Error('echo-platform-adaptor native API mismatch');
    }
    native = candidate as NativePlatform;
  } catch (error) {
    log.warn('[NativePlatform] Native addon unavailable; using system window fallback:', error);
  }
  return native ?? null;
}
