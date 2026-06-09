import { ipcMain } from 'electron';
import type { PlayerController } from '../player/controller';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import { restartPlayer } from '../player';

/** 可变引用，允许播放引擎实例在注册后异步赋值 */
export type PlayerRef = { current: PlayerController | null };

export function registerPlayerIpc(ref: PlayerRef): void {
  ipcMain.handle('player:load', async (_e, url: string) => {
    await ref.current?.loadFile(url);
  });

  ipcMain.handle('player:load-mkv-track', async (_e, url: string, trackId: number) => {
    await ref.current?.loadMkvTrack(url, trackId);
  });

  ipcMain.handle('player:get-track-list', async () => {
    return (await ref.current?.getTrackList()) ?? [];
  });

  ipcMain.handle('player:play', async () => {
    await ref.current?.play();
  });

  ipcMain.handle('player:pause', async () => {
    await ref.current?.pause();
  });

  ipcMain.handle('player:stop', async () => {
    await ref.current?.stop();
  });

  ipcMain.handle('player:seek', async (_e, time: number) => {
    await ref.current?.seek(time);
  });

  // 播放引擎内部沿用 player 立方音量曲线，cbrt 补偿让体感和浏览器线性 audio.volume 一致
  ipcMain.handle('player:set-volume', async (_e, volume: number) => {
    const engineVolume = Math.pow(Math.max(0, volume), 1 / 3) * 100;
    await ref.current?.setVolume(engineVolume);
  });

  ipcMain.handle('player:set-speed', async (_e, speed: number) => {
    await ref.current?.setSpeed(speed);
  });

  ipcMain.handle('player:set-equalizer', async (_e, gains: number[]) => {
    await ref.current?.setEq(gains);
  });

  ipcMain.handle(
    'player:set-impulse-response',
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

  ipcMain.handle('player:get-audio-filter', async () => {
    return (await ref.current?.getAudioFilter()) ?? '';
  });

  // 直接透传后端设备名（如 wasapi/{id}、auto 等）
  ipcMain.handle('player:set-audio-device', async (_e, deviceName: string) => {
    await ref.current?.setAudioDevice(deviceName || 'auto');
  });

  ipcMain.handle('player:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcMain.handle('player:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcMain.handle('player:fade', async (_e, from: number, to: number, durationMs: number) => {
    try {
      const fromEngine = Math.pow(Math.max(0, from), 1 / 3) * 100;
      const toEngine = Math.pow(Math.max(0, to), 1 / 3) * 100;
      await ref.current?.fade(fromEngine, toEngine, durationMs);
    } catch {
      // 播放引擎不可用或 fade 被中断，静默忽略
    }
  });

  ipcMain.handle('player:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  // 复合操作：淡出 → 暂停 → 恢复音量，主进程内一次性完成
  ipcMain.handle('player:pause-with-fade', async (_e, savedVolume: number, durationMs: number) => {
    try {
      const savedEngine = Math.pow(Math.max(0, savedVolume), 1 / 3) * 100;
      await ref.current?.pauseWithFade(savedEngine, durationMs);
    } catch {
      // 淡出失败时直接暂停，确保暂停一定执行
      await ref.current?.pause().catch(() => {});
    }
  });

  // 复合操作：设置音量 0 → 播放 → 淡入，主进程内一次性完成
  ipcMain.handle('player:play-with-fade', async (_e, targetVolume: number, durationMs: number) => {
    try {
      const targetEngine = Math.pow(Math.max(0, targetVolume), 1 / 3) * 100;
      await ref.current?.playWithFade(targetEngine, durationMs);
    } catch {
      // 淡入失败时直接播放
      await ref.current?.play().catch(() => {});
    }
  });

  ipcMain.handle('player:get-state', () => {
    return ref.current?.currentState ?? null;
  });

  ipcMain.handle('player:available', () => {
    return ref.current?.available ?? false;
  });

  // 设置系统媒体面板显示的标题
  ipcMain.handle('player:set-media-title', async (_e, title: string) => {
    try {
      await ref.current?.command('set_property', 'force-media-title', title);
    } catch {
      // 忽略
    }
  });

  // 设置音频独占模式
  ipcMain.handle('player:set-exclusive', async (_e, exclusive: boolean) => {
    const player = ref.current;
    if (!player) {
      throw new Error('player backend is not available');
    }
    try {
      // Native player reopens the active output in-place.
      await player.command('set_property', 'audio-exclusive', exclusive ? 'yes' : 'no');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to set audio exclusive mode: ${message}`);
    }
  });

  // 重启播放引擎，供 Loading 页面重试使用
  ipcMain.handle('player:restart', async () => {
    const instance = await restartPlayer();
    ref.current = instance;
    return !!instance;
  });

  // 设置文件循环模式（单曲循环用）
  ipcMain.handle('player:set-loop-file', (_e, loop: boolean) => {
    ref.current?.setLoopFile(loop);
  });
}
