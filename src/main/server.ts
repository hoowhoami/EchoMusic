import { ChildProcess, execSync, spawn } from 'child_process';
import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import net from 'net';
import path from 'path';
import log from 'electron-log';
import type { ApiServerState, ApiServerStatus } from '../shared/api-server';

let apiProcess: ChildProcess | null = null;
let apiStartPromise: Promise<void> | null = null;

const isDev = !app.isPackaged;
const API_PORT = 6609;
const API_HOST = '127.0.0.1';
const API_START_TIMEOUT_MS = 15000;
const API_POLL_INTERVAL_MS = 300;

let apiStatus: ApiServerStatus = {
  state: 'idle',
  updatedAt: Date.now(),
};

const broadcastApiStatus = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send('api-server:status-changed', apiStatus);
  }
};

const setApiStatus = (state: ApiServerState, error?: string) => {
  apiStatus = {
    state,
    ...(error ? { error } : {}),
    updatedAt: Date.now(),
  };
  broadcastApiStatus();
};

export const getApiServerStatus = (): ApiServerStatus => apiStatus;

export const getActiveApiPort = (): number => API_PORT;

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

const ensureExecutable = (filePath: string) => {
  if (process.platform === 'win32' || !fs.existsSync(filePath)) return;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    log.warn(`[Server] Failed to chmod ${filePath}:`, err);
  }
};

const isChildProcessAlive = (child: ChildProcess | null) => {
  if (!child?.pid) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const isPortReachable = (port: number, host: string) => {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host });
    const finalize = (result: boolean) => {
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
  });
};

const waitForApiReady = (port: number, host: string, timeoutMs: number) => {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let finished = false;
    const finish = (cb: () => void) => {
      if (finished) return;
      finished = true;
      cb();
    };
    const poll = async () => {
      if (finished) return;
      if (Date.now() - startedAt >= timeoutMs) {
        finish(() => reject(new Error('API start timeout')));
        return;
      }
      if (await isPortReachable(port, host)) {
        finish(() => resolve());
        return;
      }
      if (apiProcess && !isChildProcessAlive(apiProcess)) {
        finish(() => reject(new Error('API process exited before becoming ready')));
        return;
      }
      setTimeout(() => void poll(), API_POLL_INTERVAL_MS);
    };
    void poll();
  });
};

/** 获取占用指定端口的进程 PID */
const getPortOccupantPid = (port: number): number | null => {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -aon | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      const match = output.split('\n')[0]?.trim().split(/\s+/).pop();
      return match ? parseInt(match, 10) || null : null;
    } else {
      const output = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return parseInt(output.split('\n')[0], 10) || null;
    }
  } catch {
    return null;
  }
};

/** 检查 PID 是否是我们自己的 server 二进制 */
const isOwnServerProcess = (pid: number): boolean => {
  const ownNames = ['app_win.exe', 'app_macos', 'app_linux'];
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `wmic process where ProcessId=${pid} get ExecutablePath /format:list`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      return ownNames.some((n) => output.toLowerCase().includes(n.toLowerCase()));
    } else {
      const output = execSync(`ps -p ${pid} -o comm=`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return ownNames.some((n) => output.includes(n));
    }
  } catch {
    return false;
  }
};

/**
 * 清理端口上残留的自己的 server 进程。
 * 只杀确认是自己二进制的进程，不动别人的。
 */
const cleanupOwnStaleServer = () => {
  const pid = getPortOccupantPid(API_PORT);
  if (!pid) return;
  if (!isOwnServerProcess(pid)) {
    log.info(
      `[Server] Port ${API_PORT} occupied by foreign process (PID ${pid}), skipping cleanup`,
    );
    return;
  }
  log.info(`[Server] Killing stale own server on port ${API_PORT} (PID ${pid})`);
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // 进程可能已退出
  }
};

export function startApiServer() {
  if (apiStatus.state === 'ready' && isChildProcessAlive(apiProcess)) {
    return Promise.resolve();
  }

  if (apiStartPromise) {
    return apiStartPromise;
  }

  setApiStatus('starting');

  apiStartPromise = (async () => {
    // 端口已有服务在监听，可能是上次残留的实例，直接复用
    if (await isPortReachable(API_PORT, API_HOST)) {
      log.info(`[Server] API already reachable at http://${API_HOST}:${API_PORT}`);
      setApiStatus('ready');
      return;
    }

    // 清理自己的残留进程（崩溃/强退后可能残留）
    cleanupOwnStaleServer();

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
      } catch (error) {
        log.error('[Server] npm install failed:', error);
      }

      log.info('[Server] Dev mode: Starting API server...');
      apiPath = npmCmd;
      args = ['run', 'dev', '--', `--port=${API_PORT}`, '--platform=lite', `--host=${API_HOST}`];
    } else {
      cwd = path.join(process.resourcesPath, 'server');
      apiPath = resolvePackagedServerEntry(cwd);
      if (!apiPath) {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }
      ensureExecutable(apiPath);
      args = [`--port=${API_PORT}`, '--platform=lite', `--host=${API_HOST}`];
    }

    log.info(`[Server] Launching API: ${apiPath} ${args.join(' ')} (cwd: ${cwd})`);

    apiProcess = spawn(apiPath, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOST: API_HOST,
        PORT: String(API_PORT),
        platform: 'lite',
      },
    });

    apiProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (!output || output.includes('[OK]') || output.includes('[ERR]')) return;
      log.info(`[Server] ${output}`);
    });

    apiProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) log.warn(`[Server] API Warning: ${output}`);
    });

    apiProcess.once('error', (error) => {
      log.error('[Server] Failed to start API:', error);
    });

    apiProcess.once('close', (code, signal) => {
      log.info(`[Server] API Process exited with code: ${code}, signal: ${signal ?? 'none'}`);
      apiProcess = null;
      if (apiStatus.state !== 'failed') setApiStatus('idle');
    });

    try {
      await waitForApiReady(API_PORT, API_HOST, API_START_TIMEOUT_MS);
      log.info(`[Server] API Server is ready at http://${API_HOST}:${API_PORT}`);
      setApiStatus('ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApiStatus('failed', message);
      stopApiServer(false);
      throw error;
    }
  })().finally(() => {
    apiStartPromise = null;
  });

  return apiStartPromise;
}

export function stopApiServer(updateStatus = true) {
  apiStartPromise = null;

  if (apiProcess && apiProcess.pid) {
    try {
      process.kill(apiProcess.pid, 0);
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${apiProcess.pid}`, { stdio: 'ignore' });
      } else {
        process.kill(-apiProcess.pid, 'SIGKILL');
      }
    } catch (error) {
      log.warn(`[Server] Stop API failed or process not found: ${error}`);
    } finally {
      apiProcess = null;
    }
  }

  if (updateStatus) {
    setApiStatus('idle');
  }
}
