import type { PlayMode } from './playback';

export type TrayCommand = 'togglePlayback' | 'previousTrack' | 'nextTrack';

export type TrayPlaybackPayload = {
  isPlaying?: boolean;
  playMode?: PlayMode;
};
