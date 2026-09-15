/** Serialize compositor updates; a remapped surface needs a fresh update even
 * when the saved blur setting has not changed. */
export function createHyprlandBlurQueue(
  apply: (enabled: boolean) => Promise<void>,
  isDestroyed: () => boolean,
  onError: (error: unknown) => void,
  retryDelayMs = 500,
) {
  let requested: boolean | null = null;
  let applied: boolean | null = null;
  let version = 0;
  let appliedVersion = -1;
  let running = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = () => {
    if (retryTimer || isDestroyed()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, retryDelayMs);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (requested !== null) {
        const target = requested;
        const targetVersion = version;
        requested = null;
        if (isDestroyed()) continue;
        if (target === applied && targetVersion === appliedVersion) continue;
        try {
          await apply(target);
          applied = target;
          appliedVersion = targetVersion;
          // If the window remapped while apply was in flight, the old result
          // cannot satisfy the new surface, even if the value is unchanged.
          if (version !== targetVersion && requested === null) requested = target;
        } catch (error) {
          onError(error);
          if (requested === null) requested = target;
          scheduleRetry();
          break;
        }
      }
    } finally {
      running = false;
      if (requested !== null && !retryTimer) void flush();
    }
  };

  return {
    setBlurEnabled(enabled: boolean, remapped = false) {
      if (remapped) version++;
      requested = enabled;
      void flush();
    },
  };
}
