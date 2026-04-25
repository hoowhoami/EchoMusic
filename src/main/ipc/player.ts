import { ipcMain } from 'electron';
import type { MpvController } from '../mpv/controller';

export function registerPlayerIpc(mpv: MpvController | null): void {
  // mpv 不可用时静默忽略命令，不抛异常，避免触发全局错误页面
  ipcMain.handle('mpv:load', async (_e, url: string) => {
    await mpv?.loadFile(url);
  });

  ipcMain.handle('mpv:load-mkv-track', async (_e, url: string, trackId: number) => {
    await mpv?.loadMkvTrack(url, trackId);
  });

  ipcMain.handle('mpv:get-track-list', async () => {
    return (await mpv?.getTrackList()) ?? [];
  });

  ipcMain.handle('mpv:play', async () => {
    await mpv?.play();
  });

  ipcMain.handle('mpv:pause', async () => {
    await mpv?.pause();
  });

  ipcMain.handle('mpv:stop', async () => {
    await mpv?.stop();
  });

  ipcMain.handle('mpv:seek', async (_e, time: number) => {
    await mpv?.seek(time);
  });

  // mpv volume 使用立方缩放，cbrt 补偿让体感和浏览器线性 audio.volume 一致
  ipcMain.handle('mpv:set-volume', async (_e, volume: number) => {
    const mpvVolume = Math.pow(Math.max(0, volume), 1 / 3) * 100;
    await mpv?.setVolume(mpvVolume);
  });

  ipcMain.handle('mpv:set-speed', async (_e, speed: number) => {
    await mpv?.setSpeed(speed);
  });

  ipcMain.handle('mpv:set-audio-device', async (_e, deviceName: string) => {
    // Chromium 用 "default"，mpv 用 "auto"
    const mpvDevice = !deviceName || deviceName === 'default' ? 'auto' : deviceName;
    await mpv?.setAudioDevice(mpvDevice);
  });

  ipcMain.handle('mpv:get-audio-devices', async () => {
    return (await mpv?.getAudioDevices()) ?? [];
  });

  ipcMain.handle('mpv:set-normalization-gain', async (_e, gainDb: number) => {
    await mpv?.applyNormalizationGain(gainDb);
  });

  ipcMain.handle('mpv:fade', async (_e, from: number, to: number, durationMs: number) => {
    const fromMpv = Math.pow(Math.max(0, from), 1 / 3) * 100;
    const toMpv = Math.pow(Math.max(0, to), 1 / 3) * 100;
    await mpv?.fade(fromMpv, toMpv, durationMs);
  });

  ipcMain.handle('mpv:cancel-fade', () => {
    mpv?.cancelFade();
  });

  ipcMain.handle('mpv:get-state', () => {
    return mpv?.currentState ?? null;
  });

  ipcMain.handle('mpv:available', () => {
    return mpv?.available ?? false;
  });
}
