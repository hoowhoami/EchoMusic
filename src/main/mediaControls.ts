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
  registerEventHandler(
    callback: (err: Error | null, event: { type: string; positionMs?: number }) => void,
  ): void;
}

let nativeModule: NativeMediaControls | null = null;
// 封面下载中止控制器
let coverAbortController: AbortController | null = null;
let metadataUpdateSeq = 0;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

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
    log.debug('[MediaControls] Starting cover download', { url });

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = setTimeout(() => controller.abort(), 5000);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
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

      log.debug('[MediaControls] Cover download completed', { size: buffer.length, url });
      return buffer;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }
  } catch (err) {
    log.warn('[MediaControls] Cover download exception:', err);
    return null;
  }
}

/** 初始化原生媒体控制服务 */
export function initMediaControls(getMainWindow: () => BrowserWindow | null): void {
  nativeModule = loadNativeModule();
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

      log.debug('[MediaControls] Metadata update received', {
        title: payload.title,
        artist: payload.artist,
        hasCoverUrl: !!payload.coverUrl,
        durationMs: payload.durationMs,
      });

      // 取消上一次封面下载
      if (coverAbortController) {
        coverAbortController.abort();
      }
      const coverController = new AbortController();
      coverAbortController = coverController;

      let coverData: Buffer | null = null;
      if (payload.coverUrl) {
        log.debug('[MediaControls] Starting cover download', { url: payload.coverUrl });
        coverData = await downloadCoverImage(payload.coverUrl, coverController.signal);
        log.debug('[MediaControls] Cover download result', {
          success: !!coverData,
          size: coverData?.length ?? 0,
          url: payload.coverUrl,
        });
      }

      if (requestSeq !== metadataUpdateSeq) {
        log.debug('[MediaControls] Ignored stale metadata update', {
          title: payload.title,
          url: payload.coverUrl,
        });
        return;
      }
      if (coverAbortController === coverController) {
        coverAbortController = null;
      }

      // 任务栏 DWM 缩略图需要及时响应系统请求，不能被 SMTC 的异步元数据更新挡住。
      setTaskbarCover(coverData);

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
  try {
    nativeModule?.shutdown();
  } catch {
    // 忽略
  }
  nativeModule = null;
}
