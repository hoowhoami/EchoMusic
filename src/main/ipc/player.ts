import { ipcRegistry } from './registry';
import type { PlayerController } from '../player/controller';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import { restartPlayer } from '../player';

export type PlayerRef = { current: PlayerController | null };

export function registerPlayerIpc(ref: PlayerRef): void {
  ipcRegistry.registerHandler('player:load', async (_e, url: string) => {
    await ref.current?.loadFile(url);
  });

  ipcRegistry.registerHandler('player:load-mkv-track', async (_e, url: string, trackId: number) => {
    await ref.current?.loadMkvTrack(url, trackId);
  });

  ipcRegistry.registerHandler(
    'player:prepare-next-source',
    async (_e, url: string, trackId?: number | null) => {
      return (await ref.current?.prepareNextSource(url, trackId)) ?? null;
    },
  );

  ipcRegistry.registerHandler('player:clear-prepared-next-source', async () => {
    ref.current?.clearPreparedNextSource();
  });

  ipcRegistry.registerHandler('player:get-track-list', async (_e, url?: string) => {
    return (await ref.current?.getTrackList(url)) ?? [];
  });

  ipcRegistry.registerHandler('player:play', async () => {
    await ref.current?.play();
  });

  ipcRegistry.registerHandler('player:pause', async () => {
    await ref.current?.pause();
  });

  ipcRegistry.registerHandler('player:stop', async () => {
    await ref.current?.stop();
  });

  ipcRegistry.registerHandler('player:seek', async (_e, time: number) => {
    await ref.current?.seek(time);
  });

  ipcRegistry.registerHandler('player:set-volume', async (_e, volume: number) => {
    await ref.current?.setVolume(Math.max(0, volume) * 100);
  });

  ipcRegistry.registerHandler('player:set-speed', async (_e, speed: number) => {
    await ref.current?.setSpeed(speed);
  });

  ipcRegistry.registerHandler('player:set-equalizer', async (_e, gains: number[]) => {
    await ref.current?.setEq(gains);
  });

  ipcRegistry.registerHandler(
    'player:set-impulse-response',
    async (_e, payload: string | ImpulseResponsePlaybackOptions) => {
      await ref.current?.setImpulseResponse(payload);
    },
  );

  ipcRegistry.registerHandler('player:set-impulse-response-mix', async (_e, mix: number) => {
    await ref.current?.setImpulseResponseMix(mix);
  });

  ipcRegistry.registerHandler('player:get-audio-filter', async () => {
    return (await ref.current?.getAudioFilter()) ?? '';
  });

  ipcRegistry.registerHandler('player:set-audio-device', async (_e, deviceName: string) => {
    await ref.current?.setAudioDevice(deviceName || 'auto');
  });

  ipcRegistry.registerHandler('player:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcRegistry.registerHandler('player:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcRegistry.registerHandler(
    'player:fade',
    async (_e, from: number, to: number, durationMs: number) => {
      await ref.current?.fade(Math.max(0, from) * 100, Math.max(0, to) * 100, durationMs);
    },
  );

  ipcRegistry.registerHandler('player:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  ipcRegistry.registerHandler(
    'player:pause-with-fade',
    async (_e, savedVolume: number, durationMs: number) => {
      await ref.current?.pauseWithFade(Math.max(0, savedVolume) * 100, durationMs);
    },
  );

  ipcRegistry.registerHandler(
    'player:play-with-fade',
    async (_e, targetVolume: number, durationMs: number) => {
      await ref.current?.playWithFade(Math.max(0, targetVolume) * 100, durationMs);
    },
  );

  ipcRegistry.registerHandler('player:get-state', () => {
    return ref.current?.currentState ?? null;
  });

  ipcRegistry.registerHandler('player:available', () => {
    return ref.current?.available ?? false;
  });

  ipcRegistry.registerHandler('player:restart', async () => {
    const instance = await restartPlayer();
    ref.current = instance;
    return !!instance;
  });

  ipcRegistry.registerHandler('player:set-exclusive', async (_e, exclusive: boolean) => {
    await ref.current?.setExclusive(Boolean(exclusive));
    return true;
  });

  ipcRegistry.registerHandler('player:set-media-title', async () => {
    // Native media session metadata is handled by media controls.
  });

  ipcRegistry.registerHandler('player:set-loop-file', async (_e, loop: boolean) => {
    await ref.current?.setLoopFile(loop);
  });

  ipcRegistry.registerHandler('player:set-stall-timeout', (_e, seconds: number) => {
    ref.current?.setStallTimeout(Number(seconds) || 0);
  });
}
