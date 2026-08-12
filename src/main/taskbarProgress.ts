import type { BrowserWindow } from 'electron';
import { getMainWindow } from './window';
import log from './logger';
import { getMainAppSettings } from './storage/settings';
import type { PlayerController } from './player/controller';

/**
 * Windows 任务栏播放进度条。
 *
 * 播放时在主窗口的任务栏按钮上显示进度条，暂停时变为黄色暂停态，
 * 时长未知时显示不定进度条，无曲目或播放结束时移除进度条。仅 Windows 生效。
 * 开关由设置「外观-任务栏播放进度条」控制（默认开启）。
 */

// 节流：原生 time-update 事件高频触发，避免无意义的重复 native 调用
const THROTTLE_MS = 200;
// ratio 变化小于该阈值且 mode 未变时，视为无明显变化，可跳过应用
const RATIO_EPSILON = 0.001;
// Windows 上进度值为 0 的暂停条可能被渲染为无状态，暂停时强制保底一段可见进度
const PAUSED_MIN_VALUE = 0.01;

type ProgressMode = 'normal' | 'paused' | 'indeterminate' | 'none';

let enabled = true;
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

  // 开关关闭时移除进度条
  if (!enabled) {
    if (lastMode !== 'none') {
      try {
        win.setProgressBar(-1);
      } catch (err) {
        log.warn('[TaskbarProgress] Failed to remove progress bar:', err);
      }
      lastMode = 'none';
      lastRatio = -1;
      lastApplyAt = Date.now();
    }
    return;
  }

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
  // 暂停态保底可见进度，避免 Windows 将 0 值暂停条渲染为空状态
  const value =
    mode === 'paused' ? Math.max(PAUSED_MIN_VALUE, ratio) : mode === 'indeterminate' ? 1 : ratio;
  const modeChanged = mode !== lastMode;
  const ratioChanged = Math.abs(value - lastRatio) >= RATIO_EPSILON;

  // mode 或 ratio 有明显变化时立即应用；否则按节流窗口跳过
  if (!modeChanged && !ratioChanged) {
    if (now - lastApplyAt < THROTTLE_MS) return;
  }

  try {
    win.setProgressBar(value, { mode });
    lastMode = mode;
    lastRatio = value;
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
  enabled = Boolean(getMainAppSettings().taskbarProgress);
  log.info('[TaskbarProgress] initialized', { enabled });

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
    (payload: { duration?: number; playing?: boolean; paused?: boolean }) => {
      // 注意：state-change 的 timePos 只在加载/seek 时更新，播放中不随播放推进，
      // 若用它覆盖 time 会导致暂停时进度条回到歌曲开头或上次 seek 位置。
      // time 只由 time-update / seeked / playback-restart 维护实时位置。
      if (typeof payload?.duration === 'number') duration = payload.duration;
      // 暂停/播放切换必须立即体现为颜色变化
      const nextIsPlaying = Boolean(payload?.playing);
      if (nextIsPlaying !== isPlaying) {
        isPlaying = nextIsPlaying;
        if (nextIsPlaying) {
          hasTrack = true;
        }
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
};

/**
 * 设置任务栏进度条开关。关闭时立即移除进度条，开启时按当前播放状态重放。
 */
export const setTaskbarProgressEnabled = (next: boolean): void => {
  if (process.platform !== 'win32') return;
  if (enabled === Boolean(next)) return;
  enabled = Boolean(next);
  applyToTaskbar();
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
