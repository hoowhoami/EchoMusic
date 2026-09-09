import type { EventEmitter } from 'node:events';

/** A detached terminal must not make logging fatal or disable file logging. */
export function createConsolePipeGuard(onDisconnect: () => void) {
  let disconnected = false;
  const handleError = (error: unknown) => {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EPIPE') {
      throw error;
    }
    if (!disconnected) {
      disconnected = true;
      onDisconnect();
    }
  };
  return {
    get disconnected() { return disconnected; },
    watch(stream: EventEmitter) { stream.on('error', handleError); },
    write(write: () => void) {
      if (disconnected) return;
      try {
        write();
      } catch (error) {
        handleError(error);
      }
    },
  };
}
