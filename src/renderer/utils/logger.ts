/// <reference path="../electron.d.ts" />

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

const isDev = import.meta.env.DEV;

// 确保在渲染进程中使用，window 应该是可用的
const getElectronLog = (): LoggerFunctions | undefined => {
  try {
    const electron = (window as any).electron;
    return electron?.log;
  } catch (e) {
    return undefined;
  }
};

const electronLog = getElectronLog();

const formatArgs = (args: any[]) => {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return arg;
      }
    }
    return arg;
  }).join(' ');
};

// 创建一个符合 Logger 接口的对象
export const logger = {
  info: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.info(message);
    } else {
      console.info(`[INFO] [${module}]`, ...args);
    }
  },
  warn: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.warn(message);
    } else {
      console.warn(`[WARN] [${module}]`, ...args);
    }
  },
  error: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.error(message);
    } else {
      console.error(`[ERROR] [${module}]`, ...args);
    }
  },
  debug: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.debug(message);
    } else if (isDev) {
      console.debug(`[DEBUG] [${module}]`, ...args);
    }
  },
  verbose: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.verbose(message);
    } else if (isDev) {
      console.log(`[VERBOSE] [${module}]`, ...args);
    }
  },
  // 兼容旧调用或简单调用
  log: (module: string, ...args: any[]) => {
    const message = `[${module}] ${formatArgs(args)}`;
    if (electronLog && !isDev) {
      electronLog.info(message);
    } else {
      console.log(`[LOG] [${module}]`, ...args);
    }
  }
};

export default logger;
