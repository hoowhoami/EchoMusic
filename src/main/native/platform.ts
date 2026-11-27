import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import log from '../logger';
import type { NativeTaskbarLayout } from '../../shared/taskbar';

export interface NativePlatform {
  getWindowCompositionDiagnostics?(handle: string): {
    acrylicDragHandlerInstalled?: boolean;
    acrylicSuspended?: boolean;
    acrylicLastOperationSucceeded?: boolean;
    acrylicKeepOnBlur?: boolean;
    legacyFrameRepairInstalled?: boolean;
    legacyFrameRepairLastSucceeded?: boolean;
    layered: boolean;
    noRedirectionBitmap: boolean;
    remoteSession: boolean;
    compositionEnabled?: boolean;
    accentState?: number;
    systemBackdrop?: number;
  } | null;
  setWindowComposition(handle: string, mode: number, keepOnBlur?: boolean, tint?: number): boolean;
  /** 失焦保持毛玻璃：WCA_FORCE_ACTIVEWINDOW_APPEARANCE(15)，旧版原生模块可能缺失。 */
  setWindowForceActiveAppearance?(handle: string, enabled: boolean): boolean;
  taskbarThumbnailEnable(handle: string, image: Buffer, width: number, height: number): void;
  taskbarThumbnailDisable(): void;
  taskbarThumbnailSetCover(image: Buffer, width: number, height: number): void;
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

export interface NativeWindowsDoubleClick {
  startWindowsDoubleClickMonitor(
    handle: Buffer,
    callback: (error: Error | null, point: { x: number; y: number }) => void,
  ): void;
  stopWindowsDoubleClickMonitor(): void;
  getWindowsDoubleClickDiagnostics?(): {
    installed: boolean;
    totalDblclick: number;
    foregroundDblclick: number;
  };
}

let windowsDoubleClick: NativeWindowsDoubleClick | null | undefined;
export function getWindowsDoubleClickMonitor(): NativeWindowsDoubleClick | null {
  if (windowsDoubleClick !== undefined) return windowsDoubleClick;
  windowsDoubleClick = null;
  if (process.platform !== 'win32') return null;
  try {
    const candidate = loadAddon();
    if (
      typeof candidate.startWindowsDoubleClickMonitor !== 'function' ||
      typeof candidate.stopWindowsDoubleClickMonitor !== 'function'
    ) {
      throw new Error('Rebuild echo-platform-adaptor for double-click monitor support');
    }
    windowsDoubleClick = candidate as NativeWindowsDoubleClick;
  } catch (error) {
    log.warn('[NativePlatform] Windows double-click monitor unavailable:', error);
  }
  return windowsDoubleClick;
}

export function getNativePlatform(): NativePlatform | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== 'win32') return native;
  try {
    const candidate = loadAddon();
    const methods: (keyof NativePlatform)[] = [
      'setWindowComposition',
      'taskbarThumbnailEnable',
      'taskbarThumbnailDisable',
      'taskbarThumbnailSetCover',
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

export interface NativeTaskbarLyricSession {
  update(width: number): void;
  stop(): void;
}
interface NativeTaskbarLyric {
  TaskbarLyricSession: new (
    handle: string,
    width: number,
    callback: (layout: NativeTaskbarLayout) => void,
  ) => NativeTaskbarLyricSession;
  /** 当前会话挂载到的任务栏句柄（0 = 未挂载 / 任务栏当前不存在）。 */
  taskbarLyricMountedTaskbar?: () => number;
}
let taskbarLyric: NativeTaskbarLyric | null | undefined;
export function getNativeTaskbarLyric(): NativeTaskbarLyric | null {
  if (taskbarLyric !== undefined) return taskbarLyric;
  taskbarLyric = null;
  if (process.platform !== 'win32') return null;
  try {
    const candidate = loadAddon();
    if (typeof candidate.TaskbarLyricSession !== 'function')
      throw new Error('Rebuild echo-platform-adaptor for taskbar lyrics');
    taskbarLyric = candidate;
  } catch (error) {
    log.warn('[NativePlatform] Taskbar lyric unavailable:', error);
  }
  return taskbarLyric ?? null;
}

export interface NativeWallpaperOcclusion {
  /** 屏幕上所有窗口（矩形并集）覆盖这块屏的比例。 */
  coverage: number;
  /** 同一批窗口盖住「歌词区域」的比例。 */
  lyricCoverage: number;
  fullscreen: boolean;
  /** 窗口句柄是否还有效；桌面层重建后子窗口会被销毁。 */
  alive: boolean;
}

export interface NativeWallpaperMonitor {
  /** 上报歌词区域（屏幕物理像素）；宽或高传 0 表示当前没有歌词区域。 */
  setLyricRect(x: number, y: number, width: number, height: number): void;
  setInterval(intervalMs: number): void;
  stop(): void;
}

export interface NativeWallpaper {
  /** 挂到桌面层（WorkerW）。返回值没有意义：失败会直接抛错。 */
  wallpaperAttach(handle: string): void;
  wallpaperResize(handle: string, x: number, y: number, width: number, height: number): void;
  wallpaperDetach(handle: string): void;
  WallpaperMonitor: new (
    handle: string,
    intervalMs: number,
    callback: (state: NativeWallpaperOcclusion) => void,
  ) => NativeWallpaperMonitor;
  /** 当前是否有独占全屏程序（D3D 全屏 / 演示模式）；不需要任何窗口句柄。 */
  isExclusiveFullscreen?: () => boolean;
}

let wallpaper: NativeWallpaper | null | undefined;
export function getNativeWallpaper(): NativeWallpaper | null {
  if (wallpaper !== undefined) return wallpaper;
  wallpaper = null;
  if (process.platform !== 'win32') return null;
  try {
    const candidate = loadAddon();
    if (
      typeof candidate.wallpaperAttach !== 'function' ||
      typeof candidate.WallpaperMonitor !== 'function'
    )
      throw new Error('Rebuild echo-platform-adaptor for the desktop wallpaper');
    wallpaper = candidate as unknown as NativeWallpaper;
  } catch (error) {
    log.warn('[NativePlatform] Wallpaper unavailable:', error);
  }
  return wallpaper ?? null;
}

/** 独占全屏：只查系统通知状态，壁纸窗口不在时也能问。 */
export function isExclusiveFullscreenActive(): boolean {
  const native = getNativeWallpaper();
  if (!native?.isExclusiveFullscreen) return false;
  try {
    return native.isExclusiveFullscreen() === true;
  } catch (error) {
    log.warn('[NativePlatform] 读取全屏状态失败:', error);
    return false;
  }
}
