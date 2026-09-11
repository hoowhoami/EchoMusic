import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import log from '../logger';

export interface NativePlatform {
  getWindowCompositionDiagnostics?(handle: string): {
    acrylicDragHandlerInstalled?: boolean;
    acrylicSuspended?: boolean;
    acrylicLastOperationSucceeded?: boolean;
    legacyFrameRepairInstalled?: boolean;
    legacyFrameRepairLastSucceeded?: boolean;
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
const loadAddon = () =>
  createRequire(join(process.cwd(), 'package.json'))(
    app.isPackaged
      ? join(process.resourcesPath, 'native/echo-platform-adaptor.node')
      : join(__dirname, '../../native/echo-platform-adaptor/echo-platform-adaptor.node'),
  );

export interface NativeWindowPointer {
  startWindowPointerMonitor(
    handle: Buffer,
    callback: (error: Error | null, point: { x: number; y: number }) => void,
  ): void;
  stopWindowPointerMonitor(): void;
}

let windowPointer: NativeWindowPointer | null | undefined;
export function getNativeWindowPointer(): NativeWindowPointer | null {
  if (windowPointer !== undefined) return windowPointer;
  windowPointer = null;
  if (process.platform !== 'darwin') return null;
  try {
    const candidate = loadAddon();
    if (
      typeof candidate.startWindowPointerMonitor !== 'function' ||
      typeof candidate.stopWindowPointerMonitor !== 'function'
    ) {
      throw new Error('Rebuild echo-platform-adaptor for window pointer support');
    }
    windowPointer = candidate as NativeWindowPointer;
  } catch (error) {
    log.warn('[NativePlatform] Window pointer monitor unavailable:', error);
  }
  return windowPointer;
}

export function getNativePlatform(): NativePlatform | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== 'win32') return native;
  try {
    const candidate = loadAddon();
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
