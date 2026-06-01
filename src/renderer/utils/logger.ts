import type {} from '../electron.d.ts';
import {
  DEFAULT_LOG_SETTINGS,
  getEffectiveLogLevel,
  isLogLevelEnabled,
  normalizeLogSettings,
  stringifyForLog,
  type AppLogLevel,
  type LogSettings,
} from '../../shared/logging';

/**
 * 接入 electron-log 的日志工具，支持开发环境回退到 console
 */

interface LoggerFunctions {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  verbose: (...args: any[]) => void;
}

// 确保在渲染进程中使用，window 应该是可用的
const getElectronLog = (): LoggerFunctions | undefined => {
  try {
    const electron = (window as any).electron;
    return electron?.log;
  } catch {
    return undefined;
  }
};

const electronLog = getElectronLog();

const readPersistedSettings = (): LogSettings => {
  try {
    const raw = window.localStorage.getItem('setting');
    if (!raw) return DEFAULT_LOG_SETTINGS;
    const parsed = JSON.parse(raw);
    return normalizeLogSettings({
      level: parsed?.logLevel,
      apiResponseBody: parsed?.logApiResponseBody,
      diagnosticUntil: parsed?.logDiagnosticUntil,
    });
  } catch {
    return DEFAULT_LOG_SETTINGS;
  }
};

let currentSettings = readPersistedSettings();

export const configureRendererLogger = (settings?: Partial<LogSettings> | null) => {
  currentSettings = normalizeLogSettings(settings);
};

export const getRendererLogSettings = () => currentSettings;

export const isRendererLogLevelEnabled = (level: AppLogLevel) =>
  isLogLevelEnabled(level, getEffectiveLogLevel(currentSettings));

const formatArgs = (args: any[]) => {
  return args
    .map((arg) =>
      typeof arg === 'string' ? stringifyForLog(arg, 2000) : stringifyForLog(arg, 2000),
    )
    .join(' ');
};

const writeLog = (
  level: AppLogLevel,
  module: string,
  args: any[],
  fallback: (...args: any[]) => void,
) => {
  if (!isRendererLogLevelEnabled(level)) return;
  const message = `[${module}] ${formatArgs(args)}`;
  if (electronLog) {
    electronLog[level](message);
  } else {
    fallback(message);
  }
};

// 创建一个符合 Logger 接口的对象
export const logger = {
  info: (module: string, ...args: any[]) => {
    writeLog('info', module, args, console.info);
  },
  warn: (module: string, ...args: any[]) => {
    writeLog('warn', module, args, console.warn);
  },
  error: (module: string, ...args: any[]) => {
    writeLog('error', module, args, console.error);
  },
  debug: (module: string, ...args: any[]) => {
    writeLog('debug', module, args, console.debug);
  },
  verbose: (module: string, ...args: any[]) => {
    writeLog('verbose', module, args, console.log);
  },
  // 兼容旧调用或简单调用
  log: (module: string, ...args: any[]) => {
    writeLog('info', module, args, console.log);
  },
  isEnabled: isRendererLogLevelEnabled,
  configure: configureRendererLogger,
  settings: getRendererLogSettings,
};

export default logger;
