import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayerController } from '../src/main/player/controller.ts';
import { setPlayerAudioEffect } from '../src/main/player/audioEffectCommand.ts';

test('audio-effect commands fail when the player controller is unavailable', async () => {
  await assert.rejects(setPlayerAudioEffect(null, null), /播放器未初始化/u);

  const calls: unknown[] = [];
  const controller = {
    setAudioEffect: async (options: unknown) => {
      calls.push(options);
    },
  } as PlayerController;
  const options = { providerPath: '/provider.dylib', providerMode: 'speaker' } as const;
  await setPlayerAudioEffect(controller, options);
  assert.deepEqual(calls, [options]);
});
