import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getNativePlatform, type NativePlatform } from './native/platform';
import { getMainAppSettings } from './storage/settings';
import log from './logger';

const COVER_SIZE = 512;
let native: NativePlatform | null = null;
let target: BrowserWindow | null = null;
let enabled = false;
let attached = false;
let cover: NativeImage | null = null;
let sourceKey = '';
let defaultCover: NativeImage | null = null;

function fallback(): NativeImage {
  if (!defaultCover) {
    defaultCover = scaled(
      nativeImage.createFromPath(
        app.isPackaged
          ? join(process.resourcesPath, 'icons/icon.png')
          : join(__dirname, '../../build/icons/icon.png'),
      ),
    );
  }
  return defaultCover;
}
function scaled(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  return width >= height
    ? image.resize({ width: COVER_SIZE })
    : image.resize({ height: COVER_SIZE });
}
function apply(): void {
  if (!native || !target || target.isDestroyed()) return;
  try {
    if (!enabled) {
      if (attached) native.taskbarThumbnailDisable();
      attached = false;
      return;
    }
    const image = cover || fallback();
    if (image.isEmpty()) throw new Error('Taskbar fallback cover is unavailable');
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    if (!attached) {
      const handle = target.getNativeWindowHandle();
      const hwnd =
        handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      native.taskbarThumbnailEnable(hwnd, pixels, width, height);
      attached = true;
    } else native.taskbarThumbnailSetCover(pixels, width, height);
  } catch (error) {
    // 失败时回到系统实时预览，不能留下没有位图的 FORCE_ICONIC 窗口。
    native.taskbarThumbnailDisable();
    attached = false;
    log.warn('[TaskbarThumbnail] Unable to apply album preview:', error);
  }
}
export function setupTaskbarThumbnail(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  if (target === win) {
    apply();
    return;
  }
  detach();
  native = getNativePlatform();
  if (!native) return;
  target = win;
  target.once('closed', onClosed);
  enabled = Boolean(getMainAppSettings().taskbarCoverPreview);
  apply();
}
function onClosed(): void {
  detach();
}
function detach(): void {
  target?.removeListener('closed', onClosed);
  if (attached) native?.taskbarThumbnailDisable();
  attached = false;
  target = null;
}
export function setTaskbarCover(value: Buffer | null): void {
  if (process.platform !== 'win32') return;
  const next = value?.length ? value : null;
  const key = next ? createHash('sha256').update(next).digest('hex') : '';
  if (sourceKey === key) return;
  sourceKey = key;
  cover = null;
  if (next) {
    const image = nativeImage.createFromBuffer(next);
    if (!image.isEmpty()) cover = scaled(image);
  }
  apply();
}
export function isCoverPreviewEnabled(): boolean {
  return enabled;
}
export function setCoverPreviewEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  apply();
}
export function destroyTaskbarThumbnail(): void {
  detach();
  cover = null;
  sourceKey = '';
  defaultCover = null;
}
