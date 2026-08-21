import { ipcRegistry } from './registry';
import type { PlayerController } from '../player/controller';
import type { AudioEffectPlaybackOptions } from '../../shared/audio';
import type {
  PlayerAudioGraphParameterPatch,
  PlayerAudioGraphPlanPatch,
} from '../../shared/player-audio-graph';
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
    'player:begin-next-source-preparation',
    async () => ref.current?.beginNextSourcePreparation() ?? null,
  );

  ipcRegistry.registerHandler(
    'player:set-audio-effect',
    async (_e, options: AudioEffectPlaybackOptions | null) => {
      await ref.current?.setAudioEffect(options);
    },
  );

  ipcRegistry.registerHandler(
    'player:cancel-next-source-preparation',
    async (_e, requestId: number) => ref.current?.cancelNextSourcePreparation(requestId) ?? false,
  );

  ipcRegistry.registerHandler(
    'player:prepare-next-source',
    async (
      _e,
      url: string,
      requestId: number,
      trackId?: number | null,
      normalizationGainDb?: number,
    ) => {
      return (
        (await ref.current?.prepareNextSource(url, requestId, trackId, normalizationGainDb)) ?? null
      );
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
    await ref.current?.setVolume(Math.max(0, Math.min(100, volume)));
  });

  ipcRegistry.registerHandler('player:set-speed', async (_e, speed: number) => {
    await ref.current?.setSpeed(speed);
  });

  ipcRegistry.registerHandler('player:set-equalizer', async (_e, gains: number[]) => {
    await ref.current?.setEq(gains);
  });

  ipcRegistry.registerHandler('player:get-audio-graph', async () => {
    return (await ref.current?.getAudioGraph()) ?? null;
  });

  ipcRegistry.registerHandler(
    'player:set-audio-graph-parameter',
    async (_e, patch: PlayerAudioGraphParameterPatch) => {
      await ref.current?.setAudioGraphParameter(patch);
    },
  );

  ipcRegistry.registerHandler(
    'player:set-audio-graph-plan',
    async (_e, plan: PlayerAudioGraphPlanPatch) => {
      await ref.current?.setAudioGraphPlan(plan);
    },
  );

  ipcRegistry.registerHandler(
    'player:set-audio-output',
    async (_e, deviceName: string, exclusive: boolean) => {
      await ref.current?.setAudioOutput(deviceName || 'auto', Boolean(exclusive));
    },
  );

  ipcRegistry.registerHandler('player:get-audio-devices', async () => {
    return (await ref.current?.getAudioDevices()) ?? [];
  });

  ipcRegistry.registerHandler('player:set-normalization-gain', async (_e, gainDb: number) => {
    await ref.current?.applyNormalizationGain(gainDb);
  });

  ipcRegistry.registerHandler(
    'player:fade',
    async (_e, from: number, to: number, durationMs: number) => {
      await ref.current?.fade(from, to, durationMs);
    },
  );

  ipcRegistry.registerHandler('player:cancel-fade', () => {
    ref.current?.cancelFade();
  });

  ipcRegistry.registerHandler(
    'player:pause-with-fade',
    async (_e, savedVolume: number, durationMs: number) => {
      await ref.current?.pauseWithFade(savedVolume, durationMs);
    },
  );

  ipcRegistry.registerHandler(
    'player:play-with-fade',
    async (_e, targetVolume: number, durationMs: number) => {
      await ref.current?.playWithFade(targetVolume, durationMs);
    },
  );

  ipcRegistry.registerHandler('player:get-state', () => {
    return ref.current?.getState() ?? null;
  });

  ipcRegistry.registerHandler('player:available', () => {
    return ref.current?.available ?? false;
  });

  ipcRegistry.registerHandler('player:restart', async () => {
    const instance = await restartPlayer();
    ref.current = instance;
    return !!instance;
  });

  ipcRegistry.registerHandler(
    'player:set-pause-on-device-disconnect',
    async (_e, enabled: boolean) => {
      await ref.current?.setPauseOnDeviceDisconnect(Boolean(enabled));
    },
  );

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
