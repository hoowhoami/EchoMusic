import { spawn } from 'node:child_process';
import log from '../logger';

type LogLevel = 'info' | 'warn' | 'error';

const SERVICES = ['_airplay._tcp', '_raop._tcp', '_airplay-p2p._tcp'];
const DIAGNOSTIC_TIMEOUT_MS = 5000;
const DIAGNOSTIC_INTERVAL_MS = 20000;

let lastRunAt = 0;
let running = false;

function parseBrowseLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(Add|Rmv)\b/.test(line))
    .slice(0, 12);
}

function browseService(service: string, writeLog: (level: LogLevel, message: string) => void) {
  return new Promise<void>((resolve) => {
    const child = spawn('/usr/bin/dns-sd', ['-B', service, 'local.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      const lines = parseBrowseLines(stdout);
      if (lines.length > 0) {
        writeLog('info', `AirPlay Bonjour 诊断 ${service}: ${lines.join(' | ')}`);
      } else {
        writeLog('info', `AirPlay Bonjour 诊断 ${service}: 未发现服务`);
      }
      const errorText = stderr.trim();
      if (errorText) {
        writeLog('warn', `AirPlay Bonjour 诊断 ${service} stderr: ${errorText}`);
      }
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish();
    }, DIAGNOSTIC_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      writeLog('warn', `AirPlay Bonjour 诊断 ${service} 启动失败: ${error.message}`);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export function runMacAirplayBonjourDiagnostics(
  writeLog: (level: LogLevel, message: string) => void = (level, message) => {
    if (level === 'error') log.error(message);
    else if (level === 'warn') log.warn(message);
    else log.info(message);
  },
): void {
  if (process.platform !== 'darwin') return;
  const now = Date.now();
  if (running || now - lastRunAt < DIAGNOSTIC_INTERVAL_MS) return;
  running = true;
  lastRunAt = now;

  void Promise.all(SERVICES.map((service) => browseService(service, writeLog))).finally(() => {
    running = false;
  });
}
