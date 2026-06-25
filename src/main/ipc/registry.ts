import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import log, { isDiagnosticModeActive } from '../logger';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any;
type IpcListener = (event: IpcMainEvent, ...args: any[]) => void;

// IPC 同步占用计时阈值：handler/listener 占用主线程同步执行超过此值即告警，
// 用于定位是哪个通道在阻塞主进程（如切歌时的地址解析、媒体控制等）。
const IPC_SYNC_WARN_MS = 50;

class IpcRegistry {
  private handlers = new Map<string, IpcHandler>();
  private listeners = new Map<string, IpcListener[]>();

  registerHandler(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      console.warn(`[IPC] Handler for channel "${channel}" already registered, replacing`);
      ipcMain.removeHandler(channel);
    }
    this.handlers.set(channel, handler);
    ipcMain.handle(channel, async (event, ...args) => {
      // 计时仅在诊断模式开启时进行（平时一次布尔判断，近乎零开销）。
      // 测的是 handler 同步执行（返回前/首个 await 让出前）占用主线程的时长；
      // 异步等待（网络/工作线程）不计入，因为那不阻塞主线程。
      const profiling = isDiagnosticModeActive();
      const start = profiling ? performance.now() : 0;
      try {
        const result = handler(event, ...args);
        if (profiling) {
          const syncMs = performance.now() - start;
          if (syncMs >= IPC_SYNC_WARN_MS) {
            log.warn(`[IPCProfiler] handler "${channel}" 同步占用主线程 ~${Math.round(syncMs)}ms`);
          }
        }
        return await result;
      } catch (error) {
        log.error('[IPC] Handler failed', {
          channel,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : '',
        });
        throw error;
      }
    });
  }

  registerListener(channel: string, listener: IpcListener): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, []);
    }
    // 包裹计时：listener 是同步执行的，整段都占用主线程。仅诊断模式开启时计时。
    const wrapped: IpcListener = (event, ...args) => {
      const profiling = isDiagnosticModeActive();
      const start = profiling ? performance.now() : 0;
      try {
        listener(event, ...args);
      } finally {
        if (profiling) {
          const syncMs = performance.now() - start;
          if (syncMs >= IPC_SYNC_WARN_MS) {
            log.warn(`[IPCProfiler] listener "${channel}" 同步占用主线程 ~${Math.round(syncMs)}ms`);
          }
        }
      }
    };
    this.listeners.get(channel)!.push(wrapped);
    ipcMain.on(channel, wrapped);
  }

  unregisterAll(): void {
    // Remove all handlers
    for (const channel of this.handlers.keys()) {
      ipcMain.removeHandler(channel);
    }
    this.handlers.clear();

    // Remove all listeners
    for (const [channel, listeners] of this.listeners.entries()) {
      for (const listener of listeners) {
        ipcMain.removeListener(channel, listener);
      }
    }
    this.listeners.clear();
  }

  getRegisteredChannels(): string[] {
    return [...this.handlers.keys(), ...this.listeners.keys()];
  }
}

export const ipcRegistry = new IpcRegistry();
