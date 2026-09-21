import { app, screen } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskbarRect, TaskbarShellLayout } from './taskbarDock';
import log from './logger';

let layouts = new Map<number, TaskbarShellLayout>();
let updatedAt = 0;
let pending: Promise<void> | null = null;
let lastFailure = '';
let playerHandle: string | undefined;
export const setTaskbarProbeWindow = (handle?: Buffer) => {
  playerHandle = handle
    ? handle.length >= 8
      ? handle.readBigUInt64LE().toString()
      : String(handle.readUInt32LE())
    : undefined;
};

const validRect = (r: TaskbarRect) =>
  r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

export const getTaskbarShellLayout = (displayId: number) =>
  Date.now() - updatedAt < 7000 ? layouts.get(displayId) : undefined;

export const refreshTaskbarShellLayout = (): Promise<void> => {
  if (pending) return pending;
  const helper = app.isPackaged
    ? join(process.resourcesPath, 'native/EchoMusic.TaskbarLayout.exe')
    : join(__dirname, '../../build/taskbar-layout/EchoMusic.TaskbarLayout.exe');
  if (process.platform !== 'win32' || !existsSync(helper)) {
    layouts.clear();
    return Promise.resolve();
  }
  const queriedHandle = playerHandle;
  pending = new Promise<void>((resolve) => {
    // No Explorer injection, settings writes or focus changes. Terminate a hung
    // accessibility provider without blocking Electron's main thread.
    execFile(
      helper,
      queriedHandle ? [queriedHandle] : [],
      { windowsHide: true, timeout: 2500, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        try {
          if (error) throw error;
          const raw: TaskbarShellLayout[] = JSON.parse(stdout);
          if (!Array.isArray(raw)) throw new Error('Invalid shell layout response');
          const next = new Map<number, TaskbarShellLayout>();
          for (const bar of raw) {
            if (!validRect(bar.bounds) || !Array.isArray(bar.occupied)) continue;
            const bounds = screen.screenToDipRect(null, bar.bounds);
            const display = screen.getDisplayMatching(bounds);
            next.set(display.id, {
              bounds,
              reliable: bar.reliable === true,
              // Window state belongs only to the HWND that this probe queried.
              // A missing field or a recreated window is unknown, not hidden.
              playerVisible:
                queriedHandle &&
                queriedHandle === playerHandle &&
                typeof bar.playerVisible === 'boolean'
                  ? bar.playerVisible
                  : undefined,
              shellAbovePlayer:
                queriedHandle &&
                queriedHandle === playerHandle &&
                typeof bar.shellAbovePlayer === 'boolean'
                  ? bar.shellAbovePlayer
                  : undefined,
              foregroundFullscreen: bar.foregroundFullscreen === true,
              playerBounds:
                queriedHandle &&
                queriedHandle === playerHandle &&
                bar.playerBounds &&
                validRect(bar.playerBounds)
                  ? screen.screenToDipRect(null, bar.playerBounds)
                  : undefined,
              occupied: bar.occupied
                .filter(validRect)
                .map((rect) => screen.screenToDipRect(null, rect)),
            });
          }
          layouts = next;
          lastFailure = '';
        } catch (failure) {
          layouts.clear();
          const message = failure instanceof Error ? failure.message : String(failure);
          if (message !== lastFailure)
            log.warn('[TaskbarMediaBar] Shell probe unavailable; using safe work area', message);
          lastFailure = message;
        } finally {
          updatedAt = Date.now();
          resolve();
        }
      },
    );
  }).finally(() => {
    pending = null;
  });
  return pending;
};
