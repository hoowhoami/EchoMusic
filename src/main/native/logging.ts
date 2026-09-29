import log from '../logger';

type NativeLogLevel = 'info' | 'warn' | 'error';

export interface NativeLogEntry {
  level?: string;
  message?: string;
}

export interface NativeLogCapableAddon {
  registerLogHandler?: (
    callback: (errorOrEntry: Error | NativeLogEntry | null, entry?: NativeLogEntry) => void,
  ) => void;
}

function normalizeNativeLogLevel(level: unknown): NativeLogLevel {
  return level === 'warn' || level === 'error' || level === 'info' ? level : 'info';
}

export function registerNativeLogHandler(
  addon: NativeLogCapableAddon | null | undefined,
  moduleName: string,
): void {
  if (!addon?.registerLogHandler) return;
  try {
    addon.registerLogHandler((errorOrEntry, maybeEntry) => {
      if (errorOrEntry instanceof Error) {
        log.warn(`[NativeLog] ${moduleName} 日志回调失败: ${errorOrEntry.message}`);
        return;
      }
      const entry = maybeEntry ?? errorOrEntry ?? undefined;
      const level = normalizeNativeLogLevel(entry?.level);
      const message = entry?.message || '-';
      const formatted = `[${moduleName}] ${message}`;
      if (level === 'error') {
        log.error(formatted);
      } else if (level === 'warn') {
        log.warn(formatted);
      } else {
        log.info(formatted);
      }
    });
  } catch (error) {
    log.warn(`[NativeLog] ${moduleName} 日志回调注册失败: ${String(error)}`);
  }
}
