import { ipcMain } from 'electron';
import type { MpvController } from '../mpv/controller';

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

  // Chromium 用 "default"，mpv 用 "auto"
  ipcMain.handle('mpv:set-audio-device', async (_e, deviceName: string) => {
    const mpvDevice = !deviceName || deviceName === 'default' ? 'auto' : deviceName;
    await ref.current?.setAudioDevice(mpvDevice);
  });

  ipcMain.handle('mpv:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcMain.handle('mpv:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcMain.handle('mpv:fade', async (_e, from: number, to: number, durationMs: number) => {
    const fromMpv = Math.pow(Math.max(0, from), 1 / 3) * 100;
    const toMpv = Math.pow(Math.max(0, to), 1 / 3) * 100;
    await ref.current?.fade(fromMpv, toMpv, durationMs);
  });

  ipcMain.handle('mpv:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  ipcMain.handle('mpv:get-state', () => {
    return ref.current?.currentState ?? null;
  });

  ipcMain.handle('mpv:available', () => {
    return ref.current?.available ?? false;
  });
}
