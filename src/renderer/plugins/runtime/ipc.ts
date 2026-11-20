import { logger } from '@/utils/logger';

/**
 * 提取直接调用方位置，便于序列化降级时定位来源。
 * 第 0 行为 Error 自身，第 1 行为本函数，第 2 行为 serializeForIpc，第 3 行为调用方。
 */
const getCallerLocation = (): string => {
  const lines = new Error().stack?.split('\n') ?? [];
  return lines[3]?.trim().replace(/^at\s+/, '') || 'unknown';
};

/**
 * 通过 IPC 发送前做一次可序列化拷贝。
 * 失败时仍返回 null 以保持调用方容错，但会记录告警，
 * 避免插件传入不可序列化对象（函数、循环引用等）时主进程收到 null 却无迹可查。
 * @param context 可选调用来源（方法名），便于在日志中快速定位
 */
export const serializeForIpc = (value: unknown, context = ''): unknown => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    logger.warn('PluginIpc', 'IPC 载荷序列化失败，已降级为 null', {
      context: context || undefined,
      caller: getCallerLocation(),
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
