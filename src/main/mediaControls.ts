import { ipcMain, net } from 'electron';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'path';
import log from './logger';

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
  }): void;
  updatePlayState(payload: { status: string }): void;
  updateTimeline(payload: { currentTimeMs: number; totalTimeMs: number }): void;
  registerEventHandler(
    callback: (err: Error | null, event: { type: string; positionMs?: number }) => void,
  ): void;
}

let nativeModule: NativeMediaControls | null = null;
// 封面下载中止控制器
let coverAbortController: AbortController | null = null;

/** 加载 native addon */
function loadNativeModule(): NativeMediaControls | null {
  try {
    // 打包后在 extraResources 中
    const resourcePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'echo-media-controls.node')
      : path.join(__dirname, '../../native/echo-media-controls/echo-media-controls.node');

    log.info('[MediaControls] Loading native addon:', resourcePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(resourcePath) as NativeMediaControls;
  } catch (err) {
    log.warn('[MediaControls] Primary path load failed:', err);
    // 开发环境可能未编译，尝试直接加载
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../native/echo-media-controls') as NativeMediaControls;
    } catch {
      return null;
    }
  }
}

/** 下载图片为 Buffer */
async function downloadCoverImage(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!url) return null;
  try {
    return await new Promise<Buffer | null>((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const request = net.request(url);
      const chunks: Buffer[] = [];
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        request.abort();
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      request.on('response', (response) => {
        if (aborted) return;
        response.on('data', (chunk) => {
          if (!aborted) chunks.push(chunk);
        });
        response.on('end', () => {
          signal?.removeEventListener('abort', onAbort);
          if (aborted) return;
          resolve(Buffer.concat(chunks));
        });
        response.on('error', () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(null);
        });
      });
      request.on('error', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(null);
      });
      // 超时 5 秒
      setTimeout(() => {
        if (!aborted) {
          aborted = true;
          request.abort();
          resolve(null);
        }
      }, 5000);
      request.end();
    });
  } catch {
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
    log.info('[MediaControls] System media event:', event);
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
      if (!nativeModule) return;

      log.info('[MediaControls] Metadata update received', {
        title: payload.title,
        artist: payload.artist,
        hasCoverUrl: !!payload.coverUrl,
        durationMs: payload.durationMs,
      });

      // 取消上一次封面下载
      if (coverAbortController) {
        coverAbortController.abort();
      }
      coverAbortController = new AbortController();

      let coverData: Buffer | null = null;
      if (payload.coverUrl) {
        coverData = await downloadCoverImage(payload.coverUrl, coverAbortController.signal);
        log.info('[MediaControls] Cover download result', {
          success: !!coverData,
          size: coverData?.length ?? 0,
        });
      }

      try {
        // native addon 期望 coverData 为 number[]（NAPI-RS 的 Vec<u8> 映射）
        nativeModule.updateMetadata({
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
