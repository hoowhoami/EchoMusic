import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'path';
import log from './logger';
import { getMainAppSettings } from './storage/settings';

/**
 * Windows 任务栏 iconic 缩略图。
 *
 * 有封面时把任务栏悬停预览替换为歌曲封面，无封面时回退为窗口实时画面。
 * 通过 DWM iconic representation 实现：开启后系统会发来缩略图请求消息，
 * 这里用 `hookWindowMessage` 接收并调用原生模块写入封面位图。
 */

// DWM 缩略图请求消息
const WM_DWMSENDICONICTHUMBNAIL = 0x0323;
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326;

// 缩略图请求未携带尺寸时的回退上限
const DEFAULT_THUMBNAIL_MAX = 200;
// Aero Peek 大预览的尺寸上限
const LIVE_PREVIEW_MAX = 600;

interface NativeTaskbar {
  taskbarEnableIconic(hwnd: string): void;
  taskbarDisableIconic(hwnd: string): void;
  taskbarInvalidate(hwnd: string): void;
  taskbarSetThumbnail(hwnd: string, image: Buffer, maxWidth: number, maxHeight: number): void;
  taskbarSetLivePreview(hwnd: string, image: Buffer, maxWidth: number, maxHeight: number): void;
}

let nativeModule: NativeTaskbar | null = null;
let targetWindow: BrowserWindow | null = null;
let hwndStr: string | null = null;
let coverBuffer: Buffer | null = null;
let fallbackCoverBuffer: Buffer | null = null;
let fallbackCoverLoading = false;
let iconicEnabled = false;
let hooked = false;
// 已应用的封面引用，用于避免对相同封面重复 invalidate
let appliedCoverRef: Buffer | null = null;
// 任务栏封面预览开关：关闭时走 DWM 默认实时窗口画面，不启用 iconic 封面
let coverPreviewEnabled = false;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

// 应用兜底封面：FORCE_ICONIC 开启后 DWM 只使用我们提供的位图，
// 若封面缺失/下载中而不给位图，DWM 会渲染出黑窗。因此始终兜底一张封面。
const FALLBACK_COVER_URL = 'https://imge.kugou.com/soft/collection/default.jpg';

/** 当前可提供给 DWM 的封面位图：真实封面优先，缺失时用兜底封面 */
function currentCover(): Buffer | null {
  if (coverBuffer && coverBuffer.length > 0) return coverBuffer;
  return fallbackCoverBuffer && fallbackCoverBuffer.length > 0 ? fallbackCoverBuffer : null;
}

/** 加载应用兜底封面（有在途/已加载则跳过） */
function loadFallbackCover(): void {
  if (fallbackCoverBuffer || fallbackCoverLoading) return;
  fallbackCoverLoading = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  fetch(FALLBACK_COVER_URL, {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.kugou.com/',
    },
  })
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => {
      const data = buf && buf.byteLength > 0 ? Buffer.from(buf) : null;
      if (data) {
        fallbackCoverBuffer = data;
        // 兜底封面就绪后若真实封面仍缺失，刷新一次缩略图
        if (!coverBuffer) applyState();
      }
    })
    .catch(() => {
      // 加载失败保持 null，下次 setTaskbarCover 缺失封面时会重试
    })
    .finally(() => {
      clearTimeout(timeout);
      fallbackCoverLoading = false;
    });
}

/** 加载 native addon（与 mediaControls 共用同一个 .node，require 缓存保证单例） */
function loadNativeModule(): NativeTaskbar | null {
  try {
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'echo-media-controls.node')
      : path.join(__dirname, '../../native/echo-media-controls/echo-media-controls.node');
    return nativeRequire(resourcePath) as NativeTaskbar;
  } catch (err) {
    log.warn('[TaskbarThumbnail] Primary path load failed:', err);
    try {
      return nativeRequire(path.join(process.cwd(), 'native/echo-media-controls')) as NativeTaskbar;
    } catch (err2) {
      log.error('[TaskbarThumbnail] Native addon load failed:', err, err2);
      return null;
    }
  }
}

/** 从窗口原生句柄 Buffer 解析 HWND 指针的无符号十进制字符串 */
function resolveHwnd(win: BrowserWindow): string | null {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
    return null;
  } catch (err) {
    log.warn('[TaskbarThumbnail] Failed to read native window handle:', err);
    return null;
  }
}

/** 开关由「任务栏封面预览」控制：开则始终显示封面（真实，缺失时用兜底），关则回落到 DWM 实时窗口画面 */
function applyState(): void {
  if (!nativeModule || !hwndStr) return;
  const shouldShowCover = coverPreviewEnabled && !!currentCover();
  try {
    if (shouldShowCover) {
      const needEnable = !iconicEnabled;
      if (needEnable) {
        nativeModule.taskbarEnableIconic(hwndStr);
        iconicEnabled = true;
      }
      // 封面已应用过且 iconic 已开启时无需重复触发系统重新索取
      if (needEnable || appliedCoverRef !== coverBuffer) {
        appliedCoverRef = coverBuffer;
        // 触发系统重新索取缩略图，换上当前封面
        nativeModule.taskbarInvalidate(hwndStr);
      }
    } else {
      appliedCoverRef = null;
      if (iconicEnabled) {
        nativeModule.taskbarDisableIconic(hwndStr);
        iconicEnabled = false;
        nativeModule.taskbarInvalidate(hwndStr);
      }
    }
  } catch (err) {
    log.warn('[TaskbarThumbnail] applyState failed:', err);
  }
}

