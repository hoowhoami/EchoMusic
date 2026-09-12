import { execFile } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import log from '../logger';

type HyprlandWindow = Pick<BrowserWindow, 'getNativeWindowHandle' | 'isDestroyed' | 'getTitle'>;

const HYPRCTL_TIMEOUT_MS = 2000;
const HYPRLAND_RETRY_MS = 500;
const MIN_WINDOW_ADDRESS = 0x100;

const getWindowAddress = (win: HyprlandWindow) => {
  const handle = win.getNativeWindowHandle();
  if (handle.length >= 8) {
    const address = handle.readBigUInt64LE();
    if (address > BigInt(MIN_WINDOW_ADDRESS)) return `0x${address.toString(16)}`;
  }
  if (handle.length >= 4) {
    const address = handle.readUInt32LE();
    if (address > MIN_WINDOW_ADDRESS) return `0x${address.toString(16)}`;
  }
  throw new Error('无法读取 Hyprland 窗口地址');
};

const runHyprctl = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('hyprctl', args, { timeout: HYPRCTL_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

type HyprlandClient = {
  address?: unknown;
  class?: unknown;
  pid?: unknown;
  title?: unknown;
};

/**
 * Wayland Electron windows expose a placeholder native handle (often 0x1),
 * while Hyprland identifies the real surface by its compositor address.
 * Resolve that address from the client list using the owning Electron PID.
 */
const getWaylandWindowAddress = async (win: HyprlandWindow) => {
  const output = await runHyprctl(['clients', '-j']);
  const clients: unknown = JSON.parse(output);
  if (!Array.isArray(clients)) throw new Error('Hyprland clients 返回格式无效');

  const title = win.getTitle();
  const candidates = clients.filter((client): client is HyprlandClient => {
    if (!client || typeof client !== 'object') return false;
    const entry = client as HyprlandClient;
    return (
      Number(entry.pid) === process.pid &&
      typeof entry.address === 'string' &&
      /^0x[\da-f]+$/i.test(entry.address)
    );
  });
  // Prefer EchoMusic's class when several Electron windows share this PID;
  // title matching remains the final discriminator for plugin windows.
  const appCandidates = candidates.filter((client) => client.class === 'echo-music');
  const scopedCandidates = appCandidates.length > 0 ? appCandidates : candidates;
  const matchingTitle = scopedCandidates.find((client) => client.title === title);
  const client = matchingTitle ?? scopedCandidates[0];
  if (typeof client?.address === 'string') return client.address;
  throw new Error('未找到当前 Hyprland 窗口');
};

const resolveWindowAddress = async (win: HyprlandWindow) => {
  try {
    return await getWaylandWindowAddress(win);
  } catch (waylandError) {
    try {
      return getWindowAddress(win);
    } catch {
      throw waylandError;
    }
  }
};

const applyWindowBlur = async (win: HyprlandWindow, enabled: boolean) => {
  const address = await resolveWindowAddress(win);
  const noBlur = enabled ? '0' : '1';
  // Hyprland 0.55+ exposes dynamic window properties through its Lua
  // dispatcher. Keep the legacy setprop form as a compatibility fallback for
  // older installations that still use the hyprlang command interface.
  const modern = [
    'dispatch',
    `hl.dsp.window.set_prop({ prop = "no_blur", value = "${noBlur}", window = "address:${address}" })`,
  ];
  try {
    await runHyprctl(modern);
    return;
  } catch (modernError) {
    try {
      await runHyprctl(['setprop', `address:${address}`, 'noblur', noBlur]);
    } catch {
      throw modernError;
    }
  }
};

/**
 * Synchronize the current window's compositor blur without changing the
 * user's Hyprland configuration. The latest requested state wins while a
 * hyprctl call is in flight.
 */
export function createHyprlandBackgroundController(win: HyprlandWindow) {
  let requested: boolean | null = null;
  let applied: boolean | null = null;
  let running = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const scheduleRetry = () => {
    if (retryTimer || win.isDestroyed()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, HYPRLAND_RETRY_MS);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (requested !== null) {
        const target = requested;
        requested = null;
        if (target === applied || win.isDestroyed()) continue;
        try {
          await applyWindowBlur(win, target);
          applied = target;
        } catch (error) {
          log.debug('[HyprlandBackground] Unable to update window blur:', error);
          // A Wayland surface may not appear in `hyprctl clients` until after
          // ready-to-show. Keep the requested state and retry without blocking
          // the main process; later changes replace this pending value.
          requested = target;
          scheduleRetry();
          break;
        }
      }
    } finally {
      running = false;
      if (requested !== null && !retryTimer) void flush();
    }
  };

  return {
    setBlurEnabled(enabled: boolean) {
      requested = enabled;
      void flush();
    },
  };
}
