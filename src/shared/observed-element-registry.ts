export interface ObservedElementRegistry<T extends object> {
  has(element: T): boolean;
  add(element: T, cleanup?: (() => void) | null): boolean;
  prune(isActive: (element: T) => boolean): number;
  release(element: T): boolean;
  clear(): void;
  getSize(): number;
}

export interface ObservedRootConnectionMonitor {
  check(): 'unchanged' | 'disconnected' | 'reconnected';
  isConnected(): boolean;
}

export interface RootConnectionMutationObserver<TTarget extends object> {
  observe(target: TTarget, options: { childList: true; subtree: true }): void;
  disconnect(): void;
}

export const observeRootConnectionChanges = <TTarget extends object>(
  target: TTarget,
  createObserver: (callback: () => void) => RootConnectionMutationObserver<TTarget>,
  monitor: ObservedRootConnectionMonitor,
) => {
  const observer = createObserver(() => monitor.check());
  observer.observe(target, { childList: true, subtree: true });
  return () => observer.disconnect();
};

export const createObservedRootConnectionMonitor = (
  readConnection: () => boolean,
  onDisconnected: () => void,
  onReconnected: () => void,
): ObservedRootConnectionMonitor => {
  let connected = readConnection();

  return {
    check: () => {
      const nextConnected = readConnection();
      if (nextConnected === connected) return 'unchanged';
      connected = nextConnected;
      if (connected) {
        onReconnected();
        return 'reconnected';
      }
      onDisconnected();
      return 'disconnected';
    },
    isConnected: () => connected,
  };
};

export const createObservedElementRegistry = <T extends object>(
  runCleanup: (cleanup: () => void) => void,
): ObservedElementRegistry<T> => {
  const entries = new Map<T, (() => void) | null>();

  const release = (element: T) => {
    if (!entries.has(element)) return false;
    const cleanup = entries.get(element);
    entries.delete(element);
    if (cleanup) runCleanup(cleanup);
    return true;
  };

  return {
    has: (element) => entries.has(element),
    add: (element, cleanup) => {
      if (entries.has(element)) return false;
      entries.set(element, typeof cleanup === 'function' ? cleanup : null);
      return true;
    },
    prune: (isActive) => {
      let released = 0;
      for (const element of Array.from(entries.keys())) {
        if (isActive(element)) continue;
        if (release(element)) released += 1;
      }
      return released;
    },
    release,
    clear: () => {
      for (const element of Array.from(entries.keys()).reverse()) release(element);
    },
    getSize: () => entries.size,
  };
};
