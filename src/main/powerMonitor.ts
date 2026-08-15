import { powerMonitor } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PlayerController } from './player/controller';
import { setSystemSuspended } from './window';
import log from './logger';

interface PowerMonitorContext {
  getMainWindow: () => BrowserWindow | null;
  getController: () => PlayerController | null;
}

const WAKE_EVENT_DEDUPE_MS = 15_000;
const AUDIO_OUTPUT_RECOVERY_RETRY_DELAYS_MS = [0, 500, 1500] as const;

type WakeSource = 'resume' | 'unlock-screen';

let disposeActivePowerMonitor: (() => void) | null = null;

const formatLogError = (error: unknown): string => {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    const handleAbort = () => {
      if (pending.timer) clearTimeout(pending.timer);
      signal.removeEventListener('abort', handleAbort);
      resolve(false);
    };
    pending.timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve(true);
    }, delayMs);
    pending.timer.unref();
    signal.addEventListener('abort', handleAbort, { once: true });
  });

/**
 * 注册系统挂起/唤醒处理。
 *
 * macOS 盒盖/睡眠会拆除音频设备与 GPU surface，唤醒后音频输出
 * 可能停在坏状态，表现为「假死」。这里在主进程做恢复，
 * 不依赖渲染进程是否已解冻：
 * - suspend：若在播放则暂停（让音频输出干净 idle）+ 释放 power-save-blocker
 * - resume：重建音频输出设备 + 按需恢复播放 + 通知渲染进程重新枚举设备
 *
 * 主路径只处理 suspend/resume；Windows 的 unlock-screen 仅在已经确认收到
 * suspend、但 resume 遗失时兜底，普通锁屏解锁不会打断播放。
 * 跨平台注册（Windows/Linux 同样有唤醒后音频失活问题）。
 */
export function initPowerMonitor(ctx: PowerMonitorContext): () => void {
  disposeActivePowerMonitor?.();

  const { getMainWindow, getController } = ctx;
  let isSuspended = false;
  let wasPlayingBeforeSuspend = false;
  let lastWakeSignalAt = 0;
  let recoveryInFlight: Promise<boolean> | null = null;
  let pendingPairedWake: WakeSource | null = null;
  let disposed = false;
  const recoveryAbortController = new AbortController();

  const handleSuspend = () => {
    if (isSuspended) return;
    isSuspended = true;

    const controller = getController();
    wasPlayingBeforeSuspend = Boolean(controller?.currentState.playing);
    log.info('[PowerMonitor] System suspend', { wasPlaying: wasPlayingBeforeSuspend });

    // 暂停播放，保留当前文件与进度，让音频输出干净进入 idle
    if (wasPlayingBeforeSuspend && controller) {
      controller.pause().catch((err) => {
        log.warn('[PowerMonitor] pause on suspend failed:', formatLogError(err));
      });
    }

    // 释放 power-save-blocker，避免唤醒后残留一个失效的 blocker
    try {
      setSystemSuspended(true);
    } catch (err) {
      log.warn('[PowerMonitor] setSystemSuspended(true) failed:', formatLogError(err));
    }
  };

  const handleWake = (source: WakeSource) => {
    const now = Date.now();
    const pairedSuspend = isSuspended;
    if (recoveryInFlight !== null) {
      if (pairedSuspend) pendingPairedWake = source;
      else lastWakeSignalAt = now;
      log.debug('[PowerMonitor] Deferred wake signal while recovery is in progress', {
        source,
        pairedSuspend,
      });
      return;
    }
    if (!pairedSuspend && now - lastWakeSignalAt < WAKE_EVENT_DEDUPE_MS) {
      lastWakeSignalAt = now;
      log.debug('[PowerMonitor] Ignored duplicate unpaired wake signal', { source });
      return;
    }

    const controller = getController();
    const engineReportedPlaying = Boolean(controller?.currentState.playing);
    const shouldResume = pairedSuspend ? wasPlayingBeforeSuspend : engineReportedPlaying;
    isSuspended = false;
    wasPlayingBeforeSuspend = false;
    lastWakeSignalAt = now;
    log.info('[PowerMonitor] System resume', {
      source,
      pairedSuspend,
      wasPlaying: shouldResume,
      engineReportedPlaying,
    });

    // 允许 power-save-blocker 按播放状态重新获取
    try {
      setSystemSuspended(false);
    } catch (err) {
      log.warn('[PowerMonitor] setSystemSuspended(false) failed:', formatLogError(err));
    }

    const recovery = recoverAudio(
      controller,
      shouldResume,
      recoveryAbortController.signal,
      () => !isSuspended,
    );
    recoveryInFlight = recovery;
    const finishRecovery = (succeeded: boolean) => {
      if (recoveryInFlight === recovery) recoveryInFlight = null;
      if (!succeeded) lastWakeSignalAt = 0;
      if (disposed) return;

      // 主进程恢复完成后再让渲染进程重新枚举输出设备；若重建失败，设备列表
      // 变化处理会负责显示不可用状态或按用户设置暂停播放。
      try {
        getMainWindow()?.webContents.send('power:resume');
      } catch {
        // 渲染进程不可用时忽略
      }

      if (pendingPairedWake) {
        const pendingSource = pendingPairedWake;
        pendingPairedWake = null;
        handleWake(pendingSource);
      }
    };
    void recovery.then(finishRecovery, (error) => {
      log.error('[PowerMonitor] Unexpected audio recovery failure:', formatLogError(error));
      finishRecovery(false);
    });
  };

  const handleResume = () => {
    // Electron/Windows 偶尔只投递 resume。即使没有观察到 suspend，也要重建
    // 输出；此时以引擎自报的 playing 状态决定是否显式恢复播放。
    handleWake('resume');
  };

  const handleUnlockScreen = () => {
    if (process.platform !== 'win32') return;
    if (!isSuspended) {
      const msSinceLastWakeSignal = lastWakeSignalAt > 0 ? Date.now() - lastWakeSignalAt : null;
      log.info('[PowerMonitor] Windows unlock observed without pending suspend; recovery skipped', {
        msSinceLastWakeSignal,
      });
      return;
    }

    log.info('[PowerMonitor] Windows unlock fallback handling a pending suspend');
    handleWake('unlock-screen');
  };

  powerMonitor.on('suspend', handleSuspend);
  powerMonitor.on('resume', handleResume);
  if (process.platform === 'win32') {
    powerMonitor.on('unlock-screen', handleUnlockScreen);
  }
  log.info('[PowerMonitor] Registered suspend/resume handlers');

  const dispose = () => {
    disposed = true;
    pendingPairedWake = null;
    recoveryAbortController.abort();
    powerMonitor.removeListener('suspend', handleSuspend);
    powerMonitor.removeListener('resume', handleResume);
    if (process.platform === 'win32') {
      powerMonitor.removeListener('unlock-screen', handleUnlockScreen);
    }
    if (disposeActivePowerMonitor === dispose) disposeActivePowerMonitor = null;
  };
  disposeActivePowerMonitor = dispose;
  return dispose;
}

