import { ChildProcess, spawn, execSync } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import log from 'electron-log';

let apiProcess: ChildProcess | null = null;
const isDev = !app.isPackaged;

const resolvePackagedServerEntry = (cwd: string) => {
  const platformBinaryName =
    process.platform === 'win32'
      ? 'app_win.exe'
      : process.platform === 'darwin'
        ? 'app_macos'
        : process.platform === 'linux'
          ? 'app_linux'
          : '';

  if (!platformBinaryName) return '';

  const candidates = [
    path.join(cwd, platformBinaryName),
    path.join(cwd, 'bin', platformBinaryName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
};

/**
 * 启动 API 服务器
 */
export function startApiServer() {
  return new Promise<void>((resolve, reject) => {
    const port = 12306;

    // 启动前先尝试清理端口占用
    try {
        log.info(`[Server] Cleaning up port ${port}...`);
        if (process.platform === 'win32') {
            execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /f /pid %a`, { stdio: 'ignore' });
        } else {
            execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
        }
    } catch (e) {
        // Ignore
    }

    let apiPath = '';
    let cwd = '';
    let args: string[] = [];

    if (isDev) {
      cwd = path.join(process.cwd(), 'server');
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      
      log.info(`[Server] Dev mode: Running npm install in ${cwd}...`);
      try {
        execSync(`${npmCmd} install`, { cwd, stdio: 'inherit' });
        log.info('[Server] npm install finished');
      } catch (e) {
        log.error('[Server] npm install failed:', e);
      }

      log.info(`[Server] Dev mode: Starting API server...`);
      apiPath = npmCmd;
      args = ['run', 'dev', '--', `--port=${port}`, '--platform=lite'];
    } else {
      cwd = path.join(process.resourcesPath, 'server');
      apiPath = resolvePackagedServerEntry(cwd);
      if (!apiPath) {
        return reject(new Error(`Unsupported platform: ${process.platform}`));
      }
      args = [`--port=${port}`, '--platform=lite', '--host=127.0.0.1'];
    }

    if (!isDev && !fs.existsSync(apiPath)) {
      const error = new Error(`API executable not found: ${apiPath}`);
      log.error(error.message);
      return reject(error);
    }

    apiProcess = spawn(apiPath, args, { cwd, windowsHide: true });

    apiProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      // 过滤掉冗余的 [OK]/[ERR] 路径日志，因为渲染进程已经记录了 API 请求
      if (output.includes('[OK]') || output.includes('[ERR]')) {
        return;
      }
      
      // 仅记录关键信息
      if (output.includes('running') || output.includes('server started') || output.includes('localhost:12306') || output.includes('127.0.0.1:12306')) {
        log.info('[Server] API Server is ready');
        resolve();
      } else if (output) {
        log.debug(`[Server] API Output: ${output}`);
      }
    });

    apiProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        log.warn(`[Server] API Warning: ${output}`);
      }
    });

    apiProcess.on('close', (code) => {
      log.info(`[Server] API Process exited with code: ${code}`);
    });

    apiProcess.on('error', (error) => {
      log.error('[Server] Failed to start API:', error);
      reject(error);
    });

    // 15s timeout
    setTimeout(() => {
        reject(new Error('API start timeout'));
    }, 15000);
  });
}

/**
 * 停止 API 服务器
 */
export function stopApiServer() {
  if (apiProcess && apiProcess.pid) {
    try {
      process.kill(apiProcess.pid, 0);
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec(`taskkill /F /T /PID ${apiProcess.pid}`);
      } else {
        process.kill(-apiProcess.pid, 'SIGKILL');
      }
    } catch (e) {
      log.warn(`[Server] Stop API failed or process not found: ${e}`);
    } finally {
      apiProcess = null;
    }
  }
}
