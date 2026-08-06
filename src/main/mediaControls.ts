import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'path';
import log from './logger';
import { setTaskbarCover } from './taskbarThumbnail';

// native addon 类型（与自动生成的 index.d.ts 对齐）
interface NativeMediaControls {
  initialize(appName: string): void;
  shutdown(): void;
  updateMetadata(payload: {
    title: string;
    artist: string;
    album: string;
    coverData?: number[];
    coverUrl?: string;
    durationMs?: number;
  }): Promise<void>;
  updatePlayState(payload: { status: string }): void;
  updateTimeline(payload: { currentTimeMs: number; totalTimeMs: number }): void;
  updateSkipIntervals(payload: { forwardMs: number; backwardMs: number }): void;
  registerEventHandler(
    callback: (
      err: Error | null,
      event: { type: string; positionMs?: number; offsetMs?: number },
    ) => void,
  ): void;
}

let nativeModule: NativeMediaControls | null = null;
// 封面下载中止控制器
let coverAbortController: AbortController | null = null;
let metadataUpdateSeq = 0;
let lastCoverCache: { url: string; data: Buffer | null } | null = null;
let activeCoverDownload: { url: string; promise: Promise<Buffer | null> } | null = null;
let fallbackCoverCache: { url: string; data: Buffer | null } | null = null;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));
const METADATA_COVER_SETTLE_MS = 120;

// 与渲染端 DEFAULT_COVER_URL 保持一致的应用兜底封面。
// 当后台任务窗口确实无法得到可用封面时，用它代替 DWM 回退到实时窗口捕获（黑屏）。
const FALLBACK_COVER_URL = 'https://imge.kugou.com/soft/collection/default.jpg';

/** 加载并缓存应用的兜底封面（只下载一次）。 */
function ensureFallbackCover(): Promise<Buffer | null> {
  if (fallbackCoverCache) return Promise.resolve(fallbackCoverCache.data);
  return resolveCoverImage(FALLBACK_COVER_URL).then((data) => {
    if (!fallbackCoverCache) {
      fallbackCoverCache = { url: FALLBACK_COVER_URL, data };
    }
    return fallbackCoverCache.data;
  });
}

const isAbortError = (error: unknown) =>
  error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError');

const waitForAbortableDelay = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve(true);
    }, ms);

    function handleAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      resolve(false);
    }

    signal.addEventListener('abort', handleAbort, { once: true });
  });

/** 加载 native addon */
function loadNativeModule(): NativeMediaControls | null {
  try {
    // 打包后在 extraResources 中
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'echo-media-controls.node')
      : path.join(__dirname, '../../native/echo-media-controls/echo-media-controls.node');

    log.info('[MediaControls] Loading native addon:', resourcePath);
    return nativeRequire(resourcePath) as NativeMediaControls;
  } catch (err) {
    log.warn('[MediaControls] Primary path load failed:', err);
    // 开发环境可能未编译，尝试直接加载
    try {
      return nativeRequire(
        path.join(process.cwd(), 'native/echo-media-controls'),
      ) as NativeMediaControls;
    } catch (err2) {
      log.error(
        '[MediaControls] All load attempts failed. ' +
          'MPRIS/SMTC will be unavailable. ' +
          'This usually means the native addon was not compiled for this platform/arch. ' +
          'Primary error:',
        err,
        'Fallback error:',
        err2,
      );
      return null;
    }
  }
}

/** 下载图片为 Buffer */
async function downloadCoverImage(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!url) return null;

  try {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = setTimeout(() => controller.abort(), 5000);
    const abortDownload = () => controller.abort();

    if (signal) {
      signal.addEventListener('abort', abortDownload, { once: true });
    }

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'image/jpeg,image/png,image/webp,*/*;q=0.8',
          Referer: 'https://www.kugou.com/',
        },
      });

      if (!response.ok) {
        log.warn('[MediaControls] Cover download failed', { status: response.status, url });
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      return buffer;
    } finally {
      signal?.removeEventListener('abort', abortDownload);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      return null;
    }
    log.warn('[MediaControls] Cover download exception:', err);
    return null;
  }
}

async function resolveCoverImage(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!url) return null;
  if (lastCoverCache?.url === url) return lastCoverCache.data;
  if (activeCoverDownload?.url === url) return activeCoverDownload.promise;

  const promise = downloadCoverImage(url, signal).then((data) => {
    if (activeCoverDownload?.url === url) {
      activeCoverDownload = null;
      lastCoverCache = { url, data };
    }
    return data;
  });
  activeCoverDownload = { url, promise };
  return promise;
}

