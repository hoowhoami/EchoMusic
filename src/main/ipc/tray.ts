import { ipcRegistry } from './registry';
import { updateTrayPlaybackState } from '../tray';
import type { TrayPlaybackPayload } from '../../shared/tray';

export const registerTrayHandlers = () => {
  ipcRegistry.registerListener(
    'tray:sync-playback',
    (_event, payload: TrayPlaybackPayload | null) => {
      if (!payload) return;
      updateTrayPlaybackState({
        ...(typeof payload.isPlaying === 'boolean' ? { isPlaying: payload.isPlaying } : {}),
        ...(payload.playMode ? { playMode: payload.playMode } : {}),
        ...(typeof payload.volume === 'number' ? { volume: payload.volume } : {}),
      });
    },
  );
};
