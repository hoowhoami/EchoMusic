import { app } from 'electron';
import { dirname, join } from 'path';
import fs from 'fs';
import log from 'electron-log';

/**
 * 初始化日志配置
 */
export function initLogger() {
  const logFormat = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  log.initialize();

  log.transports.console.format = logFormat;
  log.transports.file.format = logFormat;

  const date = new Date();
  const dateStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}-${date.getMinutes().toString().padStart(2, '0')}-${date.getSeconds().toString().padStart(2, '0')}`;
  log.transports.file.fileName = `echo-music-${dateStr}.log`;
  log.transports.file.level = app.isPackaged ? 'info' : 'silly';

  // 自动注入 console，这样代码里直接用 console.log 也能输出到日志
  Object.assign(console, log.functions);

  cleanOldLogs();
}

/**
 * 清理3天前的日志
 */
function cleanOldLogs() {
  try {
    const logPath = app.getPath('logs');
    if (!logPath) return;
    const logDir = dirname(join(logPath, log.transports.file.fileName || 'main.log'));
    if (!fs.existsSync(logDir)) return;

    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    files.forEach((file) => {
      if (file.startsWith('echo-music-') && file.endsWith('.log')) {
        const filePath = join(logDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > threeDaysMs) {
          fs.unlinkSync(filePath);
          log.info(`[LogCleaner] Deleted old log file: ${file}`);
        }
      }
    });
  } catch (err) {
    console.error('[LogCleaner] Error cleaning old logs:', err);
  }
}

export default log;