/** 处理悬停缩略图请求：从 lParam 解析最大尺寸并写入封面 */
function onThumbnailRequest(lParam: Buffer): void {
  if (!nativeModule || !hwndStr) return;
  // 封面暂缺时保留 DWM 已有的缩略图，避免回退到实时窗口捕获而黑屏
  const cover = currentCover();
  if (!cover) return;
  let maxWidth = DEFAULT_THUMBNAIL_MAX;
  let maxHeight = DEFAULT_THUMBNAIL_MAX;
  try {
    // lParam 低 32 位：HIWORD = 最大宽度，LOWORD = 最大高度
    const packed = lParam.length >= 4 ? lParam.readUInt32LE(0) : 0;
    const w = (packed >>> 16) & 0xffff;
    const h = packed & 0xffff;
    if (w > 0) maxWidth = w;
    if (h > 0) maxHeight = h;
  } catch {
    // 解析失败则使用默认尺寸
  }
  try {
    nativeModule.taskbarSetThumbnail(hwndStr, cover, maxWidth, maxHeight);
  } catch (err) {
    // 解码失败（不支持格式等）时保留 DWM 已有的缩略图，避免回退到实时窗口捕获而黑屏
    log.warn('[TaskbarThumbnail] setThumbnail failed, keeping previous thumbnail:', err);
  }
}

/** 处理 Aero Peek 大预览请求：写入封面 */
function onLivePreviewRequest(): void {
  if (!nativeModule || !hwndStr) return;
  // 封面暂缺时保留 DWM 已有内容，避免回退到实时窗口捕获而黑屏
  const cover = currentCover();
  if (!cover) return;
  try {
    nativeModule.taskbarSetLivePreview(hwndStr, cover, LIVE_PREVIEW_MAX, LIVE_PREVIEW_MAX);
  } catch (err) {
    log.warn('[TaskbarThumbnail] setLivePreview failed:', err);
  }
}

/** 初始化任务栏缩略图（仅 Windows）。需在窗口创建后调用。 */
export function setupTaskbarThumbnail(win: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  if (win.isDestroyed()) return;

  if (!nativeModule) {
    nativeModule = loadNativeModule();
  }
  if (!nativeModule) {
    log.warn('[TaskbarThumbnail] Native addon unavailable, taskbar cover preview disabled');
    return;
  }

  targetWindow = win;
  hwndStr = resolveHwnd(win);
  if (!hwndStr) {
    log.warn('[TaskbarThumbnail] Unable to resolve HWND, skip setup');
    return;
  }

  // 预加载兜底封面，保证任何时刻都能向 DWM 提供位图，避免黑窗
  loadFallbackCover();

  // 从已持久化的主进程设置初始化任务栏封面预览开关
  coverPreviewEnabled = Boolean(getMainAppSettings().taskbarCoverPreview);

  if (!hooked) {
    win.hookWindowMessage(WM_DWMSENDICONICTHUMBNAIL, (_wParam, lParam) => {
      onThumbnailRequest(lParam);
    });
    win.hookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP, () => {
      onLivePreviewRequest();
    });
    hooked = true;
  }

  // 句柄可能因窗口重建变化，重新应用一次当前状态
  iconicEnabled = false;
  applyState();
  log.info('[TaskbarThumbnail] Initialized');
}

/** 更新当前封面（原始图片字节）。传 null 表示无可用封面，将回退到应用的兜底封面。 */
export function setTaskbarCover(cover: Buffer | null): void {
  if (process.platform !== 'win32') return;
  // 始终记录最新封面；开关关闭时 iconic 不会开启，重新开启后可立即显示当前封面
  coverBuffer = cover && cover.length > 0 ? cover : null;
  if (!currentCover()) {
    // 没有真实封面可用时确保兜底封面已加载，避免 iconic 无位图而显示黑窗
    loadFallbackCover();
  }
  applyState();
}

/** 任务栏封面预览当前是否开启 */
export function isCoverPreviewEnabled(): boolean {
  return coverPreviewEnabled;
}

/** 设置任务栏封面预览开关（关闭时回退到 DWM 实时窗口画面） */
export function setCoverPreviewEnabled(enabled: boolean): void {
  coverPreviewEnabled = enabled;
  applyState();
}

/** 销毁：关闭 iconic 表示并解除消息钩子。 */
export function destroyTaskbarThumbnail(): void {
  if (process.platform !== 'win32') return;
  try {
    if (nativeModule && hwndStr && iconicEnabled) {
      nativeModule.taskbarDisableIconic(hwndStr);
      nativeModule.taskbarInvalidate(hwndStr);
    }
    if (hooked && targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.unhookWindowMessage(WM_DWMSENDICONICTHUMBNAIL);
      targetWindow.unhookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP);
    }
  } catch (err) {
    log.warn('[TaskbarThumbnail] destroy failed:', err);
  }
  iconicEnabled = false;
  hooked = false;
  appliedCoverRef = null;
  coverBuffer = null;
  fallbackCoverBuffer = null;
  hwndStr = null;
  targetWindow = null;
}
