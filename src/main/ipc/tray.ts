import { ipcRegistry } from './registry';
import { updateTrayPlaybackState } from '../tray';
import { updateThumbBarPlaybackState } from '../thumbbar';
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
      // 同步更新 Windows 缩略图工具栏的播放/暂停按钮
      if (typeof payload.isPlaying === 'boolean') {
        updateThumbBarPlaybackState(payload.isPlaying);
      }
    },
  );
};