/**
 * 唤醒后重建音频输出并按需恢复播放。
 */
async function recoverAudio(
  controller: PlayerController | null,
  shouldResume: boolean,
  signal: AbortSignal,
  canResume: () => boolean,
): Promise<boolean> {
  if (!controller?.available) {
    log.warn('[PowerMonitor] Audio recovery skipped: player controller is unavailable');
    return false;
  }

  const state = controller.currentState;
  const configuredDevice = state.audioDevice;
  const currentDevice =
    typeof configuredDevice === 'string' && configuredDevice.length > 0 ? configuredDevice : 'auto';
  const exclusive = Boolean(state.exclusiveOutput);
  let outputRecovered = false;
  let lastError = 'unknown output initialization error';
  const maxAttempts = AUDIO_OUTPUT_RECOVERY_RETRY_DELAYS_MS.length;

  for (const [index, delayMs] of AUDIO_OUTPUT_RECOVERY_RETRY_DELAYS_MS.entries()) {
    if (signal.aborted) return false;

    const attempt = index + 1;
    if (delayMs > 0 && !(await waitForRetry(delayMs, signal))) return false;

    try {
      // Windows Audio Service 和蓝牙/USB 设备可能晚于系统 resume 事件恢复就绪。
      // 对同一设备重新应用配置会强制原生引擎创建全新的音频输出流。
      await controller.setAudioOutput(currentDevice, exclusive);
      if (signal.aborted) return false;
      outputRecovered = true;
      log.info('[PowerMonitor] Audio output reinitialized', {
        device: currentDevice,
        exclusive,
        attempt,
        maxAttempts,
      });
      break;
    } catch (err) {
      if (signal.aborted) return false;
      lastError = formatLogError(err);
      log.warn('[PowerMonitor] Audio device reinit failed:', {
        attempt,
        maxAttempts,
        error: lastError,
      });
    }
  }

  if (signal.aborted) return false;

  if (!outputRecovered) {
    log.error('[PowerMonitor] Audio output recovery exhausted; skipping playback resume', {
      device: currentDevice,
      exclusive,
      maxAttempts,
      error: lastError,
    });
    return false;
  }

  if (!shouldResume) return true;
  if (!canResume()) {
    log.info('[PowerMonitor] Playback resume deferred because another suspend is pending');
    return true;
  }

  // 恢复播放：play → state-change → 渲染进程自动置 isPlaying 并重新获取 blocker
  try {
    await controller.play();
    log.info('[PowerMonitor] Playback resumed after wake');
    return true;
  } catch (err) {
    log.warn('[PowerMonitor] Resume playback failed:', formatLogError(err));
    return false;
  }
}
