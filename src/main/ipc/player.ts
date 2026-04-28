import { ipcMain } from 'electron';
import type { MpvController } from '../mpv/controller';
import { restartMpvPlayer } from '../mpv';

/** 可变引用，允许 mpv 实例在注册后异步赋值 */
export type MpvRef = { current: MpvController | null };

export function registerPlayerIpc(ref: MpvRef): void {
  ipcMain.handle('mpv:load', async (_e, url: string) => {
    await ref.current?.loadFile(url);
  });

  ipcMain.handle('mpv:load-mkv-track', async (_e, url: string, trackId: number) => {
    await ref.current?.loadMkvTrack(url, trackId);
  });

  ipcMain.handle('mpv:get-track-list', async () => {
    return (await ref.current?.getTrackList()) ?? [];
  });

  ipcMain.handle('mpv:play', async () => {
    await ref.current?.play();
  });

  ipcMain.handle('mpv:pause', async () => {
    await ref.current?.pause();
  });

  ipcMain.handle('mpv:stop', async () => {
    await ref.current?.stop();
  });

  ipcMain.handle('mpv:seek', async (_e, time: number) => {
    await ref.current?.seek(time);
  });

  // mpv volume 使用立方缩放，cbrt 补偿让体感和浏览器线性 audio.volume 一致
  ipcMain.handle('mpv:set-volume', async (_e, volume: number) => {
    const mpvVolume = Math.pow(Math.max(0, volume), 1 / 3) * 100;
    await ref.current?.setVolume(mpvVolume);
  });

  ipcMain.handle('mpv:set-speed', async (_e, speed: number) => {
    await ref.current?.setSpeed(speed);
  });

  // 直接透传 mpv 设备名（如 wasapi/{id}、auto 等）
  ipcMain.handle('mpv:set-audio-device', async (_e, deviceName: string) => {
    await ref.current?.setAudioDevice(deviceName || 'auto');
  });

  ipcMain.handle('mpv:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcMain.handle('mpv:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcMain.handle('mpv:fade', async (_e, from: number, to: number, durationMs: number) => {
    try {
      const fromMpv = Math.pow(Math.max(0, from), 1 / 3) * 100;
      const toMpv = Math.pow(Math.max(0, to), 1 / 3) * 100;
      await ref.current?.fade(fromMpv, toMpv, durationMs);
    } catch {
      // mpv 不可用或 fade 被中断，静默忽略
    }
  });

  ipcMain.handle('mpv:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  // 复合操作：淡出 → 暂停 → 恢复音量，主进程内一次性完成
  ipcMain.handle('mpv:pause-with-fade', async (_e, savedVolume: number, durationMs: number) => {
    try {
      const savedMpv = Math.pow(Math.max(0, savedVolume), 1 / 3) * 100;
      await ref.current?.pauseWithFade(savedMpv, durationMs);
    } catch {
      // 淡出失败时直接暂停，确保暂停一定执行
      await ref.current?.pause().catch(() => {});
    }
  });

  // 复合操作：设置音量 0 → 播放 → 淡入，主进程内一次性完成
  ipcMain.handle('mpv:play-with-fade', async (_e, targetVolume: number, durationMs: number) => {
    try {
      const targetMpv = Math.pow(Math.max(0, targetVolume), 1 / 3) * 100;
      await ref.current?.playWithFade(targetMpv, durationMs);
    } catch {
      // 淡入失败时直接播放
      await ref.current?.play().catch(() => {});
    }
  });

  ipcMain.handle('mpv:get-state', () => {
    return ref.current?.currentState ?? null;
  });

  ipcMain.handle('mpv:available', () => {
    return ref.current?.available ?? false;
  });

  // 设置系统媒体面板显示的标题
  ipcMain.handle('mpv:set-media-title', async (_e, title: string) => {
    try {
      await ref.current?.command('set_property', 'force-media-title', title);
    } catch {
      // 忽略
    }
  });

  // 设置音频独占模式（需要重启 mpv 生效）
  ipcMain.handle('mpv:set-exclusive', async (_e, exclusive: boolean) => {
    try {
      // 先停止当前播放
      await ref.current?.stop().catch(() => {});
      // 设置独占属性
      await ref.current?.command('set_property', 'audio-exclusive', exclusive ? 'yes' : 'no');
      // 强制 mpv 重新初始化音频输出，避免切换后杂音
      try {
        const currentDevice = await ref.current?.command('get_property', 'audio-device');
        if (currentDevice) {
          await ref.current?.command('set_property', 'audio-device', currentDevice);
        }
      } catch {
        // 忽略
      }
      return true;
    } catch {
      return false;
    }
  });

  // 重启 mpv 播放引擎，供 Loading 页面重试使用
  ipcMain.handle('mpv:restart', async () => {
    const instance = await restartMpvPlayer();
    ref.current = instance;
    return !!instance;
  });
}
