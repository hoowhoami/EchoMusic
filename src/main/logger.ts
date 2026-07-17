import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import log from 'electron-log';
import {
  getEffectiveLogLevel,
  isDiagnosticActive,
  normalizeLogSettings,
  type LogSettings,
} from '../shared/logging';
import { getPersistedLogSettings, setPersistedLogSettings } from './storage/settings';

/** 单个日志文件最大 5MB，超出后自动轮转 */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** 日志保留天数 */
const LOG_RETENTION_DAYS = 7;

let currentLogSettings = normalizeLogSettings(getPersistedLogSettings());
let loggerInitialized = false;
let diagnosticTimer: NodeJS.Timeout | null = null;

/**
 * 确保日志目录存在
 */
function ensureLogDir() {
  try {
    const logDir = app.getPath('logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch {
    // 目录创建失败时静默处理，后续写入会走 console fallback
  }
}

/**
 * 获取按日期命名的日志文件名，如 echo-music-2026-04-17.log
 */
function getDailyLogFileName() {
  const date = new Date();
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `echo-music-${y}-${m}-${d}.log`;
}

/**
 * 初始化日志配置
 */
export function initLogger() {
  const logFormat = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  log.initialize();
  loggerInitialized = true;

  // 确保日志目录存在，避免 ENOENT
  ensureLogDir();

  log.transports.console.format = logFormat;
  log.transports.file.format = logFormat;

  // 文件写入改为异步：electron-log 默认 sync=true，会在主进程用 fs.writeFileSync 同步写盘，
  // 日志爆发时会串行阻塞主进程；叠加锁定桌面歌词的全局鼠标钩子会卡光标。
  // 异步模式下写入进入队列、由 fs.writeFile 批量刷盘，不阻塞主线程（顺序仍有保证）。
  log.transports.file.sync = false;

  // 按日期命名，同一天追加到同一个文件
  log.transports.file.fileName = getDailyLogFileName();
  log.transports.file.maxSize = MAX_LOG_SIZE;
  applyLogSettings(currentLogSettings);

  // 自动注入 console，这样代码里直接用 console.log 也能输出到日志
  Object.assign(console, log.functions);

  cleanOldLogs();
}

export function getLogSettings(): LogSettings {
  return currentLogSettings;
}

/**
 * 当前是否处于诊断模式（用户临时开启的高级日志窗口期内）。
 * 性能哨兵（事件循环卡顿探测、IPC 同步占用计时）据此判断是否输出，
 * 平时（非诊断模式）不产生日志、近乎零开销。
 */
export function isDiagnosticModeActive(): boolean {
  return isDiagnosticActive(currentLogSettings);
}

// 诊断状态变更监听：用于让性能哨兵（事件循环卡顿探测器）仅在诊断模式期间启停其定时器，
// 非诊断模式下完全不占用资源（连定时器都不创建）。
let diagnosticStateListener: ((active: boolean) => void) | null = null;

export function setDiagnosticStateListener(listener: ((active: boolean) => void) | null): void {
  diagnosticStateListener = listener;
  // 注册即用当前状态触发一次，保证启动时若已处于诊断窗口期能立即生效
  if (listener) listener(isDiagnosticActive(currentLogSettings));
}

export function applyLogSettings(settings?: Partial<LogSettings> | null, persist = false) {
  currentLogSettings = normalizeLogSettings(settings);
  if (persist) {
    setPersistedLogSettings(currentLogSettings);
  }

  if (diagnosticTimer) {
    clearTimeout(diagnosticTimer);
    diagnosticTimer = null;
  }

  if (!loggerInitialized) return currentLogSettings;

  const effectiveLevel = getEffectiveLogLevel(currentLogSettings);
  log.transports.file.level = effectiveLevel;
  log.transports.console.level = app.isPackaged ? 'warn' : effectiveLevel;

  const remainingMs = currentLogSettings.diagnosticUntil - Date.now();
  if (remainingMs > 0) {
    diagnosticTimer = setTimeout(
      () => {
        diagnosticTimer = null;
        if (isDiagnosticActive(currentLogSettings)) {
          applyLogSettings(currentLogSettings);
        } else {
          applyLogSettings({ ...currentLogSettings, diagnosticUntil: 0 }, true);
        }
      },
      Math.min(remainingMs, 2 ** 31 - 1),
    );
    if (typeof diagnosticTimer.unref === 'function') diagnosticTimer.unref();
  }

  // 通知监听者当前诊断状态，驱动性能哨兵启停
  diagnosticStateListener?.(isDiagnosticActive(currentLogSettings));

  return currentLogSettings;
}

/**
 * 清理过期日志文件
 */
function cleanOldLogs() {
  try {
    const logDir = app.getPath('logs');
    if (!logDir || !fs.existsSync(logDir)) return;

    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('echo-music-') || !file.endsWith('.log')) continue;
      const filePath = join(logDir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtime.getTime() > retentionMs) {
        fs.unlinkSync(filePath);
        log.info(`[LogCleaner] 已删除过期日志: ${file}`);
      }
    }
  } catch (err) {
    console.error('[LogCleaner] 清理日志失败:', err);
  }
}

export default log;
