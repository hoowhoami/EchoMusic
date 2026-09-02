import type { AudioEffectPlaybackOptions } from '../../shared/audio';
import type { PlayerController } from './controller';

export const setPlayerAudioEffect = async (
  controller: PlayerController | null | undefined,
  options: AudioEffectPlaybackOptions | null,
): Promise<void> => {
  if (!controller) throw new Error('播放器未初始化');
  await controller.setAudioEffect(options);
};
