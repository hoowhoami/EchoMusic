import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import log from 'electron-log';

/** 单个日志文件最大 1MB，超出后自动轮转（electron-log 默认值） */
const MAX_LOG_SIZE = 1024 * 1024;

/** 日志保留天数 */
const LOG_RETENTION_DAYS = 3;

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

  // 确保日志目录存在，避免 ENOENT
  ensureLogDir();

  log.transports.console.format = logFormat;
  log.transports.file.format = logFormat;

  // 按日期命名，同一天追加到同一个文件
  log.transports.file.fileName = getDailyLogFileName();
  log.transports.file.maxSize = MAX_LOG_SIZE;
  log.transports.file.level = app.isPackaged ? 'info' : 'silly';

  // 自动注入 console，这样代码里直接用 console.log 也能输出到日志
  Object.assign(console, log.functions);

  cleanOldLogs();
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
