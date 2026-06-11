import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any;
type IpcListener = (event: IpcMainEvent, ...args: any[]) => void;

class IpcRegistry {
  private handlers = new Map<string, IpcHandler>();
  private listeners = new Map<string, IpcListener[]>();

  registerHandler(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      console.warn(`[IPC] Handler for channel "${channel}" already registered, replacing`);
      ipcMain.removeHandler(channel);
    }
    this.handlers.set(channel, handler);
    ipcMain.handle(channel, handler);
  }

  registerListener(channel: string, listener: IpcListener): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, []);
    }
    this.listeners.get(channel)!.push(listener);
    ipcMain.on(channel, listener);
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
