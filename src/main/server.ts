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
const API_PORT = 12306;
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

  const candidates = [path.join(cwd, platformBinaryName), path.join(cwd, 'bin', platformBinaryName)];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
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
      if (!socket.destroyed) {
        socket.destroy();
      }
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

    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      callback();
    };

    const poll = async () => {
      if (finished) return;

      if (Date.now() - startedAt >= timeoutMs) {
        finish(() => reject(new Error('API start timeout')));
        return;
      }

      const reachable = await isPortReachable(port, host);
      if (reachable) {
        finish(() => resolve());
        return;
      }

      if (apiProcess && !isChildProcessAlive(apiProcess)) {
        finish(() => reject(new Error('API process exited before becoming ready')));
        return;
      }

      setTimeout(() => {
        void poll();
      }, API_POLL_INTERVAL_MS);
    };

    void poll();
  });
};

const cleanupPort = (port: number) => {
  try {
    log.info(`[Server] Cleaning up port ${port}...`);
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /f /pid %a`, {
        stdio: 'ignore',
      });
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch {
    log.info(`[Server] Port ${port} is available`);
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
    const port = API_PORT;

    if (await isPortReachable(port, API_HOST)) {
      log.info(`[Server] API already reachable at http://${API_HOST}:${port}`);
      setApiStatus('ready');
      return;
    }

    cleanupPort(port);

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
      args = ['run', 'dev', '--', `--port=${port}`, '--platform=lite', `--host=${API_HOST}`];
    } else {
      cwd = path.join(process.resourcesPath, 'server');
      apiPath = resolvePackagedServerEntry(cwd);
      if (!apiPath) {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }
      args = [`--port=${port}`, '--platform=lite', `--host=${API_HOST}`];
    }

    if (!isDev && !fs.existsSync(apiPath)) {
      throw new Error(`API executable not found: ${apiPath}`);
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
        PORT: String(port),
        platform: 'lite',
      },
    });

    apiProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (!output || output.includes('[OK]') || output.includes('[ERR]')) {
        return;
      }

      log.info(`[Server] ${output}`);
    });

    apiProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        log.warn(`[Server] API Warning: ${output}`);
      }
    });

    apiProcess.once('error', (error) => {
      log.error('[Server] Failed to start API:', error);
    });

    apiProcess.once('close', (code, signal) => {
      log.info(`[Server] API Process exited with code: ${code}, signal: ${signal ?? 'none'}`);
      apiProcess = null;
      if (apiStatus.state !== 'failed') {
        setApiStatus('idle');
      }
    });

    try {
      await waitForApiReady(port, API_HOST, API_START_TIMEOUT_MS);
      log.info(`[Server] API Server is ready at http://${API_HOST}:${port}`);
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
        const { exec } = require('child_process');
        exec(`taskkill /F /T /PID ${apiProcess.pid}`);
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
