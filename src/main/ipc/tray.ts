import { ipcMain } from 'electron';
import { updateTrayPlaybackState } from '../tray';

type PlayMode = 'list' | 'random' | 'single';

interface TrayPlaybackPayload {
  isPlaying?: boolean;
  playMode?: PlayMode;
}

export const registerTrayHandlers = () => {
  ipcMain.on('tray:sync-playback', (_event, payload: TrayPlaybackPayload | null) => {
    if (!payload) return;
    updateTrayPlaybackState({
      ...(typeof payload.isPlaying === 'boolean' ? { isPlaying: payload.isPlaying } : {}),
      ...(payload.playMode ? { playMode: payload.playMode } : {}),
    });
  });
};