/** 初始化原生媒体控制服务 */
export function initMediaControls(getMainWindow: () => BrowserWindow | null): void {
  nativeModule = loadNativeModule();

  // 预热兜底封面，保证在真实封面缺失/失败时能立刻回退，避免任务栏黑窗
  void ensureFallbackCover();

  if (!nativeModule) {
    log.warn('[MediaControls] Native addon unavailable, using fallback');
    registerFallbackIpc();
    return;
  }

  try {
    nativeModule.initialize('EchoMusic');
    log.info('[MediaControls] Native addon initialized');
  } catch (err) {
    log.error('[MediaControls] Native addon init failed:', err);
    nativeModule = null;
    registerFallbackIpc();
    return;
  }

  // 注册系统媒体事件回调 → 转发到渲染进程
  nativeModule.registerEventHandler((err, event) => {
    if (err) {
      log.warn('[MediaControls] Event callback error:', err);
      return;
    }
    log.debug('[MediaControls] System media event:', event);
    getMainWindow()?.webContents.send('media-control:event', event);
  });

  // IPC: 更新元数据
  ipcMain.handle(
    'media-control:update-metadata',
    async (
      _e,
      payload: {
        title: string;
        artist: string;
        album: string;
        coverUrl?: string;
        durationMs?: number;
      },
    ) => {
      const controls = nativeModule;
      if (!controls) return;
      const requestSeq = ++metadataUpdateSeq;

      // 取消不同封面的上一次下载；相同 URL 的并发请求复用同一个下载结果。
      if (coverAbortController && activeCoverDownload?.url !== payload.coverUrl) {
        coverAbortController.abort();
        activeCoverDownload = null;
      }
      let coverController: AbortController | null = null;

      let coverData: Buffer | null = null;
      if (payload.coverUrl) {
        if (activeCoverDownload?.url === payload.coverUrl) {
          coverData = await resolveCoverImage(payload.coverUrl);
        } else {
          coverController = new AbortController();
          coverAbortController = coverController;
          const shouldDownloadCover = await waitForAbortableDelay(
            METADATA_COVER_SETTLE_MS,
            coverController.signal,
          );
          if (!shouldDownloadCover || requestSeq !== metadataUpdateSeq) {
            if (coverAbortController === coverController) coverAbortController = null;
            return;
          }
          coverData = await resolveCoverImage(payload.coverUrl, coverController.signal);
        }
      }

      if (coverController && coverAbortController === coverController) {
        coverAbortController = null;
      }

      if (requestSeq !== metadataUpdateSeq) {
        log.debug('[MediaControls] Ignored stale metadata update', {
          title: payload.title,
          url: payload.coverUrl,
        });
        return;
      }

      // 任务栏 DWM 缩略图需要及时响应系统请求，不能被 SMTC 的异步元数据更新挡住。
      // 仅在有可用封面时才更新为真实封面；切歌瞬间若新封面尚未就绪，
      // 保留上一张封面，避免 DWM 回退到实时窗口捕获而显示黑窗。
      if (coverData) {
        setTaskbarCover(coverData);
      } else {
        // 当前歌曲确实拿不到封面时，用应用的兜底封面兜底，同样避免黑窗。
        const fallback = await ensureFallbackCover();
        if (fallback) setTaskbarCover(fallback);
      }

      try {
        // native addon 期望 coverData 为 number[]（NAPI-RS 的 Vec<u8> 映射）
        // 异步：封面解码/重编码在工作线程执行，不阻塞主进程
        await controls.updateMetadata({
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          coverData: coverData ? Array.from(coverData) : undefined,
          coverUrl: payload.coverUrl,
          durationMs: payload.durationMs,
        });
      } catch (err) {
        log.warn('[MediaControls] updateMetadata failed:', err);
      }
    },
  );

  // IPC: 更新播放状态
  ipcMain.handle('media-control:update-state', (_e, payload: { status: string }) => {
    try {
      nativeModule?.updatePlayState(payload);
    } catch (err) {
      log.warn('[MediaControls] updatePlayState failed:', err);
    }
  });

  // IPC: 更新播放进度
  ipcMain.handle(
    'media-control:update-timeline',
    (_e, payload: { currentTimeMs: number; totalTimeMs: number }) => {
      try {
        nativeModule?.updateTimeline(payload);
      } catch (err) {
        log.warn('[MediaControls] updateTimeline failed:', err);
      }
    },
  );

  // IPC: 更新系统媒体控制的快进 / 快退偏好间隔
  ipcMain.handle(
    'media-control:update-skip-intervals',
    (_e, payload: { forwardMs: number; backwardMs: number }) => {
      try {
        nativeModule?.updateSkipIntervals(payload);
      } catch (err) {
        log.warn('[MediaControls] updateSkipIntervals failed:', err);
      }
    },
  );

  // IPC: 查询 native addon 是否可用
  ipcMain.handle('media-control:available', () => {
    return nativeModule !== null;
  });
}

/** native addon 不可用时注册空的 IPC handler，防止渲染进程报错 */
function registerFallbackIpc(): void {
  if (!ipcMain.listenerCount('media-control:update-metadata')) {
    ipcMain.handle('media-control:update-metadata', () => {});
  }
  if (!ipcMain.listenerCount('media-control:update-state')) {
    ipcMain.handle('media-control:update-state', () => {});
  }
  if (!ipcMain.listenerCount('media-control:update-timeline')) {
    ipcMain.handle('media-control:update-timeline', () => {});
  }
  if (!ipcMain.listenerCount('media-control:update-skip-intervals')) {
    ipcMain.handle('media-control:update-skip-intervals', () => {});
  }
  if (!ipcMain.listenerCount('media-control:available')) {
    ipcMain.handle('media-control:available', () => false);
  }
}

/** 销毁媒体控制服务 */
export function destroyMediaControls(): void {
  if (coverAbortController) {
    coverAbortController.abort();
    coverAbortController = null;
  }
  activeCoverDownload = null;
  lastCoverCache = null;
  try {
    nativeModule?.shutdown();
  } catch {
    // 忽略
  }
  nativeModule = null;
}
