import { ipcRegistry } from './registry';
import type { MpvController } from '../mpv/controller';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import { restartMpvPlayer } from '../mpv';

/** 可变引用，允许 mpv 实例在注册后异步赋值 */
export type MpvRef = { current: MpvController | null };

export function registerPlayerIpc(ref: MpvRef): void {
  ipcRegistry.registerHandler('mpv:load', async (_e, url: string) => {
    await ref.current?.loadFile(url);
  });

  ipcRegistry.registerHandler('mpv:load-mkv-track', async (_e, url: string, trackId: number) => {
    await ref.current?.loadMkvTrack(url, trackId);
  });

  ipcRegistry.registerHandler('mpv:get-track-list', async () => {
    return (await ref.current?.getTrackList()) ?? [];
  });

  ipcRegistry.registerHandler('mpv:play', async () => {
    await ref.current?.play();
  });

  ipcRegistry.registerHandler('mpv:pause', async () => {
    await ref.current?.pause();
  });

  ipcRegistry.registerHandler('mpv:stop', async () => {
    await ref.current?.stop();
  });

  ipcRegistry.registerHandler('mpv:seek', async (_e, time: number) => {
    await ref.current?.seek(time);
  });

  // mpv volume 使用立方缩放，cbrt 补偿让体感和浏览器线性 audio.volume 一致
  ipcRegistry.registerHandler('mpv:set-volume', async (_e, volume: number) => {
    const mpvVolume = Math.pow(Math.max(0, volume), 1 / 3) * 100;
    await ref.current?.setVolume(mpvVolume);
  });

  ipcRegistry.registerHandler('mpv:set-speed', async (_e, speed: number) => {
    await ref.current?.setSpeed(speed);
  });

  ipcRegistry.registerHandler('mpv:set-equalizer', async (_e, gains: number[]) => {
    await ref.current?.setEq(gains);
  });

  ipcRegistry.registerHandler(
    'mpv:set-impulse-response',
    async (_e, payload: string | ImpulseResponsePlaybackOptions) => {
      if (typeof payload === 'string') {
        await ref.current?.setImpulseResponse(payload || '');
        return;
      }
      await ref.current?.setImpulseResponse({
        filePath: String(payload?.filePath || ''),
        mix: Number(payload?.mix) || 0.4,
      });
    },
  );

  ipcRegistry.registerHandler('mpv:get-audio-filter', async () => {
    return (await ref.current?.getAudioFilter()) ?? '';
  });

  // 直接透传 mpv 设备名（如 wasapi/{id}、auto 等）
  ipcRegistry.registerHandler('mpv:set-audio-device', async (_e, deviceName: string) => {
    await ref.current?.setAudioDevice(deviceName || 'auto');
  });

  ipcRegistry.registerHandler('mpv:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcRegistry.registerHandler('mpv:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcRegistry.registerHandler(
    'mpv:fade',
    async (_e, from: number, to: number, durationMs: number) => {
      try {
        const fromMpv = Math.pow(Math.max(0, from), 1 / 3) * 100;
        const toMpv = Math.pow(Math.max(0, to), 1 / 3) * 100;
        await ref.current?.fade(fromMpv, toMpv, durationMs);
      } catch {
        // mpv 不可用或 fade 被中断，静默忽略
      }
    },
  );

  ipcRegistry.registerHandler('mpv:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  // 复合操作：淡出 → 暂停 → 恢复音量，主进程内一次性完成
  ipcRegistry.registerHandler(
    'mpv:pause-with-fade',
    async (_e, savedVolume: number, durationMs: number) => {
      try {
        const savedMpv = Math.pow(Math.max(0, savedVolume), 1 / 3) * 100;
        await ref.current?.pauseWithFade(savedMpv, durationMs);
      } catch {
        // 淡出失败时直接暂停，确保暂停一定执行
        await ref.current?.pause().catch(() => {});
      }
    },
  );

  // 复合操作：设置音量 0 → 播放 → 淡入，主进程内一次性完成
  ipcRegistry.registerHandler(
    'mpv:play-with-fade',
    async (_e, targetVolume: number, durationMs: number) => {
      try {
        const targetMpv = Math.pow(Math.max(0, targetVolume), 1 / 3) * 100;
        await ref.current?.playWithFade(targetMpv, durationMs);
      } catch {
        // 淡入失败时直接播放
        await ref.current?.play().catch(() => {});
      }
    },
  );

  ipcRegistry.registerHandler('mpv:get-state', () => {
    return ref.current?.currentState ?? null;
  });

  ipcRegistry.registerHandler('mpv:available', () => {
    return ref.current?.available ?? false;
  });

  // 设置系统媒体面板显示的标题
  ipcRegistry.registerHandler('mpv:set-media-title', async (_e, title: string) => {
    try {
      await ref.current?.command('set_property', 'force-media-title', title);
    } catch {
      // 忽略
    }
  });

  // 设置音频独占模式（需要重启 mpv 生效）
  ipcRegistry.registerHandler('mpv:set-exclusive', async (_e, exclusive: boolean) => {
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
  ipcRegistry.registerHandler('mpv:restart', async () => {
    const instance = await restartMpvPlayer();
    ref.current = instance;
    return !!instance;
  });

  // 设置文件循环模式（单曲循环用）
  ipcRegistry.registerHandler('mpv:set-loop-file', (_e, loop: boolean) => {
    ref.current?.setLoopFile(loop);
  });

  // 设置播放卡死检测阈值（秒，0=禁用），由渲染进程根据用户设置下发
  ipcRegistry.registerHandler('mpv:set-stall-timeout', (_e, seconds: number) => {
    ref.current?.setStallTimeout(Number(seconds) || 0);
  });
}
