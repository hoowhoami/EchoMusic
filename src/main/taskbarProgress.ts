import type { BrowserWindow } from 'electron';
import { getMainWindow } from './window';
import log from './logger';
import type { PlayerController } from './player/controller';

/**
 * Windows 任务栏播放进度条。
 *
 * 常驻启用（无设置开关）：播放时在主窗口的任务栏按钮上显示绿色进度条，
 * 暂停时变为黄色暂停态（同浏览器下载），时长未知时显示不定进度条，
 * 无曲目或播放结束时移除进度条。仅 Windows 生效。
 */

// 节流：原生 time-update 事件高频触发，避免无意义的重复 native 调用
const THROTTLE_MS = 200;
// ratio 变化小于该阈值且 mode 未变时，视为无明显变化，可跳过应用
const RATIO_EPSILON = 0.001;

type ProgressMode = 'normal' | 'paused' | 'indeterminate' | 'none';

let time = 0;
let duration = 0;
let isPlaying = false;
let hasTrack = false;
let lastApplyAt = 0;
let lastRatio = -1;
let lastMode: ProgressMode = 'none';

const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

const resolveMode = (): ProgressMode => {
  if (!hasTrack) return 'none';
  if (duration <= 0) return 'indeterminate';
  return isPlaying ? 'normal' : 'paused';
};

const resolveRatio = (): number => {
  if (duration <= 0) return 0;
  return clampRatio(time / duration);
};

const getTaskbarWindow = (): BrowserWindow | null => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  return win;
};

const applyToTaskbar = (): void => {
  if (process.platform !== 'win32') return;
  const win = getTaskbarWindow();
  if (!win) return;

  const mode = resolveMode();
  const now = Date.now();

  if (mode === 'none') {
    // 无曲目或播放结束：移除进度条
    if (lastMode !== 'none') {
      try {
        win.setProgressBar(-1);
      } catch (err) {
        log.warn('[TaskbarProgress] Failed to remove progress bar:', err);
      }
      lastMode = 'none';
      lastRatio = -1;
      lastApplyAt = now;
    }
    return;
  }

  const ratio = mode === 'indeterminate' ? 1 : resolveRatio();
  const modeChanged = mode !== lastMode;
  const ratioChanged = Math.abs(ratio - lastRatio) >= RATIO_EPSILON;

  // mode 或 ratio 有明显变化时立即应用；否则按节流窗口跳过
  if (!modeChanged && !ratioChanged) {
    if (now - lastApplyAt < THROTTLE_MS) return;
  }

  try {
    const value = mode === 'indeterminate' ? 1 : ratio;
    win.setProgressBar(value, { mode });
    lastMode = mode;
    lastRatio = ratio;
    lastApplyAt = now;
  } catch (err) {
    log.warn('[TaskbarProgress] Failed to set progress bar:', err);
  }
};

const resetState = (): void => {
  time = 0;
  duration = 0;
  isPlaying = false;
  hasTrack = false;
  applyToTaskbar();
};

/**
 * 初始化并订阅播放进度事件（仅 Windows）。应随播放器启动调用。
 */
export const setupTaskbarProgress = (controller: PlayerController): void => {
  if (process.platform !== 'win32') return;

  controller.on('time-update', (payload: { time?: number }) => {
    if (typeof payload?.time === 'number') {
      time = payload.time;
      applyToTaskbar();
    }
  });

  controller.on('seeked', (seekTime: number) => {
    if (typeof seekTime === 'number') {
      time = seekTime;
      applyToTaskbar();
    }
  });

  controller.on('playback-restart', (payload: { time?: number }) => {
    if (typeof payload?.time === 'number') {
      time = payload.time;
      applyToTaskbar();
    }
  });

  controller.on('duration-change', (nextDuration: number) => {
    if (typeof nextDuration === 'number') {
      duration = nextDuration;
      applyToTaskbar();
    }
  });

  controller.on(
    'state-change',
    (payload: { timePos?: number; duration?: number; playing?: boolean; paused?: boolean }) => {
      if (typeof payload?.timePos === 'number') time = payload.timePos;
      if (typeof payload?.duration === 'number') duration = payload.duration;
      // 暂停/播放切换必须立即体现为颜色变化
      const nextIsPlaying = Boolean(payload?.playing);
      if (nextIsPlaying !== isPlaying) {
        isPlaying = nextIsPlaying;
        hasTrack = true;
        applyToTaskbar();
      } else {
        applyToTaskbar();
      }
    },
  );

  controller.on('file-loaded', () => {
    resetState();
  });

  controller.on('playback-end', () => {
    resetState();
  });

  log.info('[TaskbarProgress] Initialized');
};

/**
 * Explorer 重启（任务栏重建）后刷新一次当前进度。与 thumbar / 缩略图重建保持一致。
 */
export const refreshTaskbarProgress = (): void => {
  if (process.platform !== 'win32') return;
  // 任务栏重建会重置窗口状态，强制重新应用一次当前进度
  lastApplyAt = 0;
  lastMode = 'none';
  lastRatio = -1;
  applyToTaskbar();
};

/**
 * 销毁：移除任务栏进度条。随播放器销毁调用。
 */
export const destroyTaskbarProgress = (): void => {
  if (process.platform !== 'win32') return;
  const win = getTaskbarWindow();
  if (win) {
    try {
      win.setProgressBar(-1);
    } catch (err) {
      log.warn('[TaskbarProgress] Failed to remove progress bar on destroy:', err);
    }
  }
  time = 0;
  duration = 0;
  isPlaying = false;
  hasTrack = false;
  lastApplyAt = 0;
  lastRatio = -1;
  lastMode = 'none';
};
