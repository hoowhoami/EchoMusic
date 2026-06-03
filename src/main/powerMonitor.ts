import { powerMonitor } from 'electron';
import type { BrowserWindow } from 'electron';
import type { MpvController } from './mpv/controller';
import { setSystemSuspended } from './window';
import log from './logger';

interface PowerMonitorContext {
  getMainWindow: () => BrowserWindow | null;
  getController: () => MpvController | null;
}

// 防抖：系统可能发出未配对的 suspend/resume（或重复事件），用此标志确保
// 「暂停并记录」只在真正进入挂起时发生一次，「重建并恢复」只在配对的唤醒时发生一次。
let isSuspended = false;
// 挂起前是否在播放，唤醒后据此决定是否自动恢复（暂停状态睡眠则保持暂停）。
let wasPlayingBeforeSuspend = false;

/**
 * 注册系统挂起/唤醒处理。
 *
 * macOS 盒盖/睡眠会拆除音频设备与 GPU surface，唤醒后 libmpv 的 CoreAudio
 * 输出会停在坏状态，表现为「假死」。这里在主进程（libmpv 所在处）做恢复，
 * 不依赖渲染进程是否已解冻：
 * - suspend：若在播放则暂停（让音频输出干净 idle）+ 释放 power-save-blocker
 * - resume：重建音频输出设备 + 按需恢复播放 + 通知渲染进程重新枚举设备
 *
 * 只处理 suspend/resume，不处理 lock-screen/unlock-screen——锁屏时用户可能
 * 仍在听歌，不应打断。跨平台注册（Windows/Linux 同样有唤醒后音频失活问题）。
 */
export function initPowerMonitor(ctx: PowerMonitorContext): void {
  const { getMainWindow, getController } = ctx;

  const handleSuspend = () => {
    if (isSuspended) return;
    isSuspended = true;

    const controller = getController();
    wasPlayingBeforeSuspend = Boolean(controller?.currentState.playing);
    log.info('[PowerMonitor] System suspend', { wasPlaying: wasPlayingBeforeSuspend });

    // 暂停播放，保留当前文件与进度，让音频输出干净进入 idle
    if (wasPlayingBeforeSuspend && controller) {
      controller.pause().catch((err) => {
        log.warn('[PowerMonitor] pause on suspend failed:', err);
      });
    }

    // 释放 power-save-blocker，避免唤醒后残留一个失效的 blocker
    try {
      setSystemSuspended(true);
    } catch (err) {
      log.warn('[PowerMonitor] setSystemSuspended(true) failed:', err);
    }

    try {
      getMainWindow()?.webContents.send('power:suspend');
    } catch {
      // 渲染进程不可用时忽略
    }
  };

  const handleResume = () => {
    if (!isSuspended) return;
    isSuspended = false;
    log.info('[PowerMonitor] System resume', { wasPlaying: wasPlayingBeforeSuspend });

    // 允许 power-save-blocker 按播放状态重新获取
    try {
      setSystemSuspended(false);
    } catch (err) {
      log.warn('[PowerMonitor] setSystemSuspended(false) failed:', err);
    }

    void recoverAudio(getController(), wasPlayingBeforeSuspend);

    // 通知渲染进程重新枚举输出设备（处理睡眠期间耳机被拔等设备变化）
    try {
      getMainWindow()?.webContents.send('power:resume');
    } catch {
      // 渲染进程不可用时忽略
    }
  };

  powerMonitor.on('suspend', handleSuspend);
  powerMonitor.on('resume', handleResume);
  log.info('[PowerMonitor] Registered suspend/resume handlers');
}

/**
 * 唤醒后重建 libmpv 音频输出并按需恢复播放。
 *
 * 重设 audio-device 属性会强制 libmpv 重新打开音频输出（AO），这是切换独占
 * 模式时验证过的惯用法（见 ipc/player.ts）。重建后若挂起前在播放则从原进度恢复。
 */
async function recoverAudio(controller: MpvController | null, shouldResume: boolean): Promise<void> {
  if (!controller) return;

  // 重建音频输出设备：读当前设备名并重设，强制 libmpv 重开 AO
  try {
    const currentDevice = String((await controller.command('get_property', 'audio-device')) ?? '');
    if (currentDevice) {
      await controller.command('set_property', 'audio-device', currentDevice);
      log.info('[PowerMonitor] Audio device reinitialized', { device: currentDevice });
    }
  } catch (err) {
    log.warn('[PowerMonitor] Audio device reinit failed:', err);
  }

  if (!shouldResume) return;

  // 恢复播放：play → mpv state-change → 渲染进程自动置 isPlaying 并重新获取 blocker
  try {
    await controller.play();
    log.info('[PowerMonitor] Playback resumed after wake');
  } catch (err) {
    log.warn('[PowerMonitor] Resume playback failed:', err);
  }
}
